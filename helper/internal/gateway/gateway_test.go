// The RD Gateway tunnel against a stand-in gateway: TLS, the WebSocket upgrade with an NTLM sign-in (checked with the
// account's hash, for the TLS connection it is made over and the service it is for, as a gateway checks it), the
// tunnel's packets, and data both ways; the answers a gateway can give that aren't the ones hoped for, given up on
// at once; the decisions the plugin makes (the certificate before anything of the account goes out); and a desktop
// closed while all that is under way. Then the parts on their own: packets put together however their bytes come,
// at the cost of their size and not its square, the channel binding for each kind of certificate, and the gateway's
// refusals in words. Ported from the plugin's former test/unit/gateway.ts (the TypeScript tunnel this package
// replaced); what goes on through the plugin is test/unit/gateway.ts's now.
package gateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/meanaverage/tabby-rdp/helper/internal/certs"
	"github.com/meanaverage/tabby-rdp/helper/internal/ntlm"
	"github.com/meanaverage/tabby-rdp/helper/internal/wsock"
)

// ---- certificates ------------------------------------------------------------------------------------

// makeCertificate is a certificate for gateway.test (and 127.0.0.1), made and signed by key with alg; for a server's
// use, and with no key usage, as openssl makes its own self-signed ones (so that it counts as its own issuer).
func makeCertificate(key crypto.Signer, alg x509.SignatureAlgorithm) (*x509.Certificate, error) {
	template := &x509.Certificate{
		SerialNumber:       big.NewInt(time.Now().UnixNano()),
		Subject:            pkix.Name{CommonName: "gateway.test"},
		NotBefore:          time.Now().Add(-time.Hour),
		NotAfter:           time.Now().Add(48 * time.Hour),
		ExtKeyUsage:        []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:           []string{"gateway.test"},
		IPAddresses:        []net.IP{net.IPv4(127, 0, 0, 1)},
		SignatureAlgorithm: alg,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, key.Public(), key)
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(der)
}

func selfSigned(t *testing.T, key crypto.Signer, alg x509.SignatureAlgorithm) *x509.Certificate {
	t.Helper()
	certificate, err := makeCertificate(key, alg)
	if err != nil {
		t.Fatalf("a certificate signed with %v: %v", alg, err)
	}
	return certificate
}

// The stand-in's own certificate (self-signed, as an RD Gateway's often is), made once: an ECDSA key, quick to make.
var standInCertificate = sync.OnceValues(func() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	leaf, err := makeCertificate(key, x509.ECDSAWithSHA256)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{leaf.Raw}, PrivateKey: key, Leaf: leaf}, nil
})

func serverTLS(t *testing.T) (*tls.Config, *x509.Certificate) {
	t.Helper()
	certificate, err := standInCertificate()
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{certificate}}, certificate.Leaf
}

// ---- NTLM, as the gateway checks it ----------------------------------------------------------------

var serverChallenge = []byte{0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88}

// challengeMessage is the stand-in's NTLM challenge, with its time among the target information, as Windows sends it.
func challengeMessage() []byte {
	info := bytes.Join([][]byte{{2, 0, 4, 0}, utf16le("GW"), {7, 0, 8, 0}, {0x00, 0x90, 0xd3, 0x36, 0xb7, 0x34, 0xc3, 0x01}, {0, 0, 0, 0}}, nil)
	m := make([]byte, 56)
	copy(m, "NTLMSSP\x00")
	binary.LittleEndian.PutUint32(m[8:], 2)
	binary.LittleEndian.PutUint32(m[16:], 56)
	binary.LittleEndian.PutUint32(m[20:], 0xe28a8215)
	copy(m[24:], serverChallenge)
	binary.LittleEndian.PutUint16(m[40:], uint16(len(info)))
	binary.LittleEndian.PutUint16(m[42:], uint16(len(info)))
	binary.LittleEndian.PutUint32(m[44:], 56)
	return append(m, info...)
}

func fromUTF16(b []byte) string {
	units := make([]uint16, len(b)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(b[2*i:])
	}
	return strings.TrimRight(string(utf16.Decode(units)), "\x00")
}

func hmacMD5(key []byte, data ...[]byte) []byte {
	h := hmac.New(md5.New, key)
	for _, d := range data {
		h.Write(d)
	}
	return h.Sum(nil)
}

// pairOf is one of the pairs the client's NT response carries back (after the proof's 16 bytes and the blob's first
// 28), or nil.
func pairOf(nt []byte, id uint16) []byte {
	for at := 44; at+4 <= len(nt); {
		pair, length := binary.LittleEndian.Uint16(nt[at:]), int(binary.LittleEndian.Uint16(nt[at+2:]))
		if pair == id {
			return nt[at+4 : min(len(nt), at+4+length)]
		}
		if pair == 0 {
			break
		}
		at += 4 + length
	}
	return nil
}

// bindingHash is the channel binding's hash as the gateway works it out for itself: MD5 over a bindings structure with
// no addresses (16 bytes of zeros), and the binding as its application data, its length first.
func bindingHash(binding []byte) []byte {
	head := make([]byte, 20)
	binary.LittleEndian.PutUint32(head[16:], uint32(len(binding)))
	sum := md5.Sum(append(head, binding...))
	return sum[:]
}

// disproof says why an authenticate message doesn't prove password for CORP\alice on this TLS connection, or "" if it
// does: the proof under the account's hash, the binding to the gateway's certificate (extended protection, a
// gateway's default, wants it), the service it is for (HTTP/<host>), and the integrity code over all three messages.
func disproof(negotiate, challenge, message []byte, password string, leaf *x509.Certificate, host string) string {
	if len(message) < 88 {
		return "not an authenticate message"
	}
	field := func(i int) []byte {
		offset, length := int(binary.LittleEndian.Uint32(message[16+i*8:])), int(binary.LittleEndian.Uint16(message[12+i*8:]))
		if offset+length > len(message) {
			return nil
		}
		return message[offset : offset+length]
	}
	nt := field(1)
	if len(nt) < 48 {
		return "no NTLMv2 response"
	}
	if fromUTF16(field(3)) != "alice" || fromUTF16(field(2)) != "CORP" {
		return fmt.Sprintf("another account (%s\\%s)", fromUTF16(field(2)), fromUTF16(field(3)))
	}
	hash := ntlm.NTLMv2Hash("alice", "CORP", password)
	proof := hmacMD5(hash, serverChallenge, nt[16:])
	if !hmac.Equal(proof, nt[:16]) {
		return "the proof"
	}
	sum := sha256.Sum256(leaf.Raw)
	if !bytes.Equal(pairOf(nt, 10), bindingHash(append([]byte("tls-server-end-point:"), sum[:]...))) {
		return "the channel binding"
	}
	if fromUTF16(pairOf(nt, 9)) != "HTTP/"+host {
		return "the target name " + fromUTF16(pairOf(nt, 9))
	}
	zeroed := bytes.Clone(message)
	clear(zeroed[72:88])
	if !hmac.Equal(message[72:88], hmacMD5(hmacMD5(hash, proof), negotiate, challenge, zeroed)) {
		return "the integrity code"
	}
	return ""
}

// ---- the stand-in ------------------------------------------------------------------------------------

// serverPacket is a gateway packet as the stand-in writes it: its type, a reserved field, its length, its body.
func serverPacket(typ uint16, body []byte) []byte {
	p := make([]byte, 8, 8+len(body))
	binary.LittleEndian.PutUint16(p, typ)
	binary.LittleEndian.PutUint32(p[4:], uint32(8+len(body)))
	return append(p, body...)
}

// serverData is a data packet's body: the data's length, then the data.
func serverData(data []byte) []byte {
	return append(binary.LittleEndian.AppendUint16(nil, uint16(len(data))), data...)
}

// serverFrame is a server's frame (unmasked) carrying payload.
func serverFrame(payload []byte) []byte {
	return wsock.AppendFrame(nil, wsock.OpBinary, payload, false)
}

// readHead reads a request's head (its request line and headers), up to the empty line after it.
func readHead(in *bufio.Reader) (string, error) {
	var head []byte
	for !bytes.HasSuffix(head, []byte("\r\n\r\n")) {
		line, err := in.ReadSlice('\n')
		head = append(head, line...)
		if err != nil && err != bufio.ErrBufferFull {
			return "", err
		}
	}
	return string(head[:len(head)-4]), nil
}

