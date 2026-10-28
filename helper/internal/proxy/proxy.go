// Package proxy is the RDCleanPath proxy for IronRDP's web client: the client talks WebSocket to it, on this
// computer's loopback; the proxy opens the stream to the server (a TCP connection of its own, a stream the plugin
// carries over an SSH channel, or a tunnel through an RD Gateway), forwards the X.224 request, does TLS there, has the
// plugin decide on the server's certificate, hands the certificate chain back to the client (for CredSSP), then
// relays. Ported from the plugin's former src/rdcleanpath.ts, where it ran in Tabby's window; the plugin keeps the
// decisions (certificates, servers without Network Level Authentication, the gateway's account), and the proxy asks
// for them through Plugin.
package proxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/meanaverage/tabby-rdp/helper/internal/certs"
	"github.com/meanaverage/tabby-rdp/helper/internal/gateway"
	"github.com/meanaverage/tabby-rdp/helper/internal/ntlm"
	"github.com/meanaverage/tabby-rdp/helper/internal/rdp"
	"github.com/meanaverage/tabby-rdp/helper/internal/wsock"
)

const (
	// The client's first message (the RDCleanPath request: a destination, a token, an X.224 request) is small.
	MaxHello = 64 * 1024
	// How long a client has to send it.
	HelloTimeout = 10 * time.Second
	// How long the server has to answer X.224 and TLS (gateway included), unless Options say otherwise.
	HandshakeTimeout = 45 * time.Second
	// What the client may send ahead while the server is being reached (CredSSP hasn't started: next to nothing).
	MaxEarly = 256 * 1024
	// One client at a time uses a proxy; a reconnect can overlap the connection it replaces.
	MaxClients = 4
	// A WebSocket message from the client: RDP PDUs, at most a few megabytes for a shared drive's read.
	MaxMessage = 32 * 1024 * 1024
	// Data waiting for the client past this stops reading from the server, until half of it is gone.
	HighWater = 8 * 1024 * 1024
	// What answers to the remote's requests may have taken of the window's memory (see the plugin's ServerFlow).
	FlowWindow = 64 * 1024 * 1024
	// What may wait in the proxy for a server that doesn't take it, before the connection ends. Answers keep within
	// FlowWindow of it and one message more, so the rest of what the client sends (input, sound, the clipboard's
	// answers) always has HighWater at least.
	ServerBacklog = FlowWindow + MaxMessage + HighWater
	// How long a client that was sent a close has to answer it (the ws module's own wait).
	closeTimeout = 30 * time.Second
	// How long the plugin has to take note of a failure before the client hears of it.
	failureTimeout = 2 * time.Second
)

// Route is how to reach a server, as the plugin says: a stream it carries (Conn), a TCP connection from here
// (Direct), or a tunnel through an RD Gateway.
type Route struct {
	Conn    net.Conn
	Direct  *Direct
	Gateway *GatewayRoute
}

// GatewayRoute is a desktop behind an RD Gateway, and how to reach the gateway (Via: a stream or a TCP connection).
type GatewayRoute struct {
	Gateway, Target gateway.Endpoint
	ClientName      string
	Timeout         time.Duration
	Via             Route
}

// Flow is what the plugin hears of the connection whose room it keeps (see the plugin's ServerFlow), and of the bytes
// relayed: what the proxy read from that connection since the last report, what waits for the server now, whether
// the connection changed (or ended) since, and the bytes relayed in all.
type Flow struct {
	Read     int64 `json:"read"`
	Backlog  int64 `json:"backlog"`
	Reset    bool  `json:"reset"`
	BytesIn  int64 `json:"bytesIn"`
	BytesOut int64 `json:"bytesOut"`
}

