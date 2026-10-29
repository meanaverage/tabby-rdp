// NTLMv2 for the RD Gateway's sign-in, against the published vectors: MD4's (RFC 1320) and the protocol's own
// ([MS-NLMP] 4.2.4). Ported from the plugin's former test/unit/ntlm.ts.
package ntlm

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"
	"unicode/utf16"
)

func unhex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func fromUTF16(b []byte) string {
	units := make([]uint16, len(b)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(b[2*i:])
	}
	return string(utf16.Decode(units))
}

func TestMD4Vectors(t *testing.T) {
	vectors := map[string]string{
		"":                           "31d6cfe0d16ae931b73c59d7e0c089c0",
		"a":                          "bde52cb31de33e46245e05fbdbd6fb24",
		"abc":                        "a448017aaf21d8525fc10ae87aa6729d",
		"message digest":             "d9130a8164549fe818874806e1c7014b",
		"abcdefghijklmnopqrstuvwxyz": "d79e1c308aa5bbcdeea8ed63df412da9",
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789":                   "043f8582f241db351ce627e153e7f0e4",
		"12345678901234567890123456789012345678901234567890123456789012345678901234567890": "e33b4ddc9c38f2199c3e7b164fcc0536",
	}
	for text, digest := range vectors {
		if got := hex.EncodeToString(MD4([]byte(text))); got != digest {
			t.Errorf("MD4(%q) = %s, want %s", text, got, digest)
		}
	}
}

// [MS-NLMP] 4.2.1 and 4.2.4: User, Domain, Password; the server's challenge and target information; a client
// challenge of aa…; time zero.
var (
	serverChallenge = unhex("0123456789abcdef")
	targetInfo      = unhex("02000c0044006f006d00610069006e0001000c005300650072007600650072000000" + "0000")
)

func TestNTLMv2ProtocolVectors(t *testing.T) {
	if got := hex.EncodeToString(MD4(utf16le("Password"))); got != "a4f49c406510bdcab6824ee7c30fd852" {
		t.Fatalf("NT hash %s", got)
	}
	hash := NTLMv2Hash("User", "Domain", "Password")
	if got := hex.EncodeToString(hash); got != "0c868a403bfd7a93a3001ef22ef02e3f" {
		t.Fatalf("NTOWFv2 %s", got)
	}
	response, sessionKey := NTLMv2Response(hash, serverChallenge, targetInfo, make([]byte, 8), bytes.Repeat([]byte{0xaa}, 8))
	if got := hex.EncodeToString(response[:16]); got != "68cd0ab851e51c96aabc927bebef6a1c" {
		t.Errorf("proof %s", got)
	}
	if got := hex.EncodeToString(sessionKey); got != "8de40ccadbc14a82f15cb0ad0de95ca3" {
		t.Errorf("session key %s", got)
	}
}

// challengeMessage is a challenge message with these flags and this target information.
func challengeMessage(flags uint32, info []byte) []byte {
	m := make([]byte, 56)
	copy(m, "NTLMSSP\x00")
	binary.LittleEndian.PutUint32(m[8:], 2)
	binary.LittleEndian.PutUint32(m[16:], 56)
	binary.LittleEndian.PutUint32(m[20:], flags)
	copy(m[24:], serverChallenge)
	binary.LittleEndian.PutUint16(m[40:], uint16(len(info)))
	binary.LittleEndian.PutUint16(m[42:], uint16(len(info)))
	binary.LittleEndian.PutUint32(m[44:], 56)
	return append(m, info...)
}

func field(message []byte, i int) []byte {
	offset := int(binary.LittleEndian.Uint32(message[16+i*8:]))
	return message[offset : offset+int(binary.LittleEndian.Uint16(message[12+i*8:]))]
}

func mac(key []byte, data ...[]byte) []byte {
	h := hmac.New(md5.New, key)
	for _, d := range data {
		h.Write(d)
	}
	return h.Sum(nil)
}

var timestamp = unhex("0090d336b734c301")

// timed is the target information with the server's time among its pairs, as Windows sends it.
func timed() []byte {
	return bytes.Join([][]byte{targetInfo[:len(targetInfo)-4], unhex("07000800"), timestamp, make([]byte, 4)}, nil)
}