// headerOf is a header's value in a head (its first, trimmed), or "".
func headerOf(head, name string) string {
	for _, line := range strings.Split(head, "\r\n")[1:] {
		if key, value, ok := strings.Cut(line, ":"); ok && strings.EqualFold(key, name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// asciiUpper is b with its ASCII letters in upper case: the echo's answer, and nothing else changed.
func asciiUpper(b []byte) []byte {
	out := bytes.Clone(b)
	for i, c := range out {
		if c >= 'a' && c <= 'z' {
			out[i] = c - 32
		}
	}
	return out
}

// standIn is a stand-in gateway: one account (CORP\alice), statuses for its answers, and an echo behind the channel
// (what arrives in data packets comes back in upper case, its frame in two pieces; "close" ends the channel instead).
type standIn struct {
	t        *testing.T
	listener net.Listener
	config   *tls.Config
	leaf     *x509.Certificate
	password string
	// By a request's packet type: the status its answer carries (a refusal).
	refuse map[uint16]uint32
	// A request it never answers.
	mute uint16
	// Everything it sends goes a byte at a time, each byte a TLS record of its own.
	trickle bool
	// The answer to the sign-in's first request waits until this is closed.
	hold chan struct{}
	// Runs once the channel is answered, to send more.
	onChannel func(send func([]byte) error) error

	done chan struct{}
	wg   sync.WaitGroup

	mu    sync.Mutex
	conns []net.Conn // nil once ended
	heard heard
}

// heard is what the stand-in heard from its clients.
type heard struct {
	requests   []string  // each request's head, as it came
	afterTLS   int       // what came after the TLS handshake, in bytes
	why        []string  // why a sign-in wasn't taken
	ntlm       [3][]byte // the last sign-in's three messages
	frameError error     // a frame of the client's that wasn't one (an unmasked one, say)
	clientName string
	target     string
	got        []uint16 // the packets' types, as they came
	pongs      []string
}

func newStandIn(t *testing.T, password string, configure func(*standIn)) *standIn {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	config, leaf := serverTLS(t)
	s := &standIn{t: t, listener: listener, config: config, leaf: leaf, password: password, done: make(chan struct{})}
	if configure != nil {
		configure(s)
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.conns = append(s.conns, raw)
			s.mu.Unlock()
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				defer raw.Close()
				s.serve(raw)
			}()
		}
	}()
	t.Cleanup(s.close)
	return s
}

func (s *standIn) close() {
	select {
	case <-s.done:
		return
	default:
	}
	close(s.done)
	_ = s.listener.Close()
	s.mu.Lock()
	for _, c := range s.conns {
		if c != nil {
			_ = c.Close()
		}
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *standIn) endpoint() Endpoint {
	return Endpoint{Host: "127.0.0.1", Port: s.listener.Addr().(*net.TCPAddr).Port}
}

// settled waits until the stand-in has seen every connection to it end (the client closed them).
func (s *standIn) settled() {
	s.t.Helper()
	for i := 0; i < 200; i++ {
		s.mu.Lock()
		open := 0
		for _, c := range s.conns {
			if c != nil {
				open++
			}
		}
		s.mu.Unlock()
		if open == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.t.Fatal("the stand-in's connections didn't end")
}

// requestLines are the sign-in's requests, by their first lines.
func (s *standIn) requestLines() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	lines := []string{}
	for _, head := range s.heard.requests {
		lines = append(lines, strings.SplitN(head, "\r\n", 2)[0])
	}
	return lines
}

// snapshot is what the stand-in has heard so far.
func (s *standIn) snapshot() heard {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.heard
	h.requests, h.why, h.got, h.pongs = slices.Clone(h.requests), slices.Clone(h.why), slices.Clone(h.got), slices.Clone(h.pongs)
	return h
}

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(b []byte) (int, error) { return f(b) }

func (s *standIn) serve(raw net.Conn) {
	defer func() {
		s.mu.Lock()
		for i, c := range s.conns {
			if c == raw {
				s.conns[i] = nil
			}
		}
		s.mu.Unlock()
	}()
	conn := tls.Server(raw, s.config)
	if err := conn.Handshake(); err != nil {
		return
	}
	in := bufio.NewReader(readerFunc(func(b []byte) (int, error) {
		n, err := conn.Read(b)
		s.mu.Lock()
		s.heard.afterTLS += n
		s.mu.Unlock()
		return n, err
	}))
	var wmu sync.Mutex
	send := func(b []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		if !s.trickle {
			_, err := conn.Write(b)
			return err
		}
		for i := range b {
			if _, err := conn.Write(b[i : i+1]); err != nil {
				return err
			}
		}
		return nil
	}

	// The sign-in: NTLM over HTTP, until the upgrade.
	challenge := challengeMessage()
	var negotiate []byte
	const page = "Access Denied"
	for upgraded := false; !upgraded; {
		head, err := readHead(in)
		if err != nil {
			return
		}
		s.mu.Lock()
		s.heard.requests = append(s.heard.requests, head)
		first := len(s.heard.requests) == 1
		s.mu.Unlock()
		if first && s.hold != nil {
			select {
			case <-s.hold:
			case <-s.done:
				return
			}
		}
		message, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(headerOf(head, "authorization"), "NTLM "))
		kind := uint32(0)
		if len(message) >= 12 {
			kind = binary.LittleEndian.Uint32(message[8:])
		}
		refused := "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM\r\nContent-Length: " + strconv.Itoa(len(page)) + "\r\n\r\n" + page
		switch kind {
		case 1:
			negotiate = message
			err = send([]byte("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nWWW-Authenticate: NTLM " + base64.StdEncoding.EncodeToString(challenge) +
				"\r\nContent-Length: " + strconv.Itoa(len(page)) + "\r\n\r\n" + page))
		case 3:
			s.mu.Lock()
			s.heard.ntlm = [3][]byte{negotiate, challenge, message}
			s.mu.Unlock()
			if why := disproof(negotiate, challenge, message, s.password, s.leaf, "127.0.0.1"); why != "" {
				s.mu.Lock()
				s.heard.why = append(s.heard.why, why)
				s.mu.Unlock()
				err = send([]byte(refused))
				break
			}
			err = send([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
				wsock.Accept(headerOf(head, "sec-websocket-key")) + "\r\n\r\n"))
			upgraded = true
		default:
			err = send([]byte(refused))
		}
		if err != nil {
			return
		}
	}

	// The tunnel: the client's frames (which must come masked), the packets inside them.
	var pending []byte
	for {
		f, err := wsock.ReadFrame(in, true, 1<<20)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				s.mu.Lock()
				s.heard.frameError = err
				s.mu.Unlock()
			}
			return
		}
		switch f.Opcode {
		case wsock.OpPong:
			s.mu.Lock()
			s.heard.pongs = append(s.heard.pongs, string(f.Payload))
			s.mu.Unlock()
		case wsock.OpClose:
			return
		case wsock.OpBinary, wsock.OpText, wsock.OpContinuation:
			pending = append(pending, f.Payload...)
			for len(pending) >= 8 {
				length := int(binary.LittleEndian.Uint32(pending[4:]))
				if length < 8 {
					return
				}
				if len(pending) < length {
					break
				}
				typ, body := binary.LittleEndian.Uint16(pending), bytes.Clone(pending[8:length])
				pending = pending[length:]
				if err := s.answer(typ, body, send); err != nil {
					return
				}
			}
		}
	}
}