// Plugin is what the proxy asks of, and tells, the plugin. Each call that decides something returns an error to
// refuse; its text is the failure's.
type Plugin interface {
	// Open says how to reach destination for connection conn.
	Open(ctx context.Context, conn uint32, destination string) (Route, error)
	// WithoutNLA decides on a server that chose TLS without Network Level Authentication, before anything more is
	// sent to it.
	WithoutNLA(ctx context.Context, conn uint32) error
	// Certificate decides on a certificate chain, the server's ("server", nla telling whether it uses Network Level
	// Authentication, where an X.224 exchange said) or a gateway's ("gateway"): chainOK and reason are the chain's
	// verdict (see certs.Verify); the plugin checks the name.
	Certificate(ctx context.Context, conn uint32, scope string, chain []*x509.Certificate, chainOK bool, reason string, nla *bool) error
	// GatewayAccount is the gateway's sign-in, asked for once its certificate is accepted.
	GatewayAccount(ctx context.Context, conn uint32) (ntlm.Account, error)
	// Failure reports why a connection failed (stage "handshake") or why the relay ended ("relay"), and waits for the
	// plugin to have taken note, or ctx.
	Failure(ctx context.Context, conn uint32, stage, message string, signIn bool)
	Log(message string)
	Accepted(conn uint32)
	Closed(conn uint32)
	GatewayOpened(conn uint32)
	Flow(Flow)
}

// Options are the proxy's.
type Options struct {
	// Set INFO_AUTOLOGON in the client's Client Info PDU (xrdp; see rdp.Autologon).
	Autologon bool
	// The name the server goes by here (a host name, or an IP address): its chain is checked against Roots for the
	// plugin to weigh, and a host name goes in the TLS handshake (SNI). Without one, nothing is checked that way.
	ServerName string
	// How long reaching the server, TLS included, may take (0: HandshakeTimeout).
	HandshakeTimeout time.Duration
	// The certificate authorities chains are checked against.
	Roots *certs.Roots
	// Tap receives relay bytes for an optional local PDU trace. It must not change the connection.
	Tap func(direction string, data []byte, kind string)
}

// Proxy is a running proxy.
type Proxy struct {
	plugin Plugin
	opts   Options
	ln     net.Listener
	token  string
	path   string

	mu       sync.Mutex
	clients  map[*client]struct{}
	nextConn uint32
	shut     bool
	// Every connection accepted, from accept until it is closed: Close ends them all, upgrades and closings included.
	conns map[net.Conn]struct{}

	// The room's connection (the latest to reach the relay), and what is reported of it (see Flow).
	flowClient *client
	readDelta  int64
	reset      bool
	bytesIn    int64
	bytesOut   int64
	reported   Flow
	flushMu    sync.Mutex
	kick       chan struct{}
	done       chan struct{}
}

