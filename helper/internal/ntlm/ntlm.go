// Package ntlm is NTLMv2 ([MS-NLMP]), as much as HTTP authentication to an RD Gateway needs: the three messages, no
// signing or sealing afterwards. Written out here rather than taken from a module: it is small, and the password
// passes through it. Ported from the plugin's former src/ntlm.ts.
package ntlm

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"strings"
	"time"
	"unicode/utf16"
)

var signature = []byte("NTLMSSP\x00")

const (
	negotiateUnicode                 = 0x00000001
	requestTarget                    = 0x00000004
	negotiateNTLM                    = 0x00000200
	negotiateAlwaysSign              = 0x00008000
	negotiateExtendedSessionSecurity = 0x00080000
	negotiateTargetInfo              = 0x00800000
	negotiateVersion                 = 0x02000000
	negotiate128                     = 0x20000000
	negotiate56                      = 0x80000000
)

// AV pairs of the server's target information.
const (
	avEOL             = 0
	avFlags           = 6
	avTimestamp       = 7
	avTargetName      = 9
	avChannelBindings = 10
	// MsvAvFlags: the authenticate message carries a message integrity code.
	avFlagMIC = 0x2
)

func utf16le(text string) []byte {
	units := utf16.Encode([]rune(text))
	out := make([]byte, 2*len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(out[2*i:], u)
	}
	return out
}

func hmacMD5(key []byte, data ...[]byte) []byte {
	h := hmac.New(md5.New, key)
	for _, d := range data {
		h.Write(d)
	}
	return h.Sum(nil)
}

// NTLMv2Hash is NTOWFv2: what the password, user and domain come to.
func NTLMv2Hash(username, domain, password string) []byte {
	// Upper case a character at a time, as Windows makes it (RtlUpcaseUnicodeString). JavaScript's toUpperCase, which
	// the plugin used before, turned a few letters into two (ß into SS), which Windows doesn't.
	return hmacMD5(MD4(utf16le(password)), utf16le(strings.ToUpper(username)+domain))
}

// NegotiateMessage is the first message: what this client can do.
func NegotiateMessage() []byte {
	m := make([]byte, 32)
	copy(m, signature)
	binary.LittleEndian.PutUint32(m[8:], 1)
	binary.LittleEndian.PutUint32(m[12:], negotiateUnicode|requestTarget|negotiateNTLM|negotiateAlwaysSign|
		negotiateExtendedSessionSecurity|negotiate128|negotiate56)
	// Domain and workstation: none given (their fields point at the end, with no length).
	binary.LittleEndian.PutUint32(m[20:], 32)
	binary.LittleEndian.PutUint32(m[28:], 32)
	return m
}

// Challenge is the server's challenge message, read.
type Challenge struct {
	Flags      uint32
	Challenge  []byte
	TargetInfo []byte
}

// ParseChallenge reads the server's challenge message.
func ParseChallenge(m []byte) (*Challenge, error) {
	if len(m) < 48 || !bytes.Equal(m[:8], signature) || binary.LittleEndian.Uint32(m[8:]) != 2 {
		return nil, errors.New("not an NTLM challenge")
	}
	flags := binary.LittleEndian.Uint32(m[20:])
	// Compared as they are before they become ints: on a 32-bit system an offset past 2^31 would be negative.
	length, at := binary.LittleEndian.Uint16(m[40:]), binary.LittleEndian.Uint32(m[44:])
	if uint64(at) > uint64(len(m)) || uint64(length) > uint64(len(m))-uint64(at) {
		return nil, errors.New("the NTLM challenge's target information is cut short")
	}
	offset := int(at)
	c := &Challenge{Flags: flags, Challenge: bytes.Clone(m[24:32]), TargetInfo: []byte{}}
	if flags&negotiateTargetInfo != 0 {
		c.TargetInfo = bytes.Clone(m[offset : offset+int(length)])
	}
	return c, nil
}

// avPair is one value of the target information's AV pairs, or nil.
func avPair(info []byte, id uint16) []byte {
	for at := 0; at+4 <= len(info); {
		pair, length := binary.LittleEndian.Uint16(info[at:]), int(binary.LittleEndian.Uint16(info[at+2:]))
		if pair == avEOL {
			break
		}
		if pair == id {
			return info[at+4 : min(len(info), at+4+length)]
		}
		at += 4 + length
	}
	return nil
}

func pair(id uint16, value []byte) []byte {
	head := make([]byte, 4, 4+len(value))
	binary.LittleEndian.PutUint16(head, id)
	binary.LittleEndian.PutUint16(head[2:], uint16(len(value)))
	return append(head, value...)
}

// ChannelBindingHash is the channel binding's hash ([MS-NLMP] 3.1.5.1.2): MD5 over a gss_channel_bindings_struct with
// no addresses and the binding as its application data.
func ChannelBindingHash(binding []byte) []byte {
	head := make([]byte, 20)
	binary.LittleEndian.PutUint32(head[16:], uint32(len(binding)))
	h := md5.New()
	h.Write(head)
	h.Write(binding)
	return h.Sum(nil)
}

