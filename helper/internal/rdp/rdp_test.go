// What the proxy reads and writes of RDP: the pre-connection PDU, the security protocol the server chose, the user
// name taken out of the connection request, the Client Info PDU's autologon flag, and the framing of what the server
// sends (one PDU per WebSocket message, whatever the reads look like). Ported from the plugin's former unit tests
// (test/unit/proxy.ts and test/unit/server-framing.ts), which ran these against src/rdcleanpath.ts.
package rdp

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func unhex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func TestPreconnectionPDU(t *testing.T) {
	pdu := PreconnectionPDU("ab")
	if len(pdu) != 18+6 {
		t.Fatalf("length %d", len(pdu))
	}
	le := binary.LittleEndian
	if got := []uint32{le.Uint32(pdu[0:]), le.Uint32(pdu[4:]), le.Uint32(pdu[8:]), le.Uint32(pdu[12:]), uint32(le.Uint16(pdu[16:]))}; !equal(got, []uint32{24, 0, 2, 0, 3}) {
		t.Errorf("header %v", got)
	}
	units := make([]uint16, 3)
	for i := range units {
		units[i] = le.Uint16(pdu[18+2*i:])
	}
	if string(utf16.Decode(units)) != "ab\x00" {
		t.Errorf("text %q", string(utf16.Decode(units)))
	}
	// A character outside the basic plane takes two units, both counted.
	if long := PreconnectionPDU("\U0001F600"); le.Uint16(long[16:]) != 3 || len(long) != 18+6 {
		t.Errorf("a surrogate pair: %x", long)
	}
}

