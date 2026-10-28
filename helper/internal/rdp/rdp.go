// Package rdp holds what the proxy reads and writes of RDP itself: RDCleanPath's request and response (the messages
// IronRDP's web client exchanges with a proxy), the pre-connection PDU, the parts of the X.224 connection request and
// confirm the proxy looks at, the Client Info PDU's autologon flag, and the framing of what the server sends.
// Ported from the plugin's former src/rdcleanpath.ts; the comments there are kept where they say why.
package rdp

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"unicode/utf16"
)

// Version1 is RDCleanPath's version.
const Version1 = 3390

const generalError = 1

// ---- minimal DER ---------------------------------------------------------------------------------

func derLength(n int) []byte {
	if n < 0x80 {
		return []byte{byte(n)}
	}
	var b []byte
	for v := n; v > 0; v >>= 8 {
		b = append([]byte{byte(v)}, b...)
	}
	return append([]byte{0x80 | byte(len(b))}, b...)
}

func tlv(tag byte, content []byte) []byte {
	out := append([]byte{tag}, derLength(len(content))...)
	return append(out, content...)
}

func derInteger(n int) []byte {
	var b []byte
	for v := n; v > 0; v >>= 8 {
		b = append([]byte{byte(v)}, b...)
	}
	if len(b) == 0 {
		b = []byte{0}
	}
	if b[0]&0x80 != 0 {
		b = append([]byte{0}, b...)
	}
	return tlv(0x02, b)
}

func seq(items ...[]byte) []byte { return tlv(0x30, bytes.Join(items, nil)) }

func explicit(n byte, inner []byte) []byte { return tlv(0xa0|n, inner) }

// TLV is a DER element's tag, and where its content starts and ends.
type TLV struct {
	Tag        byte
	Start, End int
}

// beyond is a length past every limit the helper has: a longer one claimed is taken for this (on 32-bit platforms an
// int holds no more than 2 GiB).
const beyond = 1 << 30

// ReadTLV reads the element at off, or false where its header isn't all there. Its end can lie past buf's: what is
// there may be the start of a longer message.
func ReadTLV(buf []byte, off int) (TLV, bool) {
	if len(buf) < off+2 {
		return TLV{}, false
	}
	length := uint64(buf[off+1])
	p := off + 2
	if length&0x80 != 0 {
		k := int(length & 0x7f)
		if len(buf) < p+k {
			return TLV{}, false
		}
		length = 0
		for i := 0; i < k; i++ {
			if length < beyond {
				length = length<<8 | uint64(buf[p])
			}
			p++
		}
	}
	return TLV{Tag: buf[off], Start: p, End: p + int(min(length, beyond))}, true
}

// Request is an RDCleanPath request.
type Request struct {
	Version     int
	HasVersion  bool
	Destination string
	ProxyAuth   string
	// The pre-connection blob's text (a Hyper-V VM's id, for one): sent to the server before anything else.
	PCB string
	// The X.224 connection request. Absent for a Hyper-V VM's console: there TLS comes first, and the client does
	// X.224 after CredSSP.
	X224 []byte
}

var errMalformed = errors.New("malformed request")

// text is UTF-8 as JavaScript decodes it: what isn't valid is U+FFFD.
func text(b []byte) string { return strings.ToValidUTF8(string(b), "\uFFFD") }

// DecodeRequest reads a whole request (buf holds exactly its SEQUENCE).
func DecodeRequest(buf []byte) (*Request, error) {
	outer, ok := ReadTLV(buf, 0)
	if !ok || outer.Tag != 0x30 || outer.End > len(buf) {
		return nil, errors.New("RDCleanPath: not a SEQUENCE")
	}
	req := &Request{}
	for p := outer.Start; p < outer.End; {
		field, ok := ReadTLV(buf, p)
		if !ok || field.End > outer.End {
			return nil, errMalformed
		}
		inner, ok := ReadTLV(buf, field.Start)
		if !ok || inner.End > field.End {
			return nil, errMalformed
		}
		value := buf[inner.Start:inner.End]
		switch field.Tag & 0x1f {
		case 0:
			if len(value) == 0 || len(value) > 6 {
				return nil, errMalformed
			}
			v := 0
			for _, b := range value {
				v = v<<8 | int(b)
			}
			req.Version, req.HasVersion = v, true
		case 2:
			req.Destination = text(value)
		case 3:
			req.ProxyAuth = text(value)
		case 5:
			req.PCB = text(value)
		case 6:
			req.X224 = bytes.Clone(value)
		}
		p = field.End
	}
	return req, nil
}