// Start listens on the loopback, at a port of its own.
func Start(plugin Plugin, opts Options) (*Proxy, error) {
	if opts.HandshakeTimeout == 0 {
		opts.HandshakeTimeout = HandshakeTimeout
	}
	if opts.Roots == nil {
		opts.Roots = &certs.Roots{Pool: x509.NewCertPool()}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		ln.Close()
		return nil, err
	}
	p := &Proxy{
		plugin:  plugin,
		opts:    opts,
		ln:      ln,
		token:   hex.EncodeToString(secret[:]),
		clients: map[*client]struct{}{},
		conns:   map[net.Conn]struct{}{},
		kick:    make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
	p.path = "/" + p.token
	go p.accept()
	go p.report()
	return p, nil
}

// Port is where the proxy listens.
func (p *Proxy) Port() int { return p.ln.Addr().(*net.TCPAddr).Port }

// Token is what a client shows, as its address's path and in its request.
func (p *Proxy) Token() string { return p.token }

// Close stops listening and ends the clients there are.
func (p *Proxy) Close() {
	p.mu.Lock()
	if p.shut {
		p.mu.Unlock()
		return
	}
	p.shut = true
	clients := make([]*client, 0, len(p.clients))
	for c := range p.clients {
		clients = append(clients, c)
	}
	conns := make([]net.Conn, 0, len(p.conns))
	for conn := range p.conns {
		conns = append(conns, conn)
	}
	p.mu.Unlock()
	_ = p.ln.Close()
	for _, c := range clients {
		c.terminate()
	}
	for _, conn := range conns {
		_ = conn.Close()
	}
	close(p.done)
}

// sameSecret says whether given is the secret, compared in a time that doesn't tell how much of it was right.
func sameSecret(given, secret string) bool {
	return len(given) == len(secret) && subtle.ConstantTimeCompare([]byte(given), []byte(secret)) == 1
}

func (p *Proxy) accept() {
	for {
		conn, err := p.ln.Accept()
		if err != nil {
			var temporary interface{ Temporary() bool }
			if errors.As(err, &temporary) && temporary.Temporary() {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			return
		}
		go p.serve(conn)
	}
}

func (p *Proxy) serve(conn net.Conn) {
	p.mu.Lock()
	if p.shut {
		p.mu.Unlock()
		_ = conn.Close()
		return
	}
	p.conns[conn] = struct{}{}
	p.mu.Unlock()
	defer func() {
		_ = conn.Close()
		p.mu.Lock()
		delete(p.conns, conn)
		p.mu.Unlock()
	}()
	// Anything on this computer can reach the port, and so can a web page in a browser. A connection without the
	// token is turned away before it takes one of the few places, which the desktop's own client would then find
	// taken; and one from a page other than a file's, as Tabby's window is, is turned away whatever it has. (Its
	// Origin: none, not a browser's page, or `file://`; not a web page, a sandboxed or otherwise opaque one, `null`,
	// or a browser extension's.)
	ws, err := wsock.Upgrade(conn, HelloTimeout, func(r *wsock.Request) bool {
		origin := r.Header["origin"]
		return (len(origin) == 0 || len(origin) == 1 && origin[0] == "file://") && sameSecret(r.Target, p.path)
	})
	if err != nil {
		_ = conn.Close()
		return
	}
	p.mu.Lock()
	if p.shut {
		p.mu.Unlock()
		_ = ws.Close()
		return
	}
	p.nextConn++
	c := newClient(p, p.nextConn, ws)
	p.clients[c] = struct{}{}
	crowded := len(p.clients) > MaxClients
	p.mu.Unlock()
	if crowded {
		c.terminate()
		return
	}
	p.plugin.Accepted(c.id)
	c.run()
}

func (p *Proxy) forget(c *client) {
	p.mu.Lock()
	delete(p.clients, c)
	flowEnded := p.flowClient == c
	if flowEnded {
		// What was handed to this connection went with it: the next starts with all the room.
		p.flowClient = nil
		p.reset = true
		p.readDelta = 0
	}
	p.mu.Unlock()
	if flowEnded {
		// Told at once, before the client hears that its connection ended.
		p.flush()
	}
}

func (p *Proxy) kickFlow() {
	select {
	case p.kick <- struct{}{}:
	default:
	}
}

// report tells the plugin of the flow: soon after what bears on the room changes (a few milliseconds, to gather what
// changes together), and of the bytes relayed, a few times a second.
func (p *Proxy) report() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-p.kick:
			time.Sleep(2 * time.Millisecond)
		case <-ticker.C:
		}
		p.flush()
	}
}

// flush tells the plugin of the flow now, if anything changed since it was last told.
func (p *Proxy) flush() {
	p.flushMu.Lock()
	defer p.flushMu.Unlock()
	// What was read from the client and what waits for the server, as of one moment: the client's lock holds back its
	// next message (read and queued for the server under it), so the plugin never hears of bytes read that it doesn't
	// also find waiting, or gone. (A client's lock is taken before the proxy's, never after.)
	var flowClient *client
	var backlog int64
	for {
		p.mu.Lock()
		flowClient = p.flowClient
		p.mu.Unlock()
		backlog = 0
		if flowClient != nil {
			flowClient.mu.Lock()
			backlog = flowClient.backlogLocked()
		}
		p.mu.Lock()
		if p.flowClient == flowClient {
			break
		}
		// Another connection took the room meanwhile: its counters and its backlog go together, so start over.
		p.mu.Unlock()
		if flowClient != nil {
			flowClient.mu.Unlock()
		}
	}
	f := Flow{Read: p.readDelta, Reset: p.reset, BytesIn: p.bytesIn, BytesOut: p.bytesOut, Backlog: backlog}
	p.readDelta, p.reset = 0, false
	changed := f.Read != 0 || f.Reset || f.Backlog != p.reported.Backlog || f.BytesIn != p.reported.BytesIn || f.BytesOut != p.reported.BytesOut
	if changed {
		p.reported = f
	}
	p.mu.Unlock()
	if flowClient != nil {
		flowClient.mu.Unlock()
	}
	// Told outside the client's lock: the plugin's channel can be slow to take it (Tabby's window busy), and the relay
	// mustn't wait on that. flushMu keeps the reports in order.
	if changed {
		p.plugin.Flow(f)
	}
}

