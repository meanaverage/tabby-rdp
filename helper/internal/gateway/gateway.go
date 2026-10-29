// Package gateway is a stream to an RDP server through a Remote Desktop Gateway ([MS-TSGU], its WebSocket transport,
// which Windows Server 2012 R2 and later speak): HTTPS to the gateway, signed in to with NTLM, then a tunnel and a
// channel to the server, and the RDP connection's bytes inside data packets. What comes out is a plain stream to the
// server, which the proxy uses like a TCP connection: X.224, TLS and the server's own sign-in go through it unchanged.
//
// Not here: the older RPC-over-HTTP transport, Kerberos, smart cards, pluggable authentication cookies and the UDP
// side channel. Ported from the plugin's former src/gateway.ts.
package gateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/meanaverage/tabby-rdp/helper/internal/certs"
	"github.com/meanaverage/tabby-rdp/helper/internal/ntlm"
	"github.com/meanaverage/tabby-rdp/helper/internal/wsock"
)

// Endpoint is a host and port.
type Endpoint struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

func (e Endpoint) String() string { return net.JoinHostPort(e.Host, strconv.Itoa(e.Port)) }

// SignInError: the gateway refused the account (its HTTP sign-in, or its connection authorization policy).
type SignInError struct{ Message string }

func (e *SignInError) Error() string     { return e.Message }
func (e *SignInError) ErrorCode() string { return "signIn" }

// ---- packets ([MS-TSGU] 2.2.10) ----------------------------------------------------------------------

const (
	pktHandshakeRequest    = 0x01
	pktHandshakeResponse   = 0x02
	pktTunnelCreate        = 0x04
	pktTunnelResponse      = 0x05
	pktTunnelAuth          = 0x06
	pktTunnelAuthResponse  = 0x07
	pktChannelCreate       = 0x08
	pktChannelResponse     = 0x09
	pktData                = 0x0a
	pktServiceMessage      = 0x0b
	pktKeepalive           = 0x0d
	pktCloseChannel        = 0x10
	pktCloseChannelResonse = 0x11
)

// This client shows (that is: logs) a consent message the gateway has for its users.
const capabilityMessagingConsentSign = 0x4

// maxData is a packet's largest payload: a 16-bit length, kept well under it.
const maxData = 32 * 1024

// maxPacket is what an incoming packet may be at most (a data packet's 64 KiB, and room for a certificate in the
// tunnel response).
const maxPacket = 256 * 1024

// maxServiceMessages is how many of the gateway's administrator's messages are logged: it decides how many it sends,
// and when, for as long as the connection lasts. An administrator has one to show, as the connection starts.
const maxServiceMessages = 10

func packet(typ uint16, body []byte) []byte {
	out := make([]byte, 8, 8+len(body))
	binary.LittleEndian.PutUint16(out, typ)
	binary.LittleEndian.PutUint32(out[4:], uint32(8+len(body)))
	return append(out, body...)
}

func utf16le(text string) []byte {
	units := utf16.Encode([]rune(text))
	out := make([]byte, 2*len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(out[2*i:], u)
	}
	return out
}

// name is a length-prefixed, zero-terminated UTF-16 string, as the tunnel and channel packets carry names.
func name(text string) []byte {
	value := utf16le(text + "\x00")
	out := make([]byte, 2, 2+len(value))
	binary.LittleEndian.PutUint16(out, uint16(len(value)))
	return append(out, value...)
}

// HandshakeRequest: version 1.0, client version 0, no extended authentication (the HTTP sign-in is the
// authentication).
func HandshakeRequest() []byte { return packet(pktHandshakeRequest, []byte{1, 0, 0, 0, 0, 0}) }

// TunnelCreate asks for a tunnel.
func TunnelCreate() []byte {
	body := make([]byte, 8)
	binary.LittleEndian.PutUint32(body, capabilityMessagingConsentSign)
	return packet(pktTunnelCreate, body)
}

// TunnelAuth names this computer to the gateway.
func TunnelAuth(clientName string) []byte {
	return packet(pktTunnelAuth, append(make([]byte, 2), name(clientName)...))
}