func equal(a, b []uint32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// confirm is a server's answer to the connection request: a confirm choosing this security protocol (or refusing,
// failure).
func confirm(selected byte, failure bool) []byte {
	kind := byte(2)
	if failure {
		kind = 3
	}
	return []byte{3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, kind, 0, 8, 0, selected, 0, 0, 0}
}

func TestNetworkLevelAuthentication(t *testing.T) {
	cases := []struct {
		x224 []byte
		nla  bool
		what string
	}{
		{confirm(2, false), true, "CredSSP"},
		{confirm(8, false), true, "CredSSP with early user authorization"},
		{confirm(1, false), false, "TLS alone: the password would go in the Client Info PDU"},
		{confirm(0, false), false, "standard RDP security"},
		{confirm(2, true), false, "a refusal whose code happens to be 2"},
		{[]byte{3, 0, 0, 11, 6, 0xd0, 0, 0, 0, 0, 0}, false, "no negotiation response at all"},
	}
	for _, c := range cases {
		if OffersNLA(c.x224) != c.nla {
			t.Errorf("%s: OffersNLA = %v", c.what, !c.nla)
		}
	}
}

func TestHybridExIsAFlag(t *testing.T) {
	// HYBRID|HYBRID_EX: IronRDP waits for the result, and the proxy has to frame it.
	if !EarlyUserAuthorization(confirm(8, false)) || !EarlyUserAuthorization(confirm(0x0a, false)) || !OffersNLA(confirm(0x0a, false)) {
		t.Error("HYBRID_EX not taken as a flag")
	}
	for _, x224 := range [][]byte{confirm(2, false), confirm(1, false), confirm(8, true), {3, 0, 0, 11, 6, 0xd0, 0, 0, 0, 0, 0}} {
		if EarlyUserAuthorization(x224) {
			t.Errorf("%x: an early user authorization result expected", x224)
		}
	}
}

func TestNoTLS(t *testing.T) {
	if NoTLS(confirm(2, false)) != "" || NoTLS(confirm(1, false)) != "" {
		t.Error("TLS refused where it was chosen")
	}
	for _, x224 := range [][]byte{confirm(0, false), confirm(2, true), {3, 0, 0, 11, 6, 0xd0, 0, 0, 0, 0, 0}} {
		if !strings.Contains(NoTLS(x224), "standard RDP security") {
			t.Errorf("%x: %q", x224, NoTLS(x224))
		}
	}
	if !strings.Contains(NoTLS(confirm(3, true)), "no TLS certificate") || !strings.Contains(NoTLS(confirm(5, true)), "(code 5)") {
		t.Error("a refusal's reason")
	}
}

// ironrdpRequest is an X.224 connection request as IronRDP's web client builds it (user alice@corp.example): the
// user name as a cookie, then SSL|HYBRID|HYBRID_EX.
var ironrdpRequest = unhex("0300003833e00000000000436f6f6b69653a206d737473686173683d616c69636540636f72702e6578616d706c650d0a010008000b000000")

func TestWithoutUserCookie(t *testing.T) {
	if !bytes.Contains(ironrdpRequest, []byte("Cookie: mstshash=alice@corp.example\r\n")) {
		t.Fatal("the request has no cookie")
	}
	out := WithoutUserCookie(ironrdpRequest)
	if hex.EncodeToString(out) != "030000130ee00000000000010008000b000000" {
		t.Errorf("%x", out)
	}
	if int(binary.BigEndian.Uint16(out[2:])) != len(out) || int(out[4]) != len(out)-5 {
		t.Error("TPKT length or X.224 length indicator")
	}
	// Already without one, a broker's routing token (no user name in it), or not a connection request: as it is.
	plain := []byte{3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0}
	token := append([]byte{3, 0, 0, 0, 0, 0xe0, 0, 0, 0, 0, 0}, "Cookie: msts=3640205228.15629.0000\r\n"...)
	binary.BigEndian.PutUint16(token[2:], uint16(len(token)))
	token[4] = byte(len(token) - 5)
	unterminated := bytes.Replace(ironrdpRequest, []byte("\r\n"), []byte("__"), 1)
	odd := bytes.Clone(ironrdpRequest)
	binary.BigEndian.PutUint16(odd[2:], uint16(len(odd)+1))
	for _, request := range [][]byte{plain, token, confirm(2, false), unterminated, odd} {
		if !bytes.Equal(WithoutUserCookie(request), request) {
			t.Errorf("%x changed", request)
		}
	}
}

// der is a DER element (lengths up to 64 KiB).
func der(tag byte, content []byte) []byte {
	n := len(content)
	switch {
	case n < 128:
		return append([]byte{tag, byte(n)}, content...)
	case n < 256:
		return append([]byte{tag, 0x81, byte(n)}, content...)
	}
	return append([]byte{tag, 0x82, byte(n >> 8), byte(n)}, content...)
}

func TestDecodeRequest(t *testing.T) {
	request := der(0x30, bytes.Join([][]byte{
		der(0xa0, der(0x02, []byte{0x0d, 0x3e})),
		der(0xa2, der(0x0c, []byte("server:3389"))),
		der(0xa3, der(0x0c, []byte("token"))),
		der(0xa5, der(0x0c, []byte("vm-id"))),
		der(0xa6, der(0x04, []byte{3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0})),
	}, nil))
	req, err := DecodeRequest(request)
	if err != nil || req.Version != Version1 || req.Destination != "server:3389" || req.ProxyAuth != "token" || req.PCB != "vm-id" || len(req.X224) != 11 {
		t.Fatalf("%+v %v", req, err)
	}
	// Fields whose lengths run past their parent's are malformed, not read past.
	bad := bytes.Clone(request)
	bad[len(bad)-12] = 0x40
	if _, err := DecodeRequest(bad); err == nil {
		t.Error("a field past its parent was taken")
	}
	if _, err := DecodeRequest([]byte{0x31, 0}); err == nil {
		t.Error("not a SEQUENCE")
	}
	// A claimed length past anything (beyond 32 bits too) only waits for more.
	if tlv, ok := ReadTLV([]byte{0x30, 0x88, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, 0); !ok || tlv.End < 1<<30 {
		t.Errorf("%+v %v", tlv, ok)
	}
}

func TestResponseAndError(t *testing.T) {
	if hex.EncodeToString(EncodeError()) != "300fa00402020d3ea1073005a003020101" {
		t.Errorf("%x", EncodeError())
	}
	response := EncodeResponse([]byte{1, 2}, [][]byte{{0xaa}, {0xbb, 0xcc}}, "server:3389")
	want := der(0x30, bytes.Join([][]byte{
		der(0xa0, der(0x02, []byte{0x0d, 0x3e})),
		der(0xa6, der(0x04, []byte{1, 2})),
		der(0xa7, der(0x30, append(der(0x04, []byte{0xaa}), der(0x04, []byte{0xbb, 0xcc})...))),
		der(0xa9, der(0x0c, []byte("server:3389"))),
	}, nil))
	if !bytes.Equal(response, want) {
		t.Errorf("%x\n%x", response, want)
	}
	// A Hyper-V VM's console: no X.224 confirm.
	if bytes.Contains(EncodeResponse(nil, [][]byte{{0xaa}}, "x"), []byte{0xa6}) {
		t.Error("an X.224 field without a confirm")
	}
}

func TestAutologon(t *testing.T) {
	// TPKT, X.224 data, MCS Send Data Request, a security header with SEC_INFO_PKT, then the info packet's code page and
	// flags; split across two writes, after a PDU that isn't it.
	other := []byte{3, 0, 0, 8, 2, 0xf0, 0x80, 0x00}
	info := []byte{3, 0, 0, 26, 2, 0xf0, 0x80, 0x64, 0, 3, 0, 0xeb, 0x70, 12, 0x40, 0, 0, 0, 0, 0, 0, 0, 0x01, 0, 0, 0}
	patch := Autologon()
	out := append(patch(append(bytes.Clone(other), info[:10]...)), patch(info[10:])...)
	want := append(bytes.Clone(other), info...)
	want[len(other)+22] |= 0x08
	if !bytes.Equal(out, want) {
		t.Errorf("%x\n%x", out, want)
	}
	// After it, and after fast-path input, data passes as it is.
	if fast := []byte{0x04, 0x05, 1, 2, 3}; !bytes.Equal(patch(fast), fast) {
		t.Error("passed data changed")
	}
	// A TPKT shorter than its own header can't be followed by another: it and what comes after pass, rather than
	// waiting for a rest that never completes it.
	short := Autologon()
	bad := []byte{3, 0, 0, 2, 0xaa, 0xbb}
	if got := short(bad); !bytes.Equal(got, bad) {
		t.Errorf("short TPKT: %x, want %x", got, bad)
	}
	if more := []byte{3, 0, 0, 8, 1, 2, 3, 4}; !bytes.Equal(short(more), more) {
		t.Error("data after a short TPKT held back")
	}
}

// stream is CredSSP (short and long DER lengths), HYBRID_EX's Early User Authorization Result, then TPKT and
// fast-path (short and two-byte lengths).
var stream = [][]byte{
	{0x30, 3, 2, 1, 6},
	{0x30, 0x81, 2, 0xaa, 0xbb},
	{0, 0, 0, 0},
	{3, 0, 0, 6, 0xaa, 0xbb},
	{0, 4, 0xcc, 0xdd},
	{0x80, 0x80, 5, 0xee, 0xff},
}

func joined(parts [][]byte) []byte { return bytes.Join(parts, nil) }

func same(t *testing.T, got, want [][]byte) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%d PDUs, want %d: %x", len(got), len(want), got)
	}
	for i := range got {
		if !bytes.Equal(got[i], want[i]) {
			t.Fatalf("PDU %d: %x, want %x", i, got[i], want[i])
		}
	}
}