// ---- a client ------------------------------------------------------------------------------------------

type stage int

const (
	stageHello stage = iota
	stageHandshake
	stageRelay
)

// bytesQueue is what waits for one side: chunks in order, how many bytes, and whether it was closed.
type bytesQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	items  [][]byte
	bytes  int
	closed bool
	// A close of the WebSocket after the items (the client's queue only).
	closeAfter bool
}

func newQueue() *bytesQueue {
	q := &bytesQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *bytesQueue) push(items ...[]byte) {
	q.mu.Lock()
	if !q.closed && !q.closeAfter {
		for _, item := range items {
			q.items = append(q.items, item)
			q.bytes += len(item)
		}
		q.cond.Broadcast()
	}
	q.mu.Unlock()
}

// pop waits for the next item; ok false once closed, or (with close) when the items are done and a close follows.
func (q *bytesQueue) pop() (item []byte, close bool, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.closed && !q.closeAfter {
		q.cond.Wait()
	}
	if q.closed {
		return nil, false, false
	}
	if len(q.items) == 0 {
		q.closed = true
		return nil, true, true
	}
	item = q.items[0]
	q.items[0] = nil
	q.items = q.items[1:]
	return item, false, true
}

// done says the item popped was dealt with: its bytes no longer wait.
func (q *bytesQueue) done(n int) {
	q.mu.Lock()
	q.bytes -= n
	q.cond.Broadcast()
	q.mu.Unlock()
}

func (q *bytesQueue) waiting() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bytes
}

// waitBelow waits while more than limit bytes wait (and the queue is open).
func (q *bytesQueue) waitBelow(limit int) {
	q.mu.Lock()
	for q.bytes > limit && !q.closed {
		q.cond.Wait()
	}
	q.mu.Unlock()
}

func (q *bytesQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.items = nil
	q.cond.Broadcast()
	q.mu.Unlock()
}

func (q *bytesQueue) closeAfterItems() {
	q.mu.Lock()
	q.closeAfter = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

type client struct {
	p  *Proxy
	id uint32
	ws *wsock.Conn
	// Ends with the client: what is asked of the plugin for it, and the streams opened for it.
	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	stage     stage
	closed    bool
	failing   bool
	early     [][]byte
	earlySize int
	// Every stream opened for this client, from the moment it exists, in order: closed with the client.
	streams []io.Closer
	// The stream at the bottom, where it is one the plugin carries: what it hasn't taken yet waits for the server too.
	bridge   interface{ Unacknowledged() int }
	toServer func([]byte) []byte

	toServerQueue *bytesQueue
	toClientQueue *bytesQueue
}

func newClient(p *Proxy, id uint32, ws *wsock.Conn) *client {
	c := &client{p: p, id: id, ws: ws, toServerQueue: newQueue(), toClientQueue: newQueue(), toServer: func(b []byte) []byte { return b }}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	if p.opts.Autologon {
		c.toServer = rdp.Autologon()
	}
	go c.writeToClient()
	return c
}

// backlogLocked is what was read from the client and the server hasn't taken yet (c.mu held).
func (c *client) backlogLocked() int64 {
	n := int64(c.toServerQueue.waiting())
	if c.bridge != nil {
		n += int64(c.bridge.Unacknowledged())
	}
	return n
}

// track keeps a stream opened for this client, to close with it; false (and the stream closed) when the client has
// gone meanwhile.
func (c *client) track(stream io.Closer) bool {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		_ = stream.Close()
		return false
	}
	c.streams = append(c.streams, stream)
	c.mu.Unlock()
	return true
}

func (c *client) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// end ends what this client had: its streams, what was asked for it, its queues. The streams go in the order they
// were opened: the one to the server first, so that TLS over it, closed after, has nothing to wait on (no close
// alert to send through a stream the plugin isn't taking from); Node's destroy() sent none either.
func (c *client) end() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	streams := c.streams
	c.streams = nil
	c.early = nil
	c.mu.Unlock()
	c.cancel()
	for _, stream := range streams {
		_ = stream.Close()
	}
	c.toServerQueue.close()
	c.p.forget(c)
	c.p.plugin.Closed(c.id)
}