// ChannelCreate asks for a channel to host:port.
func ChannelCreate(host string, port int) []byte {
	head := []byte{1, 0, 0, 0, 3, 0} // one resource, no alternative names, the port, protocol 3: RDP over TCP
	binary.LittleEndian.PutUint16(head[2:], uint16(port))
	return packet(pktChannelCreate, append(head, name(host)...))
}

// DataPacket carries data to the server.
func DataPacket(data []byte) []byte {
	body := make([]byte, 2, 2+len(data))
	binary.LittleEndian.PutUint16(body, uint16(len(data)))
	return packet(pktData, append(body, data...))
}

// Refusal says what a gateway's error code means, in words for the user (the code itself goes to the log).
func Refusal(code uint32, target string) string {
	switch code & 0xffff {
	case 0x59da:
		return "the gateway doesn't let this account connect to " + target + " (its resource authorization policy)"
	case 0x59db, 0x59ed:
		return "the gateway doesn't let this account connect (its connection authorization policy)"
	case 0x59dd:
		return "the gateway couldn't reach " + target
	case 0x59e6:
		return "the gateway has no connections left to give"
	case 0x59e8, 0x59e9, 0x59f9:
		return "the gateway asks for a way of signing in that isn't supported here (a smart card or a sign-in page)"
	case 0x59ee:
		return "the gateway has no certificate set up"
	}
	return fmt.Sprintf("the gateway refused the connection (0x%x)", code)
}

// serviceMessage is the start of a gateway's service message (a length, then UTF-16 text), for the log: up to its
// terminator, 300 characters at most. Only that much is read: the gateway decides how long it is.
func serviceMessage(body []byte) string {
	if len(body) >= 2 {
		body = body[2:]
	}
	body = body[:min(len(body), 600)]
	units := make([]uint16, len(body)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(body[2*i:])
	}
	text := string(utf16.Decode(units))
	if nul := strings.IndexByte(text, 0); nul >= 0 {
		text = text[:nul]
	}
	return text
}

// ---- the HTTP upgrade, with NTLM ------------------------------------------------------------------

// What a response's status line and headers may be at most, and its body (a 401's page, which isn't kept).
const (
	maxHead = 64 * 1024
	maxBody = 256 * 1024
)

// headerName is an HTTP token (RFC 9110, 5.6.2).
var headerName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9a-z-]+$")

var (
	statusLine    = regexp.MustCompile(`^HTTP/1\.[01] (\d{3})`)
	contentLength = regexp.MustCompile(`^\d{1,9}$`)
)

type response struct {
	status  int
	headers map[string][]string
}

// readResponse reads one HTTP response's status and headers. A 401's body (its page) is counted off as it comes, not
// kept; a length that isn't a number, or is over maxBody, is refused. What follows stays in the reader.
func readResponse(in *bufio.Reader, conn net.Conn, timeout time.Duration) (*response, error) {
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	defer conn.SetReadDeadline(time.Time{})
	fail := func(err error) (*response, error) {
		var timeoutErr net.Error
		if errors.As(err, &timeoutErr) && timeoutErr.Timeout() {
			return nil, errors.New("the gateway didn't answer in time")
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, errors.New("the gateway closed the connection")
		}
		return nil, err
	}
	var head []byte
	for !bytes.HasSuffix(head, []byte("\r\n\r\n")) {
		line, err := in.ReadSlice('\n')
		head = append(head, line...)
		if len(head) >= maxHead {
			return nil, errors.New("the gateway's answer isn't HTTP")
		}
		if err != nil && err != bufio.ErrBufferFull {
			return fail(err)
		}
	}
	lines := strings.Split(string(head[:len(head)-4]), "\r\n")
	m := statusLine.FindStringSubmatch(lines[0])
	malformed := m == nil
	for _, line := range lines {
		malformed = malformed || strings.ContainsAny(line, "\r\n")
	}
	if malformed {
		return nil, errors.New("the gateway's answer isn't HTTP")
	}
	status, _ := strconv.Atoi(m[1])
	headers := map[string][]string{}
	for _, line := range lines[1:] {
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			continue
		}
		key := strings.ToLower(line[:colon])
		if headerName.MatchString(key) {
			headers[key] = append(headers[key], strings.TrimSpace(line[colon+1:]))
		}
	}
	// Only a 401's page has to be got past: a sign-in round follows it on the same connection. Any other answer ends
	// the sign-in, connection and all (and a switch of protocols has no body).
	length := "0"
	if status == 401 {
		if v := headers["content-length"]; len(v) > 0 {
			length = strings.TrimSpace(v[0])
		}
	}
	size, err := strconv.Atoi(length)
	if !contentLength.MatchString(length) || err != nil || size > maxBody {
		return nil, errors.New("the gateway's answer is malformed or too large")
	}
	if _, err := in.Discard(size); err != nil {
		return fail(err)
	}
	return &response{status: status, headers: headers}, nil
}