// EncodeResponse is the response: the server's X.224 confirm (none for a Hyper-V VM's console), its certificate
// chain, its address.
func EncodeResponse(x224 []byte, chain [][]byte, serverAddr string) []byte {
	certs := make([][]byte, len(chain))
	for i, c := range chain {
		certs[i] = tlv(0x04, c)
	}
	items := [][]byte{explicit(0, derInteger(Version1))}
	if x224 != nil {
		items = append(items, explicit(6, tlv(0x04, x224)))
	}
	items = append(items, explicit(7, seq(certs...)), explicit(9, tlv(0x0c, []byte(serverAddr))))
	return seq(items...)
}

// EncodeError is RDCleanPath's general error.
func EncodeError() []byte {
	return seq(explicit(0, derInteger(Version1)), explicit(1, seq(explicit(0, derInteger(generalError)))))
}

// PreconnectionPDU is a version 2 pre-connection PDU ([MS-RDPEPS] 2.2.1.2) carrying text: what a client sends first
// to a server that routes by it, as Hyper-V does to a VM's console by the VM's id.
func PreconnectionPDU(text string) []byte {
	units := utf16.Encode([]rune(text + "\x00"))
	pdu := make([]byte, 18+2*len(units))
	binary.LittleEndian.PutUint32(pdu[0:], uint32(len(pdu))) // cbSize
	binary.LittleEndian.PutUint32(pdu[4:], 0)                // Flags
	binary.LittleEndian.PutUint32(pdu[8:], 2)                // Version
	binary.LittleEndian.PutUint32(pdu[12:], 0)               // Id
	binary.LittleEndian.PutUint16(pdu[16:], uint16(len(units)))
	for i, u := range units {
		binary.LittleEndian.PutUint16(pdu[18+2*i:], u)
	}
	return pdu
}

// selectedProtocol's flags in the server's negotiation response (RDP_NEG_RSP).
const (
	protocolHybrid   = 0x02
	protocolHybridEx = 0x08
)

// SelectedProtocol is the security protocol the server chose (RDP_NEG_RSP's selectedProtocol), or 0 when its answer
// to the connection request has no negotiation response. Tested by its flags, as IronRDP does, so that the proxy and
// the client never read the same answer differently.
func SelectedProtocol(x224 []byte) uint32 {
	if len(x224) >= 19 && x224[11] == 0x02 {
		return binary.LittleEndian.Uint32(x224[15:])
	}
	return 0
}

// OffersNLA says whether the server's answer to the connection request chose Network Level Authentication (CredSSP:
// HYBRID or HYBRID_EX). Without it (plain TLS, as xrdp does), the client sends the password itself in its Client Info
// PDU: encrypted on the way, readable to whatever answered.
func OffersNLA(x224 []byte) bool {
	return SelectedProtocol(x224)&(protocolHybrid|protocolHybridEx) != 0
}

// EarlyUserAuthorization says whether an Early User Authorization Result follows CredSSP: the server chose
// HYBRID_EX. IronRDP expects one whenever that flag is set, alone or not.
func EarlyUserAuthorization(x224 []byte) bool {
	return SelectedProtocol(x224)&protocolHybridEx != 0
}

// Cookie is the routing cookie that names the user (see WithoutUserCookie).
var Cookie = []byte("Cookie: mstshash=")

// WithoutUserCookie is the client's X.224 connection request without its routing cookie, `Cookie: mstshash=<user
// name>`, which IronRDP fills in with the user name. It goes before TLS, in the clear, and before the certificate
// check and the stop at a server without Network Level Authentication: the account's name would reach whoever watches
// the way there, and servers the proxy then refuses. The cookie is optional, and what it is for (routing by user name
// in a load balancer) the plugin doesn't take part in. A request that isn't a connection request with such a cookie
// comes back as it is; so does a broker's routing token (`Cookie: msts=`), which names no user. The proxy sends none
// that still has the cookie.
func WithoutUserCookie(request []byte) []byte {
	// TPKT (4: version 3, 0, length), then X.224: length indicator, the CR code, DST-REF, SRC-REF and class (6), then
	// the cookie, the negotiation request and the rest.
	if len(request) < 11+len(Cookie) || request[0] != 3 || int(binary.BigEndian.Uint16(request[2:])) != len(request) ||
		request[5]&0xf0 != 0xe0 || 5+int(request[4]) != len(request) || !bytes.Equal(request[11:11+len(Cookie)], Cookie) {
		return request
	}
	end := bytes.Index(request[11+len(Cookie):], []byte("\r\n"))
	if end < 0 {
		return request
	}
	end += 11 + len(Cookie)
	cut := end + 2 - 11
	out := append(bytes.Clone(request[:11]), request[end+2:]...)
	binary.BigEndian.PutUint16(out[2:], uint16(len(request)-cut))
	out[4] = request[4] - byte(cut)
	return out
}