func (s *standIn) answer(typ uint16, body []byte, send func([]byte) error) error {
	s.mu.Lock()
	s.heard.got = append(s.heard.got, typ)
	s.mu.Unlock()
	if typ == s.mute {
		return nil
	}
	status := binary.LittleEndian.AppendUint32(nil, s.refuse[typ])
	reply := func(t uint16, b []byte) error { return send(serverFrame(serverPacket(t, b))) }
	switch typ {
	case pktHandshakeRequest:
		// The error code, the version (1.0), the server's version, extended authentication.
		return reply(pktHandshakeResponse, append(status, 1, 0, 0, 0, 0, 0))
	case pktTunnelCreate:
		// The server's version, the status, the fields present, reserved.
		return reply(pktTunnelResponse, append(append([]byte{0, 0}, status...), 0, 0, 0, 0))
	case pktTunnelAuth:
		// Fields present, then the client's name: its length, then UTF-16.
		if len(body) >= 4 {
			n := int(binary.LittleEndian.Uint16(body[2:]))
			s.mu.Lock()
			s.heard.clientName = fromUTF16(body[4:min(len(body), 4+n)])
			s.mu.Unlock()
		}
		return reply(pktTunnelAuthResponse, append(status, 0, 0, 0, 0))
	case pktChannelCreate:
		// Resources (1), alternative names (1), the port, the protocol, then the resource's name: its length, UTF-16.
		if len(body) >= 8 {
			port, n := binary.LittleEndian.Uint16(body[2:]), int(binary.LittleEndian.Uint16(body[6:]))
			s.mu.Lock()
			s.heard.target = fmt.Sprintf("%s:%d", fromUTF16(body[8:min(len(body), 8+n)]), port)
			s.mu.Unlock()
		}
		if err := reply(pktChannelResponse, append(status, 0, 0, 0, 0)); err != nil {
			return err
		}
		if s.refuse[typ] == 0 && s.onChannel != nil {
			return s.onChannel(send)
		}
	case pktData:
		data := body[2:min(len(body), 2+int(binary.LittleEndian.Uint16(body)))]
		if string(data) == "close" {
			return reply(pktCloseChannel, make([]byte, 4))
		}
		frame := serverFrame(serverPacket(pktData, serverData(asciiUpper(data))))
		if err := send(frame[:5]); err != nil {
			return err
		}
		time.Sleep(2 * time.Millisecond)
		return send(frame[5:])
	}
	return nil
}

// ---- the client's side -------------------------------------------------------------------------------

var pcCorp = Endpoint{Host: "pc.corp", Port: 3389}

// trackedConn is the way to the gateway, which says whether it was closed.
type trackedConn struct {
	net.Conn
	closed atomic.Bool
}

func (c *trackedConn) Close() error {
	c.closed.Store(true)
	return c.Conn.Close()
}

// Hold the transport's close so cancellation and Open's error return can overlap deterministically.
type heldCloseConn struct {
	net.Conn
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *heldCloseConn) Close() error {
	var err error
	c.once.Do(func() {
		close(c.started)
		<-c.release
		err = c.Conn.Close()
	})
	return err
}

func dial(t *testing.T, at Endpoint) *trackedConn {
	t.Helper()
	raw, err := net.Dial("tcp", at.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	return &trackedConn{Conn: raw}
}

// client is what Open is given (an account, and a certificate check that takes the certificate unless refuse is set),
// and what it heard: the log, and the decisions it was asked for, in order.
type client struct {
	password string
	refuse   error

	mu      sync.Mutex
	lines   []string
	calls   []string
	checked []checked
}

type checked struct {
	chain   []*x509.Certificate
	chainOK bool
	reason  string
}

func (c *client) options() Options {
	return Options{
		Timeout: 5 * time.Second,
		Log: func(line string) {
			c.mu.Lock()
			c.lines = append(c.lines, line)
			c.mu.Unlock()
		},
		Roots: certs.ParseRoots(nil),
		CheckCertificate: func(_ context.Context, chain []*x509.Certificate, chainOK bool, reason string) error {
			c.mu.Lock()
			c.calls = append(c.calls, "certificate")
			c.checked = append(c.checked, checked{chain, chainOK, reason})
			c.mu.Unlock()
			return c.refuse
		},
		Account: func(context.Context) (ntlm.Account, error) {
			c.mu.Lock()
			c.calls = append(c.calls, "account")
			c.mu.Unlock()
			return ntlm.Account{Username: `CORP\alice`, Password: c.password}, nil
		},
	}
}

func (c *client) log() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.lines)
}

func (c *client) logged(line string) bool {
	for _, l := range c.log() {
		if l == line {
			return true
		}
	}
	return false
}

// eventually waits up to two seconds for ok.
func eventually(ok func() bool) bool {
	for i := 0; i < 200; i++ {
		if ok() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ok()
}

// readN reads exactly n bytes from the tunnel, however many packets they come in.
func readN(t *testing.T, r io.Reader, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		t.Fatalf("reading %d bytes: %v", n, err)
	}
	return string(b)
}

// ---- through the gateway -------------------------------------------------------------------------------

func TestThroughTheGatewaySignedInWithNTLMAChannelAndDataBothWays(t *testing.T) {
	gateway := newStandIn(t, "Secret1", nil)
	c := &client{password: "Secret1"}
	// The desktop's setting up ends with Open; the tunnel lasts past it.
	ctx, cancel := context.WithCancel(context.Background())
	tunnel, err := Open(ctx, dial(t, gateway.endpoint()), gateway.endpoint(), pcCorp, c.options())
	cancel()
	if err != nil {
		t.Fatal(err, gateway.snapshot().why)
	}
	defer tunnel.Close()
	seen := gateway.snapshot()
	// Two requests: the NTLM negotiation, and its answer to the challenge, which the stand-in took (it checked the
	// proof, the binding to its certificate, the service's name and the integrity code).
	if lines := gateway.requestLines(); len(lines) != 2 || lines[0] != "RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1" || lines[1] != lines[0] {
		t.Fatalf("the sign-in's requests: %q", lines)
	}
	if len(seen.why) != 0 {
		t.Fatalf("the stand-in refused: %q", seen.why)
	}
	// Those checks bite: the same sign-in, made over a connection with another certificate, or for another service,
	// isn't taken.
	other := selfSigned(t, gateway.config.Certificates[0].PrivateKey.(crypto.Signer), x509.ECDSAWithSHA256)
	if why := disproof(seen.ntlm[0], seen.ntlm[1], seen.ntlm[2], "Secret1", other, "127.0.0.1"); why != "the channel binding" {
		t.Errorf("over another connection: %q", why)
	}
	if why := disproof(seen.ntlm[0], seen.ntlm[1], seen.ntlm[2], "Secret1", gateway.leaf, "gw.example"); why != "the target name HTTP/127.0.0.1" {
		t.Errorf("for another service: %q", why)
	}
	id := regexp.MustCompile(`^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$`)
	for _, head := range seen.requests {
		for header, want := range map[string]string{"host": gateway.endpoint().String(), "upgrade": "websocket", "connection": "Upgrade", "sec-websocket-version": "13"} {
			if got := headerOf(head, header); got != want {
				t.Errorf("%s: %q, want %q", header, got, want)
			}
		}
		if !id.MatchString(headerOf(head, "rdg-connection-id")) || headerOf(head, "rdg-connection-id") != headerOf(seen.requests[0], "rdg-connection-id") {
			t.Errorf("the connection's id: %q", headerOf(head, "rdg-connection-id"))
		}
	}
	// The tunnel's packets, in order: the channel to the target, from a computer named as the default names it.
	if fmt.Sprint(seen.got) != fmt.Sprint([]uint16{pktHandshakeRequest, pktTunnelCreate, pktTunnelAuth, pktChannelCreate}) {
		t.Errorf("the packets: %v", seen.got)
	}
	if seen.target != "pc.corp:3389" || seen.clientName != "tabby-rdp" {
		t.Errorf("a channel to %q from %q", seen.target, seen.clientName)
	}
	// The certificate decided on once, before the account was asked for; self-signed, so not valid by any authority.
	c.mu.Lock()
	calls, checks := slices.Clone(c.calls), slices.Clone(c.checked)
	c.mu.Unlock()
	if fmt.Sprint(calls) != "[certificate account]" {
		t.Errorf("the decisions asked for: %v", calls)
	}
	if len(checks) != 1 || len(checks[0].chain) != 1 || !bytes.Equal(checks[0].chain[0].Raw, gateway.leaf.Raw) || checks[0].chainOK ||
		checks[0].reason != "DEPTH_ZERO_SELF_SIGNED_CERT" {
		t.Errorf("the certificate check: %+v", checks)
	}
	if !c.logged("gateway: signed in to 127.0.0.1") || !c.logged("gateway: channel to pc.corp:3389 through 127.0.0.1") {
		t.Errorf("the log: %q", c.log())
	}

	// Data both ways, as small as a word and more than a packet's worth, which goes in several and comes back in order.
	if _, err := tunnel.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, tunnel, 5); got != "HELLO" {
		t.Fatalf("read %q", got)
	}
	big := bytes.Repeat([]byte{'a'}, 100000)
	written := make(chan error, 1)
	go func() {
		_, err := tunnel.Write(big)
		written <- err
	}()
	if got := readN(t, tunnel, len(big)); got != strings.Repeat("A", len(big)) {
		t.Fatal("more than a packet's worth came back otherwise")
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if got := gateway.snapshot().got; len(got) != 4+1+4 {
		t.Errorf("%d data packets for 5 and 100000 bytes, want 5", len(got)-4)
	}
	// Closing this side's half: the gateway hears the channel close.
	if err := tunnel.(*Tunnel).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if !eventually(func() bool { got := gateway.snapshot().got; return got[len(got)-1] == pktCloseChannel }) {
		t.Error("the channel's close didn't reach the gateway")
	}
	if err := gateway.snapshot().frameError; err != nil {
		t.Error("a frame of the client's:", err)
	}
}