// terminate ends the client at once, its connection without a close.
func (c *client) terminate() {
	_ = c.ws.Close()
	c.toClientQueue.close()
	c.end()
}

// closeGracefully sends the client what waits for it, then a close, and ends the client once it answers (or doesn't
// in time).
func (c *client) closeGracefully() {
	c.toClientQueue.closeAfterItems()
}

// fail tells the plugin why the connection failed (before the client hears of it, which is when the plugin looks),
// then has the client hear RDCleanPath's error, and ends it.
func (c *client) fail(why string, signIn bool) {
	c.mu.Lock()
	if c.closed || c.failing {
		c.mu.Unlock()
		return
	}
	c.failing = true
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), failureTimeout)
	c.p.plugin.Failure(ctx, c.id, "handshake", why, signIn)
	cancel()
	// What the connection had goes (and the plugin hears of its end) before the client hears of the failure.
	c.end()
	c.toClientQueue.push(rdp.EncodeError())
	c.closeGracefully()
}

func (c *client) writeToClient() {
	for {
		item, closing, ok := c.toClientQueue.pop()
		if !ok {
			return
		}
		if closing {
			// A close with no code, as the ws module's close() sends; the client's answer ends the reading. A client
			// that reads nothing more has closeTimeout for both.
			_ = c.ws.NetConn().SetDeadline(time.Now().Add(closeTimeout))
			_ = c.ws.WriteClose(0)
			return
		}
		err := c.ws.WriteMessage(item)
		c.toClientQueue.done(len(item))
		if err != nil {
			c.terminate()
			return
		}
	}
}

func (c *client) run() {
	// Only a client that knows the token gets here, and then only as far as its first message (which has to be small
	// and arrive soon) until that shows the token too.
	deadline := time.AfterFunc(HelloTimeout, func() {
		c.mu.Lock()
		hello := c.stage == stageHello
		c.mu.Unlock()
		if hello {
			c.terminate()
		}
	})
	defer deadline.Stop()
	var hello []byte
	for {
		message, err := c.ws.ReadMessage(MaxMessage)
		if err != nil {
			if !errors.Is(err, wsock.ErrClosing) && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) && !c.isClosed() {
				c.p.plugin.Log("proxy: client: " + err.Error())
			}
			_ = c.ws.Close()
			c.toClientQueue.close()
			c.end()
			return
		}
		c.mu.Lock()
		switch c.stage {
		case stageRelay:
			if c.p.opts.Tap != nil {
				c.p.opts.Tap("out", message, "")
			}
			c.p.mu.Lock()
			c.p.bytesOut += int64(len(message))
			// Read from the connection: no longer waiting there, but here, for as long as the server doesn't take it.
			if c.p.flowClient == c {
				c.p.readDelta += int64(len(message))
			}
			c.p.mu.Unlock()
			c.send(message)
			c.mu.Unlock()
			c.p.kickFlow()
		case stageHandshake:
			c.earlySize += len(message)
			if c.earlySize > MaxEarly {
				c.mu.Unlock()
				go c.fail("the client sent too much before the server was reached", false)
				continue
			}
			c.early = append(c.early, message)
			c.mu.Unlock()
		default:
			// Before the token is checked: no more than a request's worth is kept, whatever length it claims.
			if len(hello)+len(message) > MaxHello {
				c.mu.Unlock()
				c.terminate()
				continue
			}
			hello = append(hello, message...)
			outer, ok := rdp.ReadTLV(hello, 0)
			if !ok || len(hello) < outer.End {
				c.mu.Unlock()
				continue
			}
			c.stage = stageHandshake
			c.mu.Unlock()
			deadline.Stop()
			go c.handshake(hello[:outer.End])
			hello = nil
		}
	}
}