func push(t *testing.T, f *ServerFraming, data []byte) [][]byte {
	t.Helper()
	pdus, err := f.Push(data)
	if err != nil {
		t.Fatal(err)
	}
	return pdus
}

func TestFramingOnePDUPerMessage(t *testing.T) {
	same(t, push(t, NewServerFraming(true), joined(stream)), stream)
}

func TestFramingByteAtATime(t *testing.T) {
	f := NewServerFraming(true)
	var out [][]byte
	for _, b := range joined(stream) {
		out = append(out, push(t, f, []byte{b})...)
	}
	same(t, out, stream)
}

func TestFramingWithoutHybridEx(t *testing.T) {
	pdus := [][]byte{{0x30, 3, 2, 1, 6}, {3, 0, 0, 5, 1}, {0, 3, 9}}
	same(t, push(t, NewServerFraming(false), joined(pdus)), pdus)
}

func TestFramingActivationAndChannelNegotiation(t *testing.T) {
	// As GNOME sends them: the last activation PDU (Font Map) and the drdynvc capabilities request, in one read.
	fontMap := []byte{3, 0, 0, 8, 1, 2, 3, 4}
	drdynvc := []byte{3, 0, 0, 7, 5, 6, 7}
	f := NewServerFraming(false)
	same(t, push(t, f, append(bytes.Clone(fontMap), drdynvc[:2]...)), [][]byte{fontMap})
	same(t, push(t, f, drdynvc[2:]), [][]byte{drdynvc})
}