// EndPointBinding is what ties a sign-in to the TLS connection it is made over (RFC 5929's tls-server-end-point):
// the server's certificate, hashed with its signature's hash, or SHA-256 where that is MD5, SHA-1 or none. A gateway
// checks it by default (extended protection): a sign-in relayed from another connection doesn't have it.
func EndPointBinding(certificate *x509.Certificate) []byte {
	var sum []byte
	switch certificate.SignatureAlgorithm {
	case x509.SHA384WithRSA, x509.ECDSAWithSHA384, x509.SHA384WithRSAPSS:
		s := sha512.Sum384(certificate.Raw)
		sum = s[:]
	case x509.SHA512WithRSA, x509.ECDSAWithSHA512, x509.SHA512WithRSAPSS:
		s := sha512.Sum512(certificate.Raw)
		sum = s[:]
	default:
		s := sha256.Sum256(certificate.Raw)
		sum = s[:]
	}
	return append([]byte("tls-server-end-point:"), sum...)
}

var ntlmChallenge = regexp.MustCompile(`^NTLM\s+([A-Za-z0-9+/=]+)\s*$`)
var ntlmOffered = regexp.MustCompile(`(?i)^NTLM\b`)

func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return strings.ToUpper(fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]))
}

// upgrade upgrades the connection to the gateway's WebSocket, signing in with NTLM on the way.
func upgrade(ctx context.Context, conn net.Conn, in *bufio.Reader, gateway Endpoint, account ntlm.Account, certificate *x509.Certificate, timeout time.Duration) error {
	var keyBytes [16]byte
	_, _ = rand.Read(keyBytes[:])
	key := base64.StdEncoding.EncodeToString(keyBytes[:])
	connection := "{" + uuid() + "}"
	host := gateway.Host
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if gateway.Port != 443 {
		host += ":" + strconv.Itoa(gateway.Port)
	}
	request := func(authorization []byte) string {
		return strings.Join([]string{
			"RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1",
			"Host: " + host,
			"Connection: Upgrade",
			"Upgrade: websocket",
			"Sec-WebSocket-Version: 13",
			"Sec-WebSocket-Key: " + key,
			"RDG-Connection-Id: " + connection,
			"Authorization: NTLM " + base64.StdEncoding.EncodeToString(authorization),
			"", "",
		}, "\r\n")
	}
	negotiate := ntlm.NegotiateMessage()
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := io.WriteString(conn, request(negotiate)); err != nil {
		return err
	}
	first, err := readResponse(in, conn, timeout)
	if err != nil {
		return err
	}
	if first.status != 401 {
		if first.status == 101 {
			return errors.New("the gateway let the connection in without a sign-in")
		}
		return fmt.Errorf("the gateway answered %d to the sign-in", first.status)
	}
	offered := first.headers["www-authenticate"]
	var challenge string
	for _, v := range offered {
		if m := ntlmChallenge.FindStringSubmatch(v); m != nil {
			challenge = m[1]
			break
		}
	}
	if challenge == "" {
		for _, v := range offered {
			if ntlmOffered.MatchString(v) {
				return errors.New("the gateway didn't take up the NTLM sign-in")
			}
		}
		schemes := make([]string, len(offered))
		for i, v := range offered {
			schemes[i] = strings.SplitN(v, " ", 2)[0]
		}
		list := strings.Join(schemes, ", ")
		if list == "" {
			list = "nothing"
		}
		return fmt.Errorf("the gateway doesn't offer an NTLM sign-in (it offers: %s)", list)
	}
	challengeMessage, err := base64.StdEncoding.DecodeString(challenge)
	if err != nil {
		return errors.New("not an NTLM challenge")
	}
	account.ChannelBinding = EndPointBinding(certificate)
	account.TargetName = "HTTP/" + gateway.Host
	authenticate, err := ntlm.AuthenticateMessage(negotiate, challengeMessage, account)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := io.WriteString(conn, request(authenticate)); err != nil {
		return err
	}
	second, err := readResponse(in, conn, timeout)
	if err != nil {
		return err
	}
	if second.status == 401 || second.status == 403 {
		return &SignInError{"The gateway refused the sign-in."}
	}
	if second.status != 101 {
		// An older gateway takes the request for its HTTP transport (two connections, one each way), not spoken here.
		if second.status == 200 {
			return errors.New("the gateway doesn't take WebSocket connections (Windows Server 2012 R2 and later do)")
		}
		return fmt.Errorf("the gateway answered %d after the sign-in", second.status)
	}
	if v := second.headers["sec-websocket-accept"]; len(v) == 0 || v[0] != wsock.Accept(key) {
		return errors.New("the gateway's WebSocket answer doesn't match the request")
	}
	return nil
}