// send hands what the client sent on to the server (c.mu held). It waits in the proxy, counted, for as long as the
// server doesn't take it, rather than in the client's own queue to send, where nothing is; so the connection ends
// once more waits than ServerBacklog. A server that reads, slowly, can end up there too: what is pasted there from
// here goes as it is, however large, so the failure says how much waited.
func (c *client) send(data []byte) {
	out := c.toServer(data)
	if c.closed || c.failing || len(out) == 0 {
		return
	}
	c.toServerQueue.push(out)
	if backlog := int64(c.toServerQueue.waiting()); backlog > ServerBacklog {
		c.failing = true
		why := fmt.Sprintf("more than %d MB sent to the server waited for it to take them (%d MB): it stopped reading, or the link is too slow for what was sent",
			(ServerBacklog+512*1024)/(1024*1024), (backlog+512*1024)/(1024*1024))
		go func() {
			// What the connection took goes with it, and the plugin hears why, before the client hears of the end.
			c.end()
			ctx, cancel := context.WithTimeout(context.Background(), failureTimeout)
			c.p.plugin.Failure(ctx, c.id, "relay", why, false)
			cancel()
			c.terminate()
		}()
	}
}

var errClientLeft = errors.New("the client left")

func (c *client) handshake(hello []byte) {
	req, err := rdp.DecodeRequest(hello)
	if err != nil {
		c.fail(err.Error(), false)
		return
	}
	if !req.HasVersion || req.Version != rdp.Version1 || req.Destination == "" || req.X224 == nil && strings.TrimSpace(req.PCB) == "" {
		c.fail("malformed request", false)
		return
	}
	if !sameSecret(req.ProxyAuth, c.p.token) {
		c.fail("bad token", false)
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, c.p.opts.HandshakeTimeout)
	upstream, x224, err := c.connect(ctx, req)
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	// Reached: from here on the time is the user's (a certificate to look at) and the session's.
	cancel()
	if c.isClosed() {
		return
	}
	if err != nil {
		var signIn *gateway.SignInError
		switch {
		case timedOut:
			c.fail("the server didn't answer in time", false)
		case errors.As(err, &signIn):
			c.fail(signIn.Message, true)
		default:
			c.fail(err.Error(), false)
		}
		return
	}
	state := upstream.ConnectionState()
	version := fmt.Sprintf("TLS 0x%04x", state.Version)
	if state.Version == tls.VersionTLS12 {
		version = "TLS 1.2"
	}
	if state.Version == tls.VersionTLS13 {
		version = "TLS 1.3"
	}
	c.p.plugin.Log("TLS: negotiated " + version + " " + tls.CipherSuiteName(state.CipherSuite))
	chain := state.PeerCertificates
	if len(chain) == 0 {
		c.fail("the server sent no certificate", false)
		return
	}
	chainOK, reason := false, ""
	if c.p.opts.ServerName != "" {
		chainOK, reason, _ = certs.Verify(chain, c.p.opts.Roots, time.Now())
	}
	var nla *bool
	if x224 != nil {
		offers := rdp.OffersNLA(x224)
		nla = &offers
	}
	// The certificate is decided on before the client gets the response it waits for to start CredSSP, and before
	// anything it sent early goes to the server.
	if err := c.p.plugin.Certificate(c.ctx, c.id, "server", chain, chainOK, reason, nla); err != nil {
		if !c.isClosed() {
			c.fail(err.Error(), false)
		}
		return
	}
	raw := make([][]byte, len(chain))
	for i, certificate := range chain {
		raw[i] = certificate.Raw
	}
	c.mu.Lock()
	if c.closed || c.failing {
		c.mu.Unlock()
		return
	}
	c.stage = stageRelay
	// The room is this connection's from now on, all of it.
	c.p.mu.Lock()
	c.p.flowClient = c
	c.p.reset = true
	c.p.readDelta = 0
	c.p.mu.Unlock()
	go c.writeToServer(upstream)
	if c.p.opts.Tap != nil {
		if req.X224 != nil {
			c.p.opts.Tap("out", req.X224, "x224")
		}
		if x224 != nil {
			c.p.opts.Tap("in", x224, "x224")
		}
	}
	early := c.early
	c.early = nil
	for _, data := range early {
		if c.p.opts.Tap != nil {
			c.p.opts.Tap("out", data, "")
		}
		c.p.mu.Lock()
		c.p.bytesOut += int64(len(data))
		c.p.mu.Unlock()
		c.send(data)
	}
	c.mu.Unlock()
	// The plugin hears that the room is this connection's before the client hears back, and so before anything takes
	// room for it: a later word would give back room already taken.
	c.p.flush()
	c.toClientQueue.push(rdp.EncodeResponse(x224, raw, req.Destination))
	// PROTOCOL_HYBRID_EX in the server's negotiation response: an Early User Authorization Result follows CredSSP. (A
	// Hyper-V VM's console: CredSSP first, then the X.224 exchange, which never asks for HYBRID_EX.)
	go c.readFromServer(upstream, rdp.NewServerFraming(x224 != nil && rdp.EarlyUserAuthorization(x224)))
	c.p.plugin.Log("RDCleanPath relay up to " + req.Destination)
}