func TestAnswersThatComeAByteAtATimeAreReadAllTheSame(t *testing.T) {
	// The sign-in's answers and the tunnel's packets, each byte a TLS record of its own.
	gateway := newStandIn(t, "Secret1", func(s *standIn) { s.trickle = true })
	c := &client{password: "Secret1"}
	options := c.options()
	options.ClientName = "office-laptop"
	tunnel, err := Open(context.Background(), dial(t, gateway.endpoint()), gateway.endpoint(), pcCorp, options)
	if err != nil {
		t.Fatal(err)
	}
	defer tunnel.Close()
	if _, err := tunnel.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, tunnel, 2); got != "HI" {
		t.Fatalf("read %q", got)
	}
	if name := gateway.snapshot().clientName; name != "office-laptop" {
		t.Errorf("the client's name: %q", name)
	}
}

func TestTheCertificateIsCheckedAgainstTheAuthoritiesGiven(t *testing.T) {
	// The stand-in's certificate among the authorities: valid, and no reason against it.
	gateway := newStandIn(t, "Secret1", nil)
	c := &client{password: "Secret1"}
	options := c.options()
	options.Roots = &certs.Roots{Pool: x509.NewCertPool(), Certs: []*x509.Certificate{gateway.leaf}}
	options.Roots.Pool.AddCert(gateway.leaf)
	tunnel, err := Open(context.Background(), dial(t, gateway.endpoint()), gateway.endpoint(), pcCorp, options)
	if err != nil {
		t.Fatal(err)
	}
	tunnel.Close()
	if len(c.checked) != 1 || !c.checked[0].chainOK || c.checked[0].reason != "" {
		t.Errorf("the certificate check: %+v", c.checked)
	}
}

func TestARefusedCertificateSendsNothingOfTheAccount(t *testing.T) {
	gateway := newStandIn(t, "Secret1", nil)
	refusal := errors.New("not the certificate remembered")
	c := &client{password: "Secret1", refuse: refusal}
	raw := dial(t, gateway.endpoint())
	_, err := Open(context.Background(), raw, gateway.endpoint(), pcCorp, c.options())
	if !errors.Is(err, refusal) {
		t.Fatal(err)
	}
	if fmt.Sprint(c.calls) != "[certificate]" {
		t.Errorf("the decisions asked for: %v (the account isn't, after a refusal)", c.calls)
	}
	if !raw.closed.Load() {
		t.Error("the connection to the gateway was left open")
	}
	gateway.settled()
	if seen := gateway.snapshot(); len(seen.requests) != 0 || seen.afterTLS != 0 {
		t.Errorf("after TLS, the gateway got %d bytes: %q", seen.afterTLS, seen.requests)
	}
}

func TestAWrongPasswordIsARefusedSignIn(t *testing.T) {
	gateway := newStandIn(t, "Secret1", nil)
	raw := dial(t, gateway.endpoint())
	_, err := Open(context.Background(), raw, gateway.endpoint(), pcCorp, (&client{password: "wrong"}).options())
	var signIn *SignInError
	if !errors.As(err, &signIn) || signIn.Message != "The gateway refused the sign-in." || signIn.ErrorCode() != "signIn" {
		t.Fatalf("%T %v", err, err)
	}
	if why := gateway.snapshot().why; fmt.Sprint(why) != "[the proof]" {
		t.Errorf("the stand-in refused it for %q", why)
	}
	if !raw.closed.Load() {
		t.Error("the connection to the gateway was left open")
	}
}

func TestTheGatewaysPolicies(t *testing.T) {
	for _, c := range []struct {
		step    uint16
		code    uint32
		target  Endpoint
		message string
		signIn  bool
		logged  string
	}{
		// A target the account may not reach (its resource authorization policy): the target's, not the account's.
		{pktChannelCreate, 0x800759da, Endpoint{"secret.corp", 3389}, "the gateway doesn't let this account connect to secret.corp:3389 (its resource authorization policy)", false, "gateway: the channel refused: 0x800759da"},
		{pktChannelCreate, 0x59dd, Endpoint{"off.corp", 3389}, "the gateway couldn't reach off.corp:3389", false, "gateway: the channel refused: 0x59dd"},
		// An account it won't let in at all (its connection authorization policy): a refused sign-in, in a sentence.
		{pktTunnelAuth, 0x800759db, pcCorp, "The gateway doesn't let this account connect (its connection authorization policy).", true, "gateway: the authorization refused: 0x800759db"},
		{pktTunnelAuth, 0x59ed, pcCorp, "The gateway doesn't let this account connect (its connection authorization policy).", true, "gateway: the authorization refused: 0x59ed"},
		{pktTunnelCreate, 0x59e6, pcCorp, "the gateway has no connections left to give", false, "gateway: the tunnel refused: 0x59e6"},
		{pktHandshakeRequest, 0x59ee, pcCorp, "the gateway has no certificate set up", false, "gateway: the handshake refused: 0x59ee"},
		{pktTunnelCreate, 0x1234, pcCorp, "the gateway refused the connection (0x1234)", false, "gateway: the tunnel refused: 0x1234"},
	} {
		gateway := newStandIn(t, "Secret1", func(s *standIn) { s.refuse = map[uint16]uint32{c.step: c.code} })
		cl := &client{password: "Secret1"}
		raw := dial(t, gateway.endpoint())
		_, err := Open(context.Background(), raw, gateway.endpoint(), c.target, cl.options())
		var signIn *SignInError
		if err == nil || err.Error() != c.message || errors.As(err, &signIn) != c.signIn {
			t.Errorf("%#x: %T %v", c.code, err, err)
		}
		if !cl.logged(c.logged) {
			t.Errorf("%#x: the log: %q", c.code, cl.log())
		}
		if !raw.closed.Load() {
			t.Errorf("%#x: the connection to the gateway was left open", c.code)
		}
	}
}

func TestAGatewaysPingIsAnsweredWithAPongThroughTheTunnel(t *testing.T) {
	gateway := newStandIn(t, "Secret1", func(s *standIn) {
		s.onChannel = func(send func([]byte) error) error {
			return send(wsock.AppendFrame(nil, wsock.OpPing, []byte("hello"), false))
		}
	})
	tunnel, err := Open(context.Background(), dial(t, gateway.endpoint()), gateway.endpoint(), pcCorp, (&client{password: "Secret1"}).options())
	if err != nil {
		t.Fatal(err)
	}
	defer tunnel.Close()
	if _, err := tunnel.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, tunnel, 2); got != "HI" {
		t.Fatalf("read %q", got)
	}
	// Masked, as a client's frames are: the stand-in reads them as a server does, and takes no other.
	if !eventually(func() bool { return len(gateway.snapshot().pongs) == 1 }) || gateway.snapshot().pongs[0] != "hello" {
		t.Fatalf("the pongs: %q (%v)", gateway.snapshot().pongs, gateway.snapshot().frameError)
	}
}

// holdingConn is the way to the gateway, which stops taking writes while hold is set (the gateway's reading stopped):
// the one being written waits.
type holdingConn struct {
	net.Conn
	mu      sync.Mutex
	cond    *sync.Cond
	hold    bool
	waiting int // writes waiting now
	most    int // most writes waiting at once
	held    int // writes held, in all
}

func (h *holdingConn) Write(b []byte) (int, error) {
	h.mu.Lock()
	if h.hold {
		h.held++
		h.waiting++
		h.most = max(h.most, h.waiting)
		for h.hold {
			h.cond.Wait()
		}
		h.waiting--
	}
	h.mu.Unlock()
	return h.Conn.Write(b)
}