func TestThreeMessages(t *testing.T) {
	negotiate := NegotiateMessage()
	if string(negotiate[:8]) != "NTLMSSP\x00" || binary.LittleEndian.Uint32(negotiate[8:]) != 1 {
		t.Fatal("negotiate message header")
	}
	challenge := challengeMessage(0xe28a8215, timed())
	parsed, err := ParseChallenge(challenge)
	if err != nil || !bytes.Equal(parsed.Challenge, serverChallenge) {
		t.Fatal("challenge not read", err)
	}
	message, err := AuthenticateMessage(negotiate, challenge, Account{Username: `DOMAIN\User`, Password: "Password", Workstation: "HERE"})
	if err != nil {
		t.Fatal(err)
	}
	if binary.LittleEndian.Uint32(message[8:]) != 3 {
		t.Fatal("not an authenticate message")
	}
	if !bytes.Equal(field(message, 0), make([]byte, 24)) {
		t.Error("an LM response next to a timestamp")
	}
	if fromUTF16(field(message, 2)) != "DOMAIN" || fromUTF16(field(message, 3)) != "User" || fromUTF16(field(message, 4)) != "HERE" {
		t.Error("domain, user or workstation misplaced")
	}
	nt := field(message, 1)
	hash := NTLMv2Hash("User", "DOMAIN", "Password")
	proof := mac(hash, serverChallenge, nt[16:])
	if !bytes.Equal(nt[:16], proof) {
		t.Error("the proof doesn't verify")
	}
	if !bytes.Equal(nt[24:32], timestamp) {
		t.Error("not the server's time")
	}
	if !bytes.Contains(nt, unhex("0600040002000000")) {
		t.Error("no integrity code flag")
	}
	// No TLS connection to bind to: zeros for the channel binding, and an empty target name.
	if !bytes.Contains(nt, bytes.Join([][]byte{unhex("0a001000"), make([]byte, 16), unhex("09000000"), make([]byte, 4)}, nil)) {
		t.Error("an unbound sign-in should carry zeros and an empty name")
	}
	bound, err := AuthenticateMessage(negotiate, challenge, Account{Username: "User", Password: "Password",
		ChannelBinding: []byte("tls-server-end-point:abc"), TargetName: "HTTP/gw"})
	if err != nil {
		t.Fatal(err)
	}
	want := bytes.Join([][]byte{unhex("0a001000"), ChannelBindingHash([]byte("tls-server-end-point:abc")), unhex("09000e00"), utf16le("HTTP/gw"), make([]byte, 4)}, nil)
	if !bytes.Contains(bound, want) {
		t.Error("the binding and the target name aren't in the bound sign-in")
	}
	// The integrity code: over all three messages, with its own place zeroed, by the session key.
	zeroed := bytes.Clone(message)
	clear(zeroed[72:88])
	key := mac(hash, proof)
	if !bytes.Equal(message[72:88], mac(key, negotiate, challenge, zeroed)) {
		t.Error("the integrity code doesn't verify")
	}
	other, _ := AuthenticateMessage(negotiate, challenge, Account{Username: "User", Domain: "DOMAIN", Password: "password"})
	if bytes.Equal(field(other, 1)[:16], proof) {
		t.Error("a wrong password gave the same proof")
	}
}

func TestNotAChallenge(t *testing.T) {
	if _, err := ParseChallenge([]byte("nonsense")); err == nil || !strings.Contains(err.Error(), "not an NTLM challenge") {
		t.Error(err)
	}
	if _, err := AuthenticateMessage(NegotiateMessage(), NegotiateMessage(), Account{Username: "u", Password: "p"}); err == nil ||
		!strings.Contains(err.Error(), "not an NTLM challenge") {
		t.Error(err)
	}
}

// Target information said to lie past the message, at any offset (one past 2^31 too, which on a 32-bit system would be
// a negative int), is refused rather than sliced.
func TestChallengeTargetInfoOutOfRange(t *testing.T) {
	for _, offset := range []uint32{48, 49, 1 << 31, 0xfffffff0, 0xffffffff} {
		m := make([]byte, 48)
		copy(m, signature)
		binary.LittleEndian.PutUint32(m[8:], 2)
		binary.LittleEndian.PutUint32(m[20:], negotiateTargetInfo)
		binary.LittleEndian.PutUint16(m[40:], 16)
		binary.LittleEndian.PutUint32(m[44:], offset)
		if _, err := ParseChallenge(m); err == nil || !strings.Contains(err.Error(), "cut short") {
			t.Errorf("offset %#x: %v", offset, err)
		}
	}
}

// A challenge without target information, or without the server's time, is refused rather than answered unbound.
func TestUnboundChallengeRefused(t *testing.T) {
	negotiate := NegotiateMessage()
	account := Account{Username: `DOMAIN\User`, Password: "Password", ChannelBinding: []byte("tls-server-end-point:abc"), TargetName: "HTTP/gw"}
	for _, challenge := range [][]byte{challengeMessage(0xe28a8215&^0x00800000, timed()), challengeMessage(0xe28a8215, nil)} {
		if _, err := AuthenticateMessage(negotiate, challenge, account); err == nil || !strings.Contains(err.Error(), "no target information, so the sign-in couldn't be bound") {
			t.Error(err)
		}
	}
	if _, err := AuthenticateMessage(negotiate, challengeMessage(0xe28a8215, targetInfo), account); err == nil || !strings.Contains(err.Error(), "doesn't say when it is") {
		t.Error(err)
	}
	message, err := AuthenticateMessage(negotiate, challengeMessage(0xe28a8215, timed()), account)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(field(message, 0), make([]byte, 24)) || !bytes.Contains(field(message, 1), append(unhex("0a001000"), ChannelBindingHash(account.ChannelBinding)...)) ||
		!bytes.Contains(field(message, 1), append(unhex("09000e00"), utf16le("HTTP/gw")...)) || bytes.Equal(message[72:88], make([]byte, 16)) {
		t.Error("the bound answer is missing its binding, its target name or its integrity code")
	}
}

// Upper case as Windows makes it: a character at a time.
func TestUserNameUpperCase(t *testing.T) {
	if !bytes.Equal(NTLMv2Hash("straße", "D", "p"), mac(MD4(utf16le("p")), utf16le("STRAßE"+"D"))) {
		t.Error("ß should stay one letter")
	}
}