// open opens the stream to the server, the way the plugin says.
func (c *client) open(ctx context.Context, destination string) (net.Conn, error) {
	route, err := c.p.plugin.Open(ctx, c.id, destination)
	if err != nil {
		return nil, err
	}
	if route.Gateway != nil {
		via, err := c.reach(ctx, route.Gateway.Via)
		if err != nil {
			return nil, err
		}
		g := route.Gateway
		tunnel, err := gateway.Open(ctx, via, g.Gateway, g.Target, gateway.Options{
			ClientName: g.ClientName,
			Timeout:    g.Timeout,
			Log:        c.p.plugin.Log,
			Roots:      c.p.opts.Roots,
			CheckCertificate: func(ctx context.Context, chain []*x509.Certificate, chainOK bool, reason string) error {
				return c.p.plugin.Certificate(ctx, c.id, "gateway", chain, chainOK, reason, nil)
			},
			Account: func(ctx context.Context) (ntlm.Account, error) { return c.p.plugin.GatewayAccount(ctx, c.id) },
		})
		if err != nil {
			return nil, err
		}
		if !c.track(tunnel) {
			return nil, errClientLeft
		}
		c.p.plugin.GatewayOpened(c.id)
		return tunnel, nil
	}
	return c.reach(ctx, route)
}

// reach opens a stream the plugin carries, or a TCP connection, and keeps it to close with the client.
func (c *client) reach(ctx context.Context, route Route) (net.Conn, error) {
	conn := route.Conn
	if route.Direct != nil {
		var err error
		if conn, err = dial(ctx, *route.Direct); err != nil {
			return nil, err
		}
	}
	if conn == nil {
		return nil, errors.New("the plugin gave no way to the server")
	}
	if !c.track(conn) {
		return nil, errClientLeft
	}
	if bridge, ok := conn.(interface{ Unacknowledged() int }); ok {
		c.mu.Lock()
		c.bridge = bridge
		c.mu.Unlock()
		if stream, ok := conn.(interface{ SetOnAcknowledged(func()) }); ok {
			// The plugin taking what was sent makes room: the plugin hears of it.
			stream.SetOnAcknowledged(c.p.kickFlow)
		}
	}
	return conn, nil
}

// connect sends the client's X.224 request to the server, reads the confirm, then does TLS there. With a
// pre-connection blob, that goes first; without an X.224 request (a Hyper-V VM's console), TLS follows the blob at
// once and X.224 is the client's to do later.
func (c *client) connect(ctx context.Context, req *rdp.Request) (*tls.Conn, []byte, error) {
	// Without the user name IronRDP puts in it. A request that still names one after that (its form not the one
	// WithoutUserCookie knows) goes nowhere: the name isn't to reach the server before it is checked.
	var request []byte
	if req.X224 != nil {
		request = rdp.WithoutUserCookie(req.X224)
		if bytes.Contains(request, rdp.Cookie) {
			return nil, nil, errors.New("the connection request carries the user name in a form the proxy can't take it out of")
		}
	}
	raw, err := c.open(ctx, req.Destination)
	if err != nil {
		return nil, nil, err
	}
	// Until TLS is up, the time running out (or the client leaving) ends the stream, and what waits on it.
	stop := context.AfterFunc(ctx, func() { _ = raw.Close() })
	defer stop()
	if req.PCB != "" {
		if _, err := raw.Write(rdp.PreconnectionPDU(req.PCB)); err != nil {
			return nil, nil, err
		}
	}
	var x224, rest []byte
	if request != nil {
		if _, err := raw.Write(request); err != nil {
			return nil, nil, err
		}
		if x224, rest, err = readTPKT(raw); err != nil {
			return nil, nil, err
		}
		if refused := rdp.NoTLS(x224); refused != "" {
			return nil, nil, errors.New(refused)
		}
		// Before TLS: a server that isn't to get the password gets nothing more at all.
		if !rdp.OffersNLA(x224) {
			if err := c.p.plugin.WithoutNLA(ctx, c.id); err != nil {
				return nil, nil, err
			}
		}
	}
	upstream := tls.Client(&prefixed{Conn: raw, rest: rest}, certs.RDPClientTLS(c.p.opts.ServerName))
	if !c.track(upstream) {
		return nil, nil, errClientLeft
	}
	if err := upstream.HandshakeContext(ctx); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
			return nil, nil, errors.New("upstream closed during TLS")
		}
		return nil, nil, err
	}
	return upstream, x224, nil
}