func (h *holdingConn) state() (waiting, most, held int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.waiting, h.most, h.held
}

func TestAGatewayThatSendsPingsAndReadsNothingGetsOnePongAtATime(t *testing.T) {
	// A gateway that sends pings and doesn't read what comes back can't have the pongs pile up here: one waits to go
	// out, and reading waits with it, as a TCP connection's writer waits for a reader that doesn't read.
	pings := make([][]byte, 0, 1001)
	for i := 0; i < 1000; i++ {
		pings = append(pings, wsock.AppendFrame(nil, wsock.OpPing, []byte("ping "+strconv.Itoa(i)), false))
	}
	pings = append(pings, serverFrame(serverPacket(pktData, serverData([]byte("read")))))
	gateway := newStandIn(t, "Secret1", func(s *standIn) {
		s.onChannel = func(send func([]byte) error) error { return send(bytes.Join(pings, nil)) }
	})
	raw := &holdingConn{Conn: dial(t, gateway.endpoint())}
	raw.cond = sync.NewCond(&raw.mu)
	tunnel, err := Open(context.Background(), raw, gateway.endpoint(), pcCorp, (&client{password: "Secret1"}).options())
	if err != nil {
		t.Fatal(err)
	}
	defer tunnel.Close()
	raw.mu.Lock()
	raw.hold = true
	raw.mu.Unlock()
	read := make(chan string, 1)
	go func() {
		b := make([]byte, 4)
		_, err := io.ReadFull(tunnel, b)
		read <- fmt.Sprintf("%s %v", b, err)
	}()
	if !eventually(func() bool { waiting, _, _ := raw.state(); return waiting == 1 }) {
		t.Fatal("no pong went out")
	}
	time.Sleep(100 * time.Millisecond)
	if _, most, held := raw.state(); most != 1 || held != 1 {
		t.Fatalf("%d pongs waited at once, %d in all", most, held)
	}
	select {
	case got := <-read:
		t.Fatalf("read %q while the pong waited", got)
	default:
	}
	// The gateway reads again: the pongs reach it, in order, and then the data.
	raw.mu.Lock()
	raw.hold = false
	raw.cond.Broadcast()
	raw.mu.Unlock()
	if got := <-read; got != "read <nil>" {
		t.Fatalf("read %q", got)
	}
	if _, err := tunnel.Write([]byte("last")); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, tunnel, 4); got != "LAST" {
		t.Fatalf("read %q", got)
	}
	if !eventually(func() bool { return len(gateway.snapshot().pongs) == 1000 }) {
		t.Fatalf("%d pongs", len(gateway.snapshot().pongs))
	}
	for i, pong := range gateway.snapshot().pongs {
		if pong != "ping "+strconv.Itoa(i) {
			t.Fatalf("pong %d: %q", i, pong)
		}
	}
}

func TestAGatewaysMessagesHoweverManyAreLoggedAFewAtMost(t *testing.T) {
	// Its administrator's message, two hundred thousand times over, with keepalives among them, once the channel is
	// up: each would be a line of the desktop's log, which a desktop keeps for as long as it is open.
	message := serverPacket(pktServiceMessage, append([]byte{2, 0}, utf16le("x")...))
	keepalive := serverPacket(pktKeepalive, nil)
	frame := serverFrame(bytes.Join([][]byte{bytes.Repeat(message, 100), keepalive, bytes.Repeat(message, 100), keepalive}, nil))
	flood := bytes.Repeat(frame, 1000)
	gateway := newStandIn(t, "Secret1", func(s *standIn) {
		s.onChannel = func(send func([]byte) error) error { return send(flood) }
	})
	c := &client{password: "Secret1"}
	tunnel, err := Open(context.Background(), dial(t, gateway.endpoint()), gateway.endpoint(), pcCorp, c.options())
	if err != nil {
		t.Fatal(err)
	}
	defer tunnel.Close()
	if _, err := tunnel.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, tunnel, 2); got != "HI" {
		t.Fatalf("read %q", got)
	}
	var messages []string
	for _, line := range c.log() {
		if strings.Contains(line, "administrator") {
			messages = append(messages, line)
		}
	}
	if len(messages) != 11 || messages[0] != "gateway: its administrator's message: x" ||
		messages[10] != "gateway: more messages from its administrator; past 10, they aren't logged" {
		t.Fatalf("%d lines: %q", len(messages), messages[min(len(messages), 9):])
	}
}

func TestAServiceMessageAsLongAsAPacketIsLoggedInPart(t *testing.T) {
	// Its text, then NULs to the end of the packet and one other character; and one of 400 characters with no end:
	// the first 300 of those.
	long := make([]byte, maxPacket-8)
	copy(long[2:], utf16le("Maintenance tonight"))
	copy(long[len(long)-2:], utf16le("x"))
	unended := append([]byte{0x20, 0x03}, utf16le(strings.Repeat("M", 400))...)
	gateway := newStandIn(t, "Secret1", func(s *standIn) {
		s.onChannel = func(send func([]byte) error) error {
			return send(append(serverFrame(serverPacket(pktServiceMessage, long)), serverFrame(serverPacket(pktServiceMessage, unended))...))
		}
	})
	c := &client{password: "Secret1"}
	tunnel, err := Open(context.Background(), dial(t, gateway.endpoint()), gateway.endpoint(), pcCorp, c.options())
	if err != nil {
		t.Fatal(err)
	}
	defer tunnel.Close()
	if _, err := tunnel.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, tunnel, 2); got != "HI" {
		t.Fatalf("read %q", got)
	}
	if !c.logged("gateway: its administrator's message: Maintenance tonight") ||
		!c.logged("gateway: its administrator's message: "+strings.Repeat("M", 300)) {
		t.Fatalf("the log: %q", c.log())
	}
}

func TestTheGatewayClosingTheChannelIsTheEnd(t *testing.T) {
	gateway := newStandIn(t, "Secret1", nil)
	tunnel, err := Open(context.Background(), dial(t, gateway.endpoint()), gateway.endpoint(), pcCorp, (&client{password: "Secret1"}).options())
	if err != nil {
		t.Fatal(err)
	}
	defer tunnel.Close()
	// The stand-in closes the channel when it is sent "close": the server has gone. Read ends, and stays ended; the
	// gateway is answered.
	if _, err := tunnel.Write([]byte("close")); err != nil {
		t.Fatal(err)
	}
	if n, err := tunnel.Read(make([]byte, 16)); n != 0 || err != io.EOF {
		t.Fatalf("read %d, %v", n, err)
	}
	if n, err := tunnel.Read(make([]byte, 16)); n != 0 || err != io.EOF {
		t.Fatalf("then read %d, %v", n, err)
	}
	if !eventually(func() bool { got := gateway.snapshot().got; return got[len(got)-1] == pktCloseChannelResonse }) {
		t.Fatalf("the close wasn't answered: %v", gateway.snapshot().got)
	}
}