// ---- the tunnel --------------------------------------------------------------------------------------

// Options are what opening a tunnel needs besides the way to the gateway.
type Options struct {
	// A name for this computer, as the gateway's logs will have it.
	ClientName string
	// For each step of setting the tunnel up (default 20 s).
	Timeout time.Duration
	Log     func(string)
	// The certificate authorities the gateway's certificate is checked against.
	Roots *certs.Roots
	// Decides on the gateway's certificate before the account is used: the chain it sent, whether that leads to one
	// of the authorities, and why not (see certs.Verify); an error refuses it.
	CheckCertificate func(ctx context.Context, chain []*x509.Certificate, chainOK bool, reason string) error
	// The account to sign in with, asked for once the certificate is accepted.
	Account func(ctx context.Context) (ntlm.Account, error)
}

// Open opens a stream to target through the gateway, over raw (a TCP stream to the gateway, direct or through an SSH
// host). ctx's end stops the setting up (the desktop was closed): nothing more is sent to the gateway then, and the
// connection to it ends. The tunnel itself then lasts until it is closed. raw is closed on failure.
func Open(ctx context.Context, raw net.Conn, gateway, target Endpoint, opts Options) (net.Conn, error) {
	log := opts.Log
	if log == nil {
		log = func(string) {}
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 20 * time.Second
	}
	targetName := target.String()
	socket := tls.Client(raw, certs.ClientTLS(gateway.Host))
	// Until the tunnel is up, the desktop going away ends the connection, and with it whatever waits on it.
	// Abort the transport directly: concurrent TLS Close calls can return while the first still sends close_notify.
	// Once also waits for an already-running close before a failed setup returns ownership to its caller.
	closeTransport := sync.OnceFunc(func() { _ = raw.Close() })
	stop := context.AfterFunc(ctx, closeTransport)
	ok := false
	defer func() {
		stop()
		if !ok {
			closeTransport()
		}
	}()
	closedErr := func(err error) error {
		if ctx.Err() != nil {
			return errors.New("the desktop was closed meanwhile")
		}
		return err
	}
	// A step like the others: a gateway that takes the connection and never answers TLS would keep it for good.
	handshake, cancel := context.WithTimeout(ctx, timeout)
	err := socket.HandshakeContext(handshake)
	timedOut := handshake.Err() == context.DeadlineExceeded
	cancel()
	if err != nil {
		switch {
		case ctx.Err() != nil:
			return nil, closedErr(err)
		case timedOut:
			return nil, errors.New("the gateway didn't answer in time (TLS)")
		case errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed):
			return nil, errors.New("the gateway closed the connection during TLS")
		}
		return nil, err
	}
	chain := socket.ConnectionState().PeerCertificates
	if len(chain) == 0 {
		return nil, errors.New("the gateway sent no certificate")
	}
	roots := opts.Roots
	if roots == nil {
		roots = &certs.Roots{Pool: x509.NewCertPool()}
	}
	chainOK, reason, _ := certs.Verify(chain, roots, time.Now())
	if err := opts.CheckCertificate(ctx, chain, chainOK, reason); err != nil {
		return nil, err
	}
	// Nobody asks for the account for a desktop that went away while its gateway's certificate was decided on.
	if ctx.Err() != nil {
		return nil, closedErr(ctx.Err())
	}
	account, err := opts.Account(ctx)
	if err != nil {
		return nil, err
	}
	in := bufio.NewReaderSize(socket, 64<<10)
	if err := upgrade(ctx, socket, in, gateway, account, chain[0], timeout); err != nil {
		return nil, closedErr(err)
	}
	log("gateway: signed in to " + gateway.Host)

	// From here on: WebSocket frames, the gateway's packets inside.
	t := &Tunnel{socket: socket, in: in, log: log}
	refused := func(code uint32, step string) error {
		log(fmt.Sprintf("gateway: %s refused: 0x%x", step, code))
		message := Refusal(code, targetName)
		// Not being allowed in by policy is the account's doing, like a refused sign-in.
		if c := code & 0xffff; c == 0x59db || c == 0x59ed {
			return &SignInError{strings.ToUpper(message[:1]) + message[1:] + "."}
		}
		return errors.New(message)
	}
	status := func(body []byte, at int) uint32 {
		if len(body) < at+4 {
			return 0
		}
		return binary.LittleEndian.Uint32(body[at:])
	}
	exchange := func(send []byte, want uint16, step string) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := t.writeFrame(send); err != nil {
			return nil, closedErr(err)
		}
		_ = socket.SetReadDeadline(time.Now().Add(timeout))
		defer socket.SetReadDeadline(time.Time{})
		for {
			typ, body, err := t.packet()
			if err != nil {
				var timeoutErr net.Error
				if errors.As(err, &timeoutErr) && timeoutErr.Timeout() {
					return nil, fmt.Errorf("the gateway didn't answer in time (%s)", step)
				}
				if errors.Is(err, io.EOF) {
					return nil, closedErr(errors.New("the gateway closed the connection"))
				}
				return nil, closedErr(err)
			}
			if typ == want {
				return body, nil
			}
		}
	}

	handshakeBody, err := exchange(HandshakeRequest(), pktHandshakeResponse, "handshake")
	if err != nil {
		return nil, err
	}
	if len(handshakeBody) < 4 || status(handshakeBody, 0) != 0 {
		return nil, refused(status(handshakeBody, 0), "the handshake")
	}
	// The tunnel: server version (2), status (4), fields present (2), reserved (2), then what the fields say.
	tunnel, err := exchange(TunnelCreate(), pktTunnelResponse, "tunnel")
	if err != nil {
		return nil, err
	}
	if len(tunnel) < 10 || status(tunnel, 2) != 0 {
		code := uint32(0)
		if len(tunnel) >= 10 {
			code = status(tunnel, 2)
		}
		return nil, refused(code, "the tunnel")
	}
	clientName := opts.ClientName
	if clientName == "" {
		clientName = "tabby-rdp"
	}
	authorized, err := exchange(TunnelAuth(clientName), pktTunnelAuthResponse, "authorization")
	if err != nil {
		return nil, err
	}
	if len(authorized) < 4 || status(authorized, 0) != 0 {
		return nil, refused(status(authorized, 0), "the authorization")
	}
	channel, err := exchange(ChannelCreate(target.Host, target.Port), pktChannelResponse, "channel")
	if err != nil {
		return nil, err
	}
	if len(channel) < 4 || status(channel, 0) != 0 {
		return nil, refused(status(channel, 0), "the channel")
	}
	log(fmt.Sprintf("gateway: channel to %s through %s", targetName, gateway.Host))
	stop()
	if ctx.Err() != nil {
		return nil, closedErr(ctx.Err())
	}
	ok = true
	return t, nil
}