// readTPKT reads exactly one TPKT-framed PDU (the X.224 Connection Confirm), and what came after it (TLS's first
// bytes, for TLS to read).
func readTPKT(conn net.Conn) (pdu, rest []byte, err error) {
	buf := make([]byte, 0, 512)
	chunk := make([]byte, 4096)
	for {
		n, err := conn.Read(chunk)
		buf = append(buf, chunk[:n]...)
		if len(buf) >= 4 {
			length := int(buf[2])<<8 | int(buf[3])
			// TPKT is version 3, and an X.224 TPDU takes three bytes at least: anything else is not an RDP server
			// answering (a web server on that port, say), and isn't waited on for the length it seems to give.
			if buf[0] != 3 || length < 7 {
				return nil, nil, errors.New("the server's answer isn't RDP (is that the desktop's port?)")
			}
			if len(buf) >= length {
				return bytes.Clone(buf[:length]), bytes.Clone(buf[length:]), nil
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				return nil, nil, errors.New("upstream closed during X.224")
			}
			return nil, nil, err
		}
	}
}

// prefixed is a connection with bytes already read from it, given back first.
type prefixed struct {
	net.Conn
	rest []byte
}

func (p *prefixed) Read(b []byte) (int, error) {
	if len(p.rest) > 0 {
		n := copy(b, p.rest)
		p.rest = p.rest[n:]
		return n, nil
	}
	return p.Conn.Read(b)
}

// writeToServer writes what the client sent to the server, in order; the server not taking it holds it here.
func (c *client) writeToServer(upstream net.Conn) {
	for {
		chunk, _, ok := c.toServerQueue.pop()
		if !ok {
			return
		}
		_, err := upstream.Write(chunk)
		c.toServerQueue.done(len(chunk))
		c.p.kickFlow()
		if err != nil {
			// The reading side hears of it too, and ends the relay.
			_ = upstream.Close()
			return
		}
	}
}

// readFromServer hands what the server sends to the client a PDU per message, and stops reading from the server
// while the client isn't keeping up, until it has taken half of what waits.
func (c *client) readFromServer(upstream net.Conn, frames *rdp.ServerFraming) {
	buf := make([]byte, 64*1024)
	for {
		n, err := upstream.Read(buf)
		if n > 0 {
			if c.p.opts.Tap != nil {
				c.p.opts.Tap("in", buf[:n], "")
			}
			c.p.mu.Lock()
			c.p.bytesIn += int64(n)
			c.p.mu.Unlock()
			pdus, ferr := frames.Push(buf[:n])
			if ferr != nil {
				c.p.plugin.Log("upstream: " + ferr.Error())
				c.end()
				c.closeGracefully()
				return
			}
			c.toClientQueue.push(pdus...)
			if c.toClientQueue.waiting() > HighWater {
				c.toClientQueue.waitBelow(HighWater / 2)
			}
		}
		if err != nil {
			// The server closing its side is the end of the desktop: RDP has no use for a connection open one way.
			// Through an SSH host that is all there may be to hear.
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) && !c.isClosed() {
				c.p.plugin.Log("upstream error: " + err.Error())
			}
			// The room goes back (the plugin hears of it) before the client hears that the desktop has ended.
			c.end()
			c.closeGracefully()
			return
		}
	}
}