// endless is a gateway that answers each request of the sign-in with the next of answers ({challenge}: its NTLM
// challenge; {accept}: the request's WebSocket accept), and after the last sends filler for as long as the connection
// lasts; with none, it answers nothing. An answer that ends in {close} is followed by the connection's end instead.
func endless(t *testing.T, answers ...string) Endpoint {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	config, _ := serverTLS(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var conns []net.Conn
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, raw)
			mu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer raw.Close()
				conn := tls.Server(raw, config)
				in := bufio.NewReader(conn)
				for _, answer := range answers {
					head, err := readHead(in)
					if err != nil {
						return
					}
					answer = strings.ReplaceAll(answer, "{challenge}", base64.StdEncoding.EncodeToString(challengeMessage()))
					answer = strings.ReplaceAll(answer, "{accept}", wsock.Accept(headerOf(head, "sec-websocket-key")))
					answer, closing := strings.CutSuffix(answer, "{close}")
					if _, err := io.WriteString(conn, answer); err != nil || closing {
						_ = conn.Close()
						return
					}
				}
				if len(answers) == 0 {
					_, _ = io.Copy(io.Discard, in)
					return
				}
				filler := bytes.Repeat([]byte{'A'}, 64<<10)
				for {
					if _, err := conn.Write(filler); err != nil {
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		mu.Lock()
		for _, c := range conns {
			_ = c.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	return Endpoint{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port}
}

const challenged = "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM {challenge}\r\nContent-Length: 0\r\n\r\n"

// failsAtOnce opens a tunnel through the gateway at at (whose step time is five seconds), and says how it failed; it
// has to within a second or two, and close the connection to the gateway.
func failsAtOnce(t *testing.T, at Endpoint) error {
	t.Helper()
	raw := dial(t, at)
	started := time.Now()
	_, err := Open(context.Background(), raw, at, pcCorp, (&client{password: "x"}).options())
	if took := time.Since(started); took > 2500*time.Millisecond {
		t.Errorf("took %v", took)
	}
	if err == nil {
		t.Fatal("opened")
	}
	if !raw.closed.Load() {
		t.Error("the connection to the gateway was left open")
	}
	return err
}

func TestAnOldGatewaysAnswerSaysSoAtOnceHoweverLongItSaysItIs(t *testing.T) {
	// Its HTTP transport's answer: a 200 that goes on for a gigabyte.
	at := endless(t, challenged, "HTTP/1.1 200 OK\r\nContent-Length: 1073741824\r\n\r\n")
	if err := failsAtOnce(t, at); !strings.Contains(err.Error(), "doesn't take WebSocket connections") {
		t.Fatal(err)
	}
}

func TestAnAnswerWhoseLengthIsntOneOrIsMoreThanAnErrorPagesIsRefusedAtOnce(t *testing.T) {
	for _, length := range []string{"99999999999", "abc", "-1", "1e3", "0x10", strconv.Itoa(1024 * 1024)} {
		at := endless(t, "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM\r\nContent-Length: "+length+"\r\n\r\n")
		if err := failsAtOnce(t, at); !strings.Contains(err.Error(), "malformed or too large") {
			t.Errorf("%s: %v", length, err)
		}
	}
}

func TestAHeaderLineWithACROrLFOfItsOwnIsRefusedAtOnce(t *testing.T) {
	for _, stray := range []string{"\n", "\r"} {
		at := endless(t, "HTTP/1.1 401 Unauthorized\r\nX:"+strings.Repeat(" ", 60000)+"a"+stray+"b\r\nContent-Length: 0\r\n\r\n")
		if err := failsAtOnce(t, at); !strings.Contains(err.Error(), "isn't HTTP") {
			t.Errorf("%q: %v", stray, err)
		}
	}
}

func TestAHeadersValueIsTrimmedAndALineThatIsntAHeaderIsPassedOver(t *testing.T) {
	// The sign-in goes on with the challenge, however many spaces are around it; the line without a name is ignored.
	pad := strings.Repeat(" ", 30000)
	at := endless(t, "HTTP/1.1 401 Unauthorized\r\n: no name\r\nWWW-Authenticate:"+pad+"NTLM {challenge}"+pad+"\r\nContent-Length: 0\r\n\r\n",
		"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
	var signIn *SignInError
	if err := failsAtOnce(t, at); !errors.As(err, &signIn) {
		t.Fatalf("%T %v", err, err)
	}
}

func TestOtherAnswersToTheSignIn(t *testing.T) {
	for _, c := range []struct {
		answers []string
		want    string
	}{
		{[]string{"HTTP/1.1 101 Switching Protocols\r\n\r\n"}, "the gateway let the connection in without a sign-in"},
		{[]string{"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nWWW-Authenticate: Basic realm=\"gw\"\r\nContent-Length: 0\r\n\r\n"},
			"the gateway doesn't offer an NTLM sign-in (it offers: Negotiate, Basic)"},
		{[]string{"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"}, "the gateway doesn't offer an NTLM sign-in (it offers: nothing)"},
		{[]string{"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ntlm\r\nContent-Length: 0\r\n\r\n"}, "the gateway didn't take up the NTLM sign-in"},
		{[]string{"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n"}, "the gateway answered 503 to the sign-in"},
		{[]string{challenged, "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n"}, "the gateway answered 500 after the sign-in"},
		{[]string{challenged, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: AAAA\r\n\r\n"},
			"the gateway's WebSocket answer doesn't match the request"},
		{[]string{"SSH-2.0-OpenSSH_9.9\r\n\r\n"}, "the gateway's answer isn't HTTP"},
		// Half an answer (its head, or its page), then the connection's end.
		{[]string{"HTTP/1.1 401 Unauth{close}"}, "the gateway closed the connection"},
		{[]string{"HTTP/1.1 401 Unauthorized\r\nContent-Length: 100\r\n\r\nAccess{close}"}, "the gateway closed the connection"},
	} {
		at := endless(t, c.answers...)
		if err := failsAtOnce(t, at); err.Error() != c.want {
			t.Errorf("%q: %v", c.answers[len(c.answers)-1], err)
		}
	}
}

// silent is a server that takes connections and never says anything.
func silent(t *testing.T) Endpoint {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, conn)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		mu.Lock()
		for _, c := range conns {
			_ = c.Close()
		}
		mu.Unlock()
	})
	return Endpoint{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port}
}

func TestAGatewayThatTakesTheConnectionAndNeverAnswersIsGivenUpOn(t *testing.T) {
	opts := (&client{password: "x"}).options()
	opts.Timeout = 300 * time.Millisecond
	try := func(at Endpoint) error {
		raw := dial(t, at)
		started := time.Now()
		_, err := Open(context.Background(), raw, at, pcCorp, opts)
		if took := time.Since(started); took < 250*time.Millisecond || took > 2*time.Second {
			t.Errorf("took %v for a step of 300 ms", took)
		}
		if !raw.closed.Load() {
			t.Error("the connection to the gateway was left open")
		}
		return err
	}
	// At TLS: a step like the others, or the connection would be kept for good.
	if err := try(silent(t)); err == nil || err.Error() != "the gateway didn't answer in time (TLS)" {
		t.Error("TLS:", err)
	}
	// At the sign-in, and in the tunnel.
	if err := try(endless(t)); err == nil || err.Error() != "the gateway didn't answer in time" {
		t.Error("the sign-in:", err)
	}
	gateway := newStandIn(t, "x", func(s *standIn) { s.mute = pktTunnelCreate })
	if err := try(gateway.endpoint()); err == nil || err.Error() != "the gateway didn't answer in time (tunnel)" {
		t.Error("the tunnel:", err)
	}
}

func TestADesktopClosedDuringTheSetUpEndsIt(t *testing.T) {
	const closed = "the desktop was closed meanwhile"
	// While its certificate is being decided on: nothing of the sign-in is sent.
	t.Run("the certificate", func(t *testing.T) {
		gateway := newStandIn(t, "Secret1", nil)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		opts := (&client{password: "Secret1"}).options()
		opts.CheckCertificate = func(context.Context, []*x509.Certificate, bool, string) error {
			cancel()
			time.Sleep(20 * time.Millisecond)
			return nil
		}
		raw := dial(t, gateway.endpoint())
		if _, err := Open(ctx, raw, gateway.endpoint(), pcCorp, opts); err == nil || err.Error() != closed {
			t.Fatal(err)
		}
		if !raw.closed.Load() {
			t.Error("the connection to the gateway was left open")
		}
		gateway.settled()
		if seen := gateway.snapshot(); len(seen.requests) != 0 || seen.afterTLS != 0 {
			t.Errorf("after TLS, the gateway got %d bytes: %q", seen.afterTLS, seen.requests)
		}
	})
	// After the first message of the sign-in, while the gateway's answer is awaited: the second isn't sent.
	t.Run("the sign-in", func(t *testing.T) {
		hold := make(chan struct{})
		gateway := newStandIn(t, "Secret1", func(s *standIn) { s.hold = hold })
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		raw := dial(t, gateway.endpoint())
		failed := make(chan error, 1)
		go func() {
			_, err := Open(ctx, raw, gateway.endpoint(), pcCorp, (&client{password: "Secret1"}).options())
			failed <- err
		}()
		if !eventually(func() bool { return len(gateway.requestLines()) == 1 }) {
			t.Fatal("no sign-in came")
		}
		cancel()
		select {
		case err := <-failed:
			if err == nil || err.Error() != closed {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("the sign-in went on")
		}
		close(hold)
		time.Sleep(300 * time.Millisecond)
		if lines := gateway.requestLines(); len(lines) != 1 {
			t.Errorf("%d requests", len(lines))
		}
		if !raw.closed.Load() {
			t.Error("the connection to the gateway was left open")
		}
	})
	// While the tunnel is being set up, from a gateway that doesn't answer: ended at once, not after the step's time.
	t.Run("the tunnel", func(t *testing.T) {
		gateway := newStandIn(t, "Secret1", func(s *standIn) { s.mute = pktTunnelCreate })
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		raw := dial(t, gateway.endpoint())
		failed := make(chan error, 1)
		go func() {
			_, err := Open(ctx, raw, gateway.endpoint(), pcCorp, (&client{password: "Secret1"}).options())
			failed <- err
		}()
		if !eventually(func() bool { got := gateway.snapshot().got; return len(got) > 0 && got[len(got)-1] == pktTunnelCreate }) {
			t.Fatal("no tunnel was asked for")
		}
		cancel()
		select {
		case err := <-failed:
			if err == nil || err.Error() != closed {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("the setting up went on")
		}
		if !raw.closed.Load() {
			t.Error("the connection to the gateway was left open")
		}
	})
	// While TLS is awaited, from a gateway that never answers: ended at once, not after the step's time.
	t.Run("TLS", func(t *testing.T) {
		at := silent(t)
		ctx, cancel := context.WithCancel(context.Background())
		raw := dial(t, at)
		time.AfterFunc(50*time.Millisecond, cancel)
		started := time.Now()
		if _, err := Open(ctx, raw, at, pcCorp, (&client{password: "x"}).options()); err == nil || err.Error() != closed {
			t.Fatal(err)
		}
		if took := time.Since(started); took > 2*time.Second {
			t.Errorf("took %v", took)
		}
		if !raw.closed.Load() {
			t.Error("the connection to the gateway was left open")
		}
	})
	// A desktop closed before it began.
	t.Run("before", func(t *testing.T) {
		gateway := newStandIn(t, "Secret1", nil)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		c := &client{password: "Secret1"}
		raw := dial(t, gateway.endpoint())
		if _, err := Open(ctx, raw, gateway.endpoint(), pcCorp, c.options()); err == nil || err.Error() != closed {
			t.Fatal(err)
		}
		if len(c.calls) != 0 || !raw.closed.Load() {
			t.Errorf("asked for %v; closed %v", c.calls, raw.closed.Load())
		}
	})
}

func TestCancelledSetupWaitsForTheTransportToClose(t *testing.T) {
	gateway := newStandIn(t, "Secret1", nil)
	raw := dial(t, gateway.endpoint())
	held := &heldCloseConn{Conn: raw, started: make(chan struct{}), release: make(chan struct{})}
	release := sync.OnceFunc(func() { close(held.release) })
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	opts := (&client{password: "Secret1"}).options()
	decision := errors.New("certificate decision cancelled")
	opts.CheckCertificate = func(context.Context, []*x509.Certificate, bool, string) error {
		cancel()
		<-held.started
		return decision
	}
	failed := make(chan error, 1)
	go func() {
		_, err := Open(ctx, held, gateway.endpoint(), pcCorp, opts)
		failed <- err
	}()
	select {
	case <-held.started:
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation did not close the transport")
	}
	select {
	case err := <-failed:
		t.Fatalf("setup returned before the transport closed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	release()
	select {
	case err := <-failed:
		if !errors.Is(err, decision) || !raw.closed.Load() {
			t.Fatalf("error %v, transport closed %v", err, raw.closed.Load())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("setup did not finish after the transport closed")
	}
}

// ---- the parts -----------------------------------------------------------------------------------------

// tunnelOver is a tunnel reading the gateway's side from r, for what needs no writing back (no pings, no closed
// channel).
func tunnelOver(r io.Reader) *Tunnel {
	return &Tunnel{in: bufio.NewReader(r), log: func(string) {}}
}

func TestPacketsComeOutWholeHoweverTheBytesArrive(t *testing.T) {
	stream := bytes.Join([][]byte{
		serverPacket(pktKeepalive, nil),
		serverPacket(pktData, serverData([]byte("hi"))),
		serverPacket(pktServiceMessage, append([]byte{2, 0}, utf16le("x")...)),
		serverPacket(pktData, serverData(nil)),
		serverPacket(pktData, serverData([]byte(" there"))),
	}, nil)
	read := func(frames []byte) string {
		b, err := io.ReadAll(tunnelOver(bytes.NewReader(frames)))
		if err != nil && err != io.ErrUnexpectedEOF {
			return err.Error()
		}
		return string(b)
	}
	// Each byte a frame of its own.
	var bytewise []byte
	for _, b := range stream {
		bytewise = append(bytewise, serverFrame([]byte{b})...)
	}
	if got := read(bytewise); got != "hi there" {
		t.Fatalf("a byte per frame: %q", got)
	}
	// All of them in one frame; in two frames, cut anywhere; in fragments of a message (continuations), masked too.
	if got := read(serverFrame(stream)); got != "hi there" {
		t.Fatalf("in one frame: %q", got)
	}
	for cut := 0; cut <= len(stream); cut++ {
		if got := read(append(serverFrame(stream[:cut]), serverFrame(stream[cut:])...)); got != "hi there" {
			t.Fatalf("cut at %d: %q", cut, got)
		}
	}
	fragments := append(append([]byte{0x02, 5}, stream[:5]...), wsock.AppendFrame(nil, wsock.OpContinuation, stream[5:], true)...)
	if got := read(fragments); got != "hi there" {
		t.Fatalf("in fragments: %q", got)
	}
	// A pong of the gateway's own (unasked) is passed over.
	if got := read(append(wsock.AppendFrame(nil, wsock.OpPong, []byte("hm"), false), serverFrame(stream)...)); got != "hi there" {
		t.Fatalf("after a pong: %q", got)
	}
	// A close frame is the end, whatever comes after it.
	if got := read(append(append(serverFrame(stream), wsock.AppendFrame(nil, wsock.OpClose, nil, false)...), serverFrame(stream)...)); got != "hi there" {
		t.Fatalf("after a close: %q", got)
	}
}

func TestPacketsThatCantBeTheGatewaysAreRefused(t *testing.T) {
	for name, c := range map[string]struct {
		frames []byte
		want   string
	}{
		"a packet of 2 GiB":                {serverFrame([]byte{0x0a, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f}), "a gateway packet of 2147483647 bytes"},
		"a packet past 256 KiB":            {serverFrame(serverPacket(pktData, make([]byte, maxPacket-7))), fmt.Sprintf("a gateway packet of %d bytes", maxPacket+1)},
		"a packet shorter than its header": {serverFrame([]byte{0x0a, 0, 0, 0, 4, 0, 0, 0}), "a gateway packet of 4 bytes"},
		"a frame of 2 MiB":                 {[]byte{0x82, 127, 0, 0, 0, 0, 0, 0x20, 0, 0}, "a WebSocket frame too large to be the gateway's"},
		"a frame with reserved bits":       {[]byte{0xc2, 0}, "reserved bits"},
	} {
		if _, _, err := tunnelOver(bytes.NewReader(c.frames)).packet(); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A packet of 256 KiB is one.
	if typ, body, err := tunnelOver(bytes.NewReader(serverFrame(serverPacket(pktData, make([]byte, maxPacket-8))))).packet(); err != nil || typ != pktData || len(body) != maxPacket-8 {
		t.Errorf("a packet of 256 KiB: %v", err)
	}
}

func TestAPacketThatComesAByteAtATimeCostsItsSizeInCopyingNotItsSquare(t *testing.T) {
	// A gateway can send one-byte frames (in one-byte TLS records), each its own read: put together by copying them
	// all again each time, a packet of 64 KiB would cost two gigabytes.
	const size = 64 * 1024
	whole := serverPacket(pktData, serverData(bytes.Repeat([]byte{'a'}, size-10)))
	var stream []byte
	for _, b := range whole {
		stream = append(stream, serverFrame([]byte{b})...)
	}
	tunnel := tunnelOver(bytes.NewReader(stream))
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	typ, body, err := tunnel.packet()
	runtime.ReadMemStats(&after)
	if err != nil || typ != pktData || !bytes.Equal(body, whole[8:]) {
		t.Fatalf("the packet: %v", err)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 128*size {
		t.Errorf("%d bytes allocated for a packet of %d", allocated, size)
	}
}

// paddedReads are count reads as a rogue gateway can make them, each 16 KiB of its own: a frame carrying one byte of
// a packet (the read's number), then pongs to fill the rest.
type paddedReads struct {
	count, next int
	current     []byte
}

func (p *paddedReads) Read(b []byte) (int, error) {
	if len(p.current) == 0 {
		if p.next == p.count {
			return 0, io.EOF
		}
		pong := wsock.AppendFrame(nil, wsock.OpPong, make([]byte, 125), false)
		p.current = append(serverFrame([]byte{byte(p.next)}), bytes.Repeat(pong, 128)...)
		p.next++
	}
	n := copy(b, p.current)
	p.current = p.current[n:]
	return n, nil
}

func TestAPacketPaddedWithPongsKeepsOnlyItsOwnBytes(t *testing.T) {
	// A rogue gateway leaves a packet unfinished: kept as they came, its bytes would keep the reads they came in,
	// 16 KiB each, 4 GiB for a packet's 256 KiB. Here a thousand of them.
	header := serverPacket(pktData, nil)
	binary.LittleEndian.PutUint32(header[4:], maxPacket)
	tunnel := &Tunnel{in: bufio.NewReaderSize(io.MultiReader(bytes.NewReader(serverFrame(header)), &paddedReads{count: 1024}), 16<<10), log: func(string) {}}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	if _, _, err := tunnel.packet(); err != io.EOF {
		t.Fatal("before the packet's end:", err)
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	if kept := int64(after.HeapAlloc) - int64(before.HeapAlloc); kept > 1<<20 {
		t.Errorf("%d bytes kept of the gateway's 16 MiB, for 1032 bytes of a packet", kept)
	}
	if len(tunnel.pending) != 8+1024 {
		t.Errorf("%d bytes of the packet kept", len(tunnel.pending))
	}
	// The packet is whole once the rest comes, those bytes in it.
	tunnel.in = bufio.NewReader(bytes.NewReader(serverFrame(make([]byte, maxPacket-8-1024))))
	typ, body, err := tunnel.packet()
	if err != nil || typ != pktData || len(body) != maxPacket-8 {
		t.Fatalf("the packet: %v", err)
	}
	for i := 0; i < 1024; i++ {
		if body[i] != byte(i) {
			t.Fatalf("byte %d of the packet: %d", i, body[i])
		}
	}
}

func TestServiceMessagesText(t *testing.T) {
	message := func(text string, after ...byte) []byte {
		return append(append(binary.LittleEndian.AppendUint16(nil, uint16(2*len(text))), utf16le(text)...), after...)
	}
	for _, c := range []struct {
		body []byte
		want string
	}{
		{message("Maintenance tonight"), "Maintenance tonight"},
		// Up to its terminator, whatever its length says and whatever follows.
		{message("Maintenance tonight", 0, 0, 'x', 0), "Maintenance tonight"},
		{message(strings.Repeat("é", 400)), strings.Repeat("é", 300)},
		{message("odd", 'x'), "odd"},
		{[]byte{1}, ""},
		{nil, ""},
	} {
		if got := serviceMessage(c.body); got != c.want {
			t.Errorf("%q: %q", c.body[:min(len(c.body), 20)], got)
		}
	}
}

func TestTheChannelBindingIsTheCertificateUnderItsSignaturesHashSHA256AtLeast(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, edKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sum256 := func(b []byte) []byte { s := sha256.Sum256(b); return s[:] }
	sum384 := func(b []byte) []byte { s := sha512.Sum384(b); return s[:] }
	sum512 := func(b []byte) []byte { s := sha512.Sum512(b); return s[:] }
	for _, c := range []struct {
		key  crypto.Signer
		alg  x509.SignatureAlgorithm
		hash func([]byte) []byte
	}{
		{rsaKey, x509.SHA256WithRSA, sum256},
		{rsaKey, x509.SHA384WithRSA, sum384},
		{rsaKey, x509.SHA512WithRSA, sum512},
		{rsaKey, x509.SHA256WithRSAPSS, sum256},
		{rsaKey, x509.SHA384WithRSAPSS, sum384},
		{rsaKey, x509.SHA512WithRSAPSS, sum512},
		{ecKey, x509.ECDSAWithSHA256, sum256},
		{ecKey, x509.ECDSAWithSHA384, sum384},
		{ecKey, x509.ECDSAWithSHA512, sum512},
		// SHA-1 (and MD5): SHA-256 in their place (RFC 5929, 4.1).
		{rsaKey, x509.SHA1WithRSA, sum256},
		{ecKey, x509.ECDSAWithSHA1, sum256},
		// No hash of its own (RFC 5929 leaves it undefined): SHA-256.
		{edKey, x509.PureEd25519, sum256},
	} {
		certificate := selfSigned(t, c.key, c.alg)
		if certificate.SignatureAlgorithm != c.alg {
			t.Fatalf("made with %v, read as %v", c.alg, certificate.SignatureAlgorithm)
		}
		want := append([]byte("tls-server-end-point:"), c.hash(certificate.Raw)...)
		if got := EndPointBinding(certificate); !bytes.Equal(got, want) {
			t.Errorf("signed with %v: %x", c.alg, got)
		}
	}
	// MD5, which Go no longer signs with: as a certificate signed so is read.
	md5Signed := *selfSigned(t, rsaKey, x509.SHA256WithRSA)
	md5Signed.SignatureAlgorithm = x509.MD5WithRSA
	if got := EndPointBinding(&md5Signed); !bytes.Equal(got, append([]byte("tls-server-end-point:"), sum256(md5Signed.Raw)...)) {
		t.Errorf("signed with MD5: %x", got)
	}
	// Not a certificate Go knows the signature of: still an answer (SHA-256), not a failure.
	if got := EndPointBinding(&x509.Certificate{Raw: []byte("nonsense")}); !bytes.Equal(got, append([]byte("tls-server-end-point:"), sum256([]byte("nonsense"))...)) {
		t.Errorf("an unknown signature: %x", got)
	}
}

func TestRefusalsInWords(t *testing.T) {
	for code, want := range map[uint32]string{
		0x800759da: "the gateway doesn't let this account connect to pc:3389 (its resource authorization policy)",
		0x59db:     "the gateway doesn't let this account connect (its connection authorization policy)",
		0x800759ed: "the gateway doesn't let this account connect (its connection authorization policy)",
		0x59dd:     "the gateway couldn't reach pc:3389",
		0x59e6:     "the gateway has no connections left to give",
		0x59e8:     "the gateway asks for a way of signing in that isn't supported here (a smart card or a sign-in page)",
		0x59e9:     "the gateway asks for a way of signing in that isn't supported here (a smart card or a sign-in page)",
		0x59f9:     "the gateway asks for a way of signing in that isn't supported here (a smart card or a sign-in page)",
		0x59ee:     "the gateway has no certificate set up",
		0x1234:     "the gateway refused the connection (0x1234)",
		0x80070005: "the gateway refused the connection (0x80070005)",
	} {
		if got := Refusal(code, "pc:3389"); got != want {
			t.Errorf("%#x: %q", code, got)
		}
	}
}

func TestPacketsAsTheProtocolLaysThemOut(t *testing.T) {
	for name, c := range map[string]struct{ got, want []byte }{
		// Type, reserved, length; then version 1.0, client version 0, no extended authentication.
		"handshake": {HandshakeRequest(), []byte{0x01, 0, 0, 0, 14, 0, 0, 0, 1, 0, 0, 0, 0, 0}},
		// The consent message capability; no fields, reserved.
		"tunnel": {TunnelCreate(), []byte{0x04, 0, 0, 0, 16, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0}},
		// No fields; the name's length in bytes (its terminator in it), the name.
		"authorization": {TunnelAuth("pc"), append([]byte{0x06, 0, 0, 0, 18, 0, 0, 0, 0, 0, 6, 0}, utf16le("pc\x00")...)},
		// One resource, no alternative names, the port, RDP over TCP; the name.
		"channel": {ChannelCreate("pc.corp", 3389), append([]byte{0x08, 0, 0, 0, 32, 0, 0, 0, 1, 0, 0x3d, 0x0d, 3, 0, 16, 0}, utf16le("pc.corp\x00")...)},
		"data":    {DataPacket([]byte("hi")), []byte{0x0a, 0, 0, 0, 12, 0, 0, 0, 2, 0, 'h', 'i'}},
	} {
		if !bytes.Equal(c.got, c.want) {
			t.Errorf("%s: % x", name, c.got)
		}
	}
}