// Tunnel is the stream to the server through the gateway: its bytes inside data packets, inside WebSocket frames.
// What the gateway sends is read as Read asks for it, so a reader that stops reading stops the gateway too.
type Tunnel struct {
	socket *tls.Conn
	in     *bufio.Reader
	log    func(string)

	wmu       sync.Mutex
	finalSent bool

	// Read's side (one reader at a time): the packets' bytes not yet split up, and data not yet read.
	pending  []byte
	data     []byte
	messages int
	ended    bool
}

func (t *Tunnel) writeFrame(payload []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	_, err := t.socket.Write(wsock.AppendFrame(nil, wsock.OpBinary, payload, true))
	return err
}

// packet reads the next packet, answering pings and logging the administrator's messages on the way; io.EOF once the
// gateway closed the connection or the channel.
func (t *Tunnel) packet() (uint16, []byte, error) {
	for {
		if len(t.pending) >= 8 {
			length := binary.LittleEndian.Uint32(t.pending[4:])
			if length < 8 || length > maxPacket {
				return 0, nil, fmt.Errorf("a gateway packet of %d bytes", length)
			}
			if uint32(len(t.pending)) >= length {
				p := t.pending[:length]
				t.pending = t.pending[length:]
				typ, body := binary.LittleEndian.Uint16(p), p[8:]
				switch typ {
				case pktKeepalive:
					// nothing to answer: the gateway only checks the line
					continue
				case pktServiceMessage:
					t.messages++
					if t.messages <= maxServiceMessages {
						t.log("gateway: its administrator's message: " + serviceMessage(body))
					} else if t.messages == maxServiceMessages+1 {
						t.log(fmt.Sprintf("gateway: more messages from its administrator; past %d, they aren't logged", maxServiceMessages))
					}
					continue
				case pktCloseChannel:
					_ = t.writeFrame(packet(pktCloseChannelResonse, make([]byte, 8)))
					t.ended = true
					return 0, nil, io.EOF
				}
				return typ, body, nil
			}
		}
		if t.ended {
			return 0, nil, io.EOF
		}
		f, err := wsock.ReadFrame(t.in, false, maxPacket*4)
		if err != nil {
			if errors.Is(err, wsock.ErrTooLarge) {
				return 0, nil, errors.New("a WebSocket frame too large to be the gateway's")
			}
			return 0, nil, err
		}
		switch f.Opcode {
		case wsock.OpClose:
			t.ended = true
			return 0, nil, io.EOF
		case wsock.OpPing:
			t.wmu.Lock()
			_, err := t.socket.Write(wsock.AppendFrame(nil, wsock.OpPong, f.Payload, true))
			t.wmu.Unlock()
			if err != nil {
				return 0, nil, err
			}
		case wsock.OpContinuation, wsock.OpText, wsock.OpBinary:
			// The packets inside are a stream of their own: fragments and whole messages alike just add to it.
			if len(t.pending) == 0 {
				t.pending = f.Payload
			} else {
				t.pending = append(t.pending, f.Payload...)
			}
		}
	}
}