func TestFramingKeepsNoCallersBuffer(t *testing.T) {
	// The reader's buffer is used again for its next read: neither what is left nor a PDU may be part of it.
	f := NewServerFraming(false)
	buf := []byte{3, 0, 0, 6, 1, 2, 3, 0}
	pdus := push(t, f, buf)
	clear(buf)
	same(t, pdus, [][]byte{{3, 0, 0, 6, 1, 2}})
	same(t, push(t, f, []byte{0, 5, 9}), [][]byte{{3, 0, 0, 5, 9}})
}

func TestFramingLargeCredSSPRefused(t *testing.T) {
	// A quarter of a megabyte goes through; more is no server's.
	fits := 256 * 1024
	head := []byte{0x30, 0x83, byte(fits >> 16), byte(fits >> 8), byte(fits)}
	if pdus := push(t, NewServerFraming(false), append(head, make([]byte, fits)...)); len(pdus) != 1 {
		t.Fatal(len(pdus))
	}
	over := fits + 1
	if _, err := NewServerFraming(false).Push([]byte{0x30, 0x83, byte(over >> 16), byte(over >> 8), byte(over)}); err != ErrInvalidFrame {
		t.Error(err)
	}
}

func TestFramingMalformed(t *testing.T) {
	for _, bad := range [][]byte{{0x30, 0x80}, {0x30, 0x85}, {0x30, 0x84, 0xff, 0xff, 0xff, 0xff}, {3, 0, 0, 3}, {3, 1, 0, 4}, {0, 4, 1, 2}} {
		if _, err := NewServerFraming(false).Push(bad); err != ErrInvalidFrame {
			t.Errorf("%x: %v", bad, err)
		}
	}
	// Fast-path only once RDP has started, and not shorter than its header.
	f := NewServerFraming(false)
	push(t, f, []byte{3, 0, 0, 4})
	if _, err := f.Push([]byte{0, 1}); err != ErrInvalidFrame {
		t.Error(err)
	}
}

// A message that comes a byte at a time costs its size in work, not its square: the largest a server may send (a
// CredSSP message of a quarter of a megabyte), a byte per read, would take tens of gigabytes of copying otherwise.
func TestFramingByteAtATimeIsLinear(t *testing.T) {
	size := 256 * 1024
	f := NewServerFraming(false)
	var pdus [][]byte
	started := time.Now()
	for _, b := range []byte{0x30, 0x83, byte(size >> 16), byte(size >> 8), byte(size)} {
		pdus = append(pdus, push(t, f, []byte{b})...)
	}
	one := []byte{0x41}
	for i := 0; i < size; i++ {
		pdus = append(pdus, push(t, f, one)...)
	}
	if len(pdus) != 1 || len(pdus[0]) != 5+size {
		t.Fatalf("%d PDUs", len(pdus))
	}
	if took := time.Since(started); took > 2*time.Second {
		t.Errorf("%v for %d bytes a byte at a time", took, size)
	}
}