// NoTLS is the server's answer to the client's security negotiation when it rules out TLS (which IronRDP and
// RDCleanPath need): a server with RDP's standard security only (xrdp with security_layer=rdp, say) answers without a
// negotiation response, or with PROTOCOL_RDP, or refuses the negotiation. "" when TLS can go ahead.
func NoTLS(x224 []byte) string {
	// TPKT (4), X.224 Connection Confirm (7), then RDP_NEG_RSP or RDP_NEG_FAILURE (8): type, flags, length, value.
	const standardOnly = "the RDP server only offers standard RDP security, without TLS (for xrdp: set security_layer=negotiate in /etc/xrdp/xrdp.ini and restart xrdp)"
	if len(x224) < 19 {
		return standardOnly
	}
	value := binary.LittleEndian.Uint32(x224[15:])
	switch x224[11] {
	case 0x02:
		if value == 0 {
			return standardOnly
		}
	case 0x03:
		switch value {
		case 2: // SSL_NOT_ALLOWED_BY_SERVER
			return standardOnly
		case 3:
			return "the RDP server has no TLS certificate (for xrdp: see certificate= and key_file= in /etc/xrdp/xrdp.ini)"
		default:
			return "the RDP server refused the security negotiation (code " + itoa(int(value)) + ")"
		}
	}
	return ""
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// Autologon returns what the client's data becomes on its way to the server: xrdp signs in with the Client Info PDU's
// credentials only when its INFO_AUTOLOGON flag is set, and otherwise shows its own login window; IronRDP's web client
// never sets it. The proxy has the client's side in the clear (it does the TLS), so it sets the flag in that one PDU,
// in place, and passes everything else through untouched.
func Autologon() func([]byte) []byte {
	const infoAutologon = 0x08
	const secInfoPkt = 0x40
	var pending []byte
	done := false
	// TPKT (4), X.224 Data (3: 02 f0 80), MCS Send Data Request (0x64, initiator 2, channel 2, priority 1, PER length 1
	// or 2), basic security header (flags 2 with SEC_INFO_PKT, flagsHi 2), then TS_INFO_PACKET: CodePage 4, flags 4.
	patch := func(pdu []byte) bool {
		if len(pdu) < 14 || pdu[4] != 0x02 || pdu[5] != 0xf0 || pdu[7]>>2 != 25 {
			return false
		}
		sec := 13 + 1
		if pdu[13]&0x80 != 0 {
			sec = 13 + 2
		}
		if len(pdu) < sec+12 || binary.LittleEndian.Uint16(pdu[sec:])&secInfoPkt == 0 {
			return false
		}
		flags := sec + 4 + 4
		binary.LittleEndian.PutUint32(pdu[flags:], binary.LittleEndian.Uint32(pdu[flags:])|infoAutologon)
		return true
	}
	return func(data []byte) []byte {
		if done {
			return data
		}
		// Copied: patched in place.
		pending = append(pending, data...)
		p := 0
		// Whole TPKT frames; a partial one waits for the rest. Anything else (fast-path input, or a TPKT shorter than its
		// own header, which no frame can follow) means the connection sequence, and with it the Client Info PDU, is
		// over: what follows passes as it is, for the server to judge.
		for len(pending)-p >= 4 {
			length := int(binary.BigEndian.Uint16(pending[p+2:]))
			if pending[p] != 0x03 || length < 4 {
				done = true
				break
			}
			if len(pending)-p < length {
				break
			}
			done = patch(pending[p : p+length])
			p += length
			if done {
				break
			}
		}
		var out []byte
		if done {
			out, pending = pending, nil
		} else if p > 0 {
			// Whole frames go on as they are, in storage of their own; a partial one waits, copied once.
			out = bytes.Clone(pending[:p])
			n := copy(pending, pending[p:])
			pending = pending[:n]
		}
		return out
	}
}

// ErrInvalidFrame: what the server sent is none of what an RDP server sends.
var ErrInvalidFrame = errors.New("invalid RDP server frame")

// maxDER: a server's CredSSP messages are small (its NTLM challenge or Kerberos reply, and its proof of the public
// key, a few kilobytes at most). A larger claim is no server's: it would only have the proxy keep whatever comes.
const maxDER = 256 * 1024

// ServerFraming splits what the server sends into whole PDUs, one per WebSocket message. IronRDP's web client drops
// whatever else a message holds at the end of the connection sequence (it hands its session reader the bare stream,
// without the framer's leftovers): when GNOME sent the last activation PDU and the start of dynamic-channel
// negotiation in one read, the graphics channel never opened and the desktop stayed blank. So messages follow PDU
// boundaries, not TLS records or SSH reads. Before RDP there can be CredSSP's DER messages and, with HYBRID_EX
// (earlyAuth), a four-byte Early User Authorization Result; after that, TPKT and fast-path.
type ServerFraming struct {
	earlyAuth bool
	rdp       bool
	pending   []byte
}

// NewServerFraming starts framing a server's stream.
func NewServerFraming(earlyAuth bool) *ServerFraming { return &ServerFraming{earlyAuth: earlyAuth} }

// lengthOf is the length of the PDU at the start of b, 0 while its header is incomplete.
func (f *ServerFraming) lengthOf(b []byte) (int, error) {
	if len(b) < 2 {
		return 0, nil
	}
	if !f.rdp && b[0] == 0x30 {
		if b[1]&0x80 == 0 {
			return 2 + int(b[1]), nil
		}
		octets := int(b[1] & 0x7f)
		if octets == 0 || octets > 4 {
			return 0, ErrInvalidFrame
		}
		if len(b) < 2+octets {
			return 0, nil
		}
		content := uint64(0)
		for i := 0; i < octets; i++ {
			content = content<<8 | uint64(b[2+i])
		}
		if content > maxDER {
			return 0, ErrInvalidFrame
		}
		return 2 + octets + int(content), nil
	}
	if !f.rdp && f.earlyAuth {
		return 4, nil
	}
	if b[0] == 0x03 {
		if b[1] != 0 {
			return 0, ErrInvalidFrame
		}
		if len(b) < 4 {
			return 0, nil
		}
		length := int(binary.BigEndian.Uint16(b[2:]))
		if length < 4 {
			return 0, ErrInvalidFrame
		}
		return length, nil
	}
	if f.rdp && b[0]&0x03 == 0 {
		if b[1]&0x80 == 0 {
			if b[1] < 2 {
				return 0, ErrInvalidFrame
			}
			return int(b[1]), nil
		}
		if len(b) < 3 {
			return 0, nil
		}
		length := int(b[1]&0x7f)<<8 | int(b[2])
		if length < 3 {
			return 0, ErrInvalidFrame
		}
		return length, nil
	}
	return 0, ErrInvalidFrame
}

// Push takes the server's next bytes and returns the PDUs they complete (each its own slice); an error for data that
// is none of these. What waits is added to, not copied whole again with each piece: a server can send one-byte TLS
// records, and copying all that waits for each would cost the square of a PDU's size. A byte is copied in once, and
// at most once more, when the PDU before it completes.
func (f *ServerFraming) Push(data []byte) ([][]byte, error) {
	f.pending = append(f.pending, data...)
	var out [][]byte
	p := 0
	for {
		head := f.pending[p:min(len(f.pending), p+6)]
		length, err := f.lengthOf(head)
		if err != nil {
			return nil, err
		}
		if length == 0 || len(f.pending)-p < length {
			break
		}
		if !f.rdp && f.earlyAuth && head[0] != 0x30 {
			f.earlyAuth = false
		} else if head[0] == 0x03 {
			f.rdp = true
		}
		out = append(out, bytes.Clone(f.pending[p:p+length]))
		p += length
	}
	if p > 0 {
		n := copy(f.pending, f.pending[p:])
		f.pending = f.pending[:n]
	}
	return out, nil
}