// Read reads the server's bytes.
func (t *Tunnel) Read(b []byte) (int, error) {
	for len(t.data) == 0 {
		typ, body, err := t.packet()
		if err != nil {
			return 0, err
		}
		if typ == pktData {
			length := 0
			if len(body) >= 2 {
				length = int(binary.LittleEndian.Uint16(body))
			}
			t.data = body[min(2, len(body)):min(len(body), 2+length)]
		}
	}
	n := copy(b, t.data)
	t.data = t.data[n:]
	return n, nil
}

// Write sends bytes to the server, in data packets.
func (t *Tunnel) Write(b []byte) (int, error) {
	for at := 0; at < len(b); at += maxData {
		if err := t.writeFrame(DataPacket(b[at:min(len(b), at+maxData)])); err != nil {
			return at, err
		}
	}
	return len(b), nil
}

// CloseWrite closes the channel from this side: nothing more goes to the server.
func (t *Tunnel) CloseWrite() error {
	t.wmu.Lock()
	if t.finalSent {
		t.wmu.Unlock()
		return nil
	}
	t.finalSent = true
	t.wmu.Unlock()
	return t.writeFrame(packet(pktCloseChannel, make([]byte, 4)))
}

// Close ends the connection to the gateway.
func (t *Tunnel) Close() error { return t.socket.Close() }

func (t *Tunnel) LocalAddr() net.Addr                { return t.socket.LocalAddr() }
func (t *Tunnel) RemoteAddr() net.Addr               { return t.socket.RemoteAddr() }
func (t *Tunnel) SetDeadline(d time.Time) error      { return t.socket.SetDeadline(d) }
func (t *Tunnel) SetReadDeadline(d time.Time) error  { return t.socket.SetReadDeadline(d) }
func (t *Tunnel) SetWriteDeadline(d time.Time) error { return t.socket.SetWriteDeadline(d) }