// clientTargetInfo is the target information as the client's response carries it back: the server's pairs, and the
// client's own (the integrity code's flag, the channel binding, the service's name).
func clientTargetInfo(info []byte, mic bool, channelBinding []byte, targetName string) []byte {
	var pairs [][]byte
	var flags uint32
	if mic {
		flags = avFlagMIC
	}
	for at := 0; at+4 <= len(info); {
		id, length := binary.LittleEndian.Uint16(info[at:]), int(binary.LittleEndian.Uint16(info[at+2:]))
		if id == avEOL {
			break
		}
		end := min(len(info), at+4+length)
		if id == avFlags && length == 4 && at+8 <= len(info) {
			flags |= binary.LittleEndian.Uint32(info[at+4:])
		} else if id != avChannelBindings && id != avTargetName {
			pairs = append(pairs, info[at:end])
		}
		at += 4 + length
	}
	if flags != 0 {
		value := make([]byte, 4)
		binary.LittleEndian.PutUint32(value, flags)
		pairs = append(pairs, pair(avFlags, value))
	}
	// No binding to give: zeros, as Windows sends them (a server that insists on one refuses those).
	binding := make([]byte, 16)
	if channelBinding != nil {
		binding = ChannelBindingHash(channelBinding)
	}
	pairs = append(pairs, pair(avChannelBindings, binding), pair(avTargetName, utf16le(targetName)), make([]byte, 4))
	return bytes.Join(pairs, nil)
}

// windowsTime is Windows time (100 ns since 1601) of now.
func windowsTime(now time.Time) []byte {
	t := make([]byte, 8)
	binary.LittleEndian.PutUint64(t, uint64(now.UnixMilli()+11644473600000)*10000)
	return t
}

// NTLMv2Response is the NTLMv2 response to a challenge ([MS-NLMP] 3.3.2): the proof, with the blob it covers, and
// the session's base key. timestamp and clientChallenge are given by tests; otherwise the server's time (or now) and
// random bytes.
func NTLMv2Response(hash, serverChallenge, targetInfo, timestamp, clientChallenge []byte) (response, sessionKey []byte) {
	if timestamp == nil {
		timestamp = avPair(targetInfo, avTimestamp)
	}
	if timestamp == nil {
		timestamp = windowsTime(time.Now())
	}
	if clientChallenge == nil {
		clientChallenge = make([]byte, 8)
		_, _ = rand.Read(clientChallenge)
	}
	blob := bytes.Join([][]byte{{1, 1, 0, 0, 0, 0, 0, 0}, timestamp, clientChallenge, make([]byte, 4), targetInfo, make([]byte, 4)}, nil)
	proof := hmacMD5(hash, serverChallenge, blob)
	return append(proof, blob...), hmacMD5(hash, proof)
}

// Account is what the sign-in is for and with.
type Account struct {
	// `user`, `DOMAIN\user` or `user@domain`.
	Username, Domain, Password string
	Workstation                string
	// What ties the sign-in to the TLS connection it is made over ("tls-server-end-point:" and the certificate's
	// hash), and the service signed in to (`HTTP/host`): servers set up for extended protection (an RD Gateway, by
	// default) refuse a sign-in without them.
	ChannelBinding []byte
	TargetName     string
}

// AuthenticateMessage is the third message: the answer to the server's challenge, for this account. negotiate and
// challenge are the two messages before it, which its integrity code covers.
func AuthenticateMessage(negotiate, challenge []byte, account Account) ([]byte, error) {
	server, err := ParseChallenge(challenge)
	if err != nil {
		return nil, err
	}
	// The sign-in is bound to the TLS connection and the service it is for by the pairs the client adds to the
	// server's target information, and covered whole by the integrity code, which goes with the server's time among
	// those pairs. A challenge without target information, or without the time, would have the answer go out bound to
	// neither, with an LMv2 response besides that binds nothing either: one a gateway could pass on to another service
	// that only checks the binding when it is there. Every Windows since Vista sends both, and an RD Gateway is a
	// Windows Server 2012 R2 or later: such a challenge is refused.
	if len(server.TargetInfo) == 0 {
		return nil, errors.New("the gateway's NTLM challenge has no target information, so the sign-in couldn't be bound to this connection: not answered")
	}
	if avPair(server.TargetInfo, avTimestamp) == nil {
		return nil, errors.New("the gateway's NTLM challenge doesn't say when it is, so the sign-in couldn't be bound to this connection: not answered")
	}
	domain, username := account.Domain, account.Username
	if i := strings.IndexByte(account.Username, '\\'); i > 0 && i < len(account.Username)-1 {
		domain, username = account.Username[:i], account.Username[i+1:]
	}
	targetInfo := clientTargetInfo(server.TargetInfo, true, account.ChannelBinding, account.TargetName)
	hash := NTLMv2Hash(username, domain, account.Password)
	response, sessionKey := NTLMv2Response(hash, server.Challenge, targetInfo, nil, nil)
	// No LM response next to the server's time: the NT response and the integrity code are the proof.
	fields := [][]byte{make([]byte, 24), response, utf16le(domain), utf16le(username), utf16le(account.Workstation), {}}
	// 64 bytes of fields and flags, 8 of version (none), 16 of integrity code, then what the fields point at.
	header := make([]byte, 88)
	copy(header, signature)
	binary.LittleEndian.PutUint32(header[8:], 3)
	offset := len(header)
	for i, field := range fields {
		binary.LittleEndian.PutUint16(header[12+i*8:], uint16(len(field)))
		binary.LittleEndian.PutUint16(header[14+i*8:], uint16(len(field)))
		binary.LittleEndian.PutUint32(header[16+i*8:], uint32(offset))
		offset += len(field)
	}
	ours := uint32(negotiateUnicode | requestTarget | negotiateNTLM | negotiateAlwaysSign | negotiateExtendedSessionSecurity |
		negotiateTargetInfo | negotiate128 | negotiate56)
	binary.LittleEndian.PutUint32(header[60:], server.Flags&ours&^negotiateVersion)
	message := bytes.Join(append([][]byte{header}, fields...), nil)
	copy(message[72:], hmacMD5(sessionKey, negotiate, challenge, message))
	return message, nil
}
