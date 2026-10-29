// The proxy against a stand-in plugin, a stand-in RDP server (X.224, then TLS) and a WebSocket client standing in for
// IronRDP's, for what the race detector should see: the relay both ways, the room's reports, a certificate refused, a
// client that leaves, a server that ends, and the proxy closed under its clients. The plugin's own tests
// (test/unit/proxy.ts and the rest) run the same proxy end to end through the plugin's side.
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/meanaverage/tabby-rdp/helper/internal/ntlm"
	"github.com/meanaverage/tabby-rdp/helper/internal/rdp"
	"github.com/meanaverage/tabby-rdp/helper/internal/wsock"
)

// plugin is the stand-in plugin: it reaches the server by a TCP connection of the proxy's, takes any certificate
// unless told otherwise, and keeps what it hears.
type plugin struct {
	mu       sync.Mutex
	port     int
	refuse   error
	failures []string
	logs     []string
	closed   []uint32
	flows    []Flow
	checked  int
}

func (p *plugin) Open(ctx context.Context, conn uint32, destination string) (Route, error) {
	return Route{Direct: &Direct{Host: "127.0.0.1", Port: p.port, Label: "server", Addresses: []string{"127.0.0.1"}}}, nil
}
func (p *plugin) WithoutNLA(ctx context.Context, conn uint32) error { return errors.New("refused") }
func (p *plugin) Certificate(ctx context.Context, conn uint32, scope string, chain []*x509.Certificate, chainOK bool, reason string, nla *bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.checked++
	return p.refuse
}
func (p *plugin) GatewayAccount(ctx context.Context, conn uint32) (ntlm.Account, error) {
	return ntlm.Account{}, errors.New("no gateway here")
}
func (p *plugin) Failure(ctx context.Context, conn uint32, stage, message string, signIn bool) {
	p.mu.Lock()
	p.failures = append(p.failures, stage+": "+message)
	p.mu.Unlock()
}
func (p *plugin) Log(message string) {
	p.mu.Lock()
	p.logs = append(p.logs, message)
	p.mu.Unlock()
}
func (p *plugin) Accepted(conn uint32) {}
func (p *plugin) Closed(conn uint32) {
	p.mu.Lock()
	p.closed = append(p.closed, conn)
	p.mu.Unlock()
}
func (p *plugin) GatewayOpened(conn uint32) {}
func (p *plugin) Flow(f Flow) {
	p.mu.Lock()
	p.flows = append(p.flows, f)
	p.mu.Unlock()
}

func (p *plugin) saw(what func() bool) bool {
	for i := 0; i < 200; i++ {
		p.mu.Lock()
		ok := what()
		p.mu.Unlock()
		if ok {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// server is a stand-in RDP server: it answers the connection request choosing CredSSP, does TLS, then runs serve.
func server(t *testing.T, serve func(*tls.Conn)) int {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "server.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	config := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				request := make([]byte, 11)
				if _, err := io.ReadFull(conn, request); err != nil {
					return
				}
				_, _ = conn.Write([]byte{3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 2, 0, 8, 0, 2, 0, 0, 0})
				secure := tls.Server(conn, config)
				if secure.Handshake() != nil {
					return
				}
				serve(secure)
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// wsClient is a WebSocket client standing in for IronRDP's.
type wsClient struct {
	conn net.Conn
	in   *bufio.Reader
}

func connect(t *testing.T, p *Proxy, path string) (*wsClient, error) {
	t.Helper()
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", p.Port()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	key := base64.StdEncoding.EncodeToString(make([]byte, 16))
	fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nOrigin: file://\r\n\r\n", path, key)
	in := bufio.NewReader(conn)
	status, err := in.ReadString('\n')
	if err != nil {
		return nil, err
	}
	for {
		line, err := in.ReadString('\n')
		if err != nil {
			return nil, err
		}
		if line == "\r\n" {
			break
		}
	}
	if !strings.Contains(status, " 101 ") {
		return nil, errors.New(strings.TrimSpace(status))
	}
	return &wsClient{conn: conn, in: in}, nil
}

func (c *wsClient) send(payload []byte) error {
	_, err := c.conn.Write(wsock.AppendFrame(nil, wsock.OpBinary, payload, true))
	return err
}

// next is the next message, or the close (nil, io.EOF).
func (c *wsClient) next() ([]byte, error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	f, err := wsock.ReadFrame(c.in, false, 64<<20)
	if err != nil {
		return nil, err
	}
	if f.Opcode == wsock.OpClose {
		return nil, io.EOF
	}
	return f.Payload, nil
}

func der(tag byte, content []byte) []byte {
	n := len(content)
	if n < 128 {
		return append([]byte{tag, byte(n)}, content...)
	}
	return append([]byte{tag, 0x81, byte(n)}, content...)
}

func request(token string) []byte {
	return der(0x30, bytes.Join([][]byte{
		der(0xa0, der(0x02, []byte{0x0d, 0x3e})),
		der(0xa2, der(0x0c, []byte("server:3389"))),
		der(0xa3, der(0x0c, []byte(token))),
		der(0xa6, der(0x04, []byte{3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0})),
	}, nil))
}

func start(t *testing.T, p *plugin) *Proxy {
	t.Helper()
	proxy, err := Start(p, Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(proxy.Close)
	return proxy
}

func TestRelayBothWays(t *testing.T) {
	received := make(chan []byte, 1)
	p := &plugin{}
	p.port = server(t, func(c *tls.Conn) {
		// Two PDUs in one write: the client gets them as two messages.
		_, _ = c.Write(append([]byte{3, 0, 0, 6, 1, 2}, 3, 0, 0, 5, 9))
		got := make([]byte, 5)
		if _, err := io.ReadFull(c, got); err == nil {
			received <- got
		}
		big := make([]byte, 1<<20)
		for i := 0; i < len(big); i += 16384 {
			copy(big[i:], []byte{3, 0, 0x40, 0})
		}
		_, _ = c.Write(big)
		time.Sleep(100 * time.Millisecond)
	})
	proxy := start(t, p)
	c, err := connect(t, proxy, "/"+proxy.Token())
	if err != nil {
		t.Fatal(err)
	}
	_ = c.send(request(proxy.Token()))
	response, err := c.next()
	if err != nil || response[0] != 0x30 {
		t.Fatalf("%x %v", response, err)
	}
	for _, want := range [][]byte{{3, 0, 0, 6, 1, 2}, {3, 0, 0, 5, 9}} {
		if got, err := c.next(); err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%x, want %x: %v", got, want, err)
		}
	}
	_ = c.send([]byte("hello"))
	select {
	case got := <-received:
		if string(got) != "hello" {
			t.Fatal(string(got))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the server got nothing")
	}
	total := 0
	for total < 1<<20 {
		m, err := c.next()
		if err != nil {
			t.Fatal(err)
		}
		total += len(m)
	}
	// The server's end ends the client's connection.
	if _, err := c.next(); err != io.EOF {
		t.Fatal(err)
	}
	if !p.saw(func() bool {
		for _, f := range p.flows {
			if f.BytesIn >= 1<<20 && f.BytesOut >= 5 {
				return true
			}
		}
		return false
	}) {
		t.Errorf("no report of the bytes relayed: %+v", p.flows)
	}
	if !p.saw(func() bool { return len(p.closed) == 1 }) {
		t.Error("the plugin didn't hear of the end")
	}
}

func TestRefusedCertificateAndBadToken(t *testing.T) {
	got := make(chan int, 4)
	p := &plugin{refuse: errors.New("not the certificate remembered")}
	p.port = server(t, func(c *tls.Conn) {
		n, _ := io.Copy(io.Discard, c)
		got <- int(n)
	})
	proxy := start(t, p)
	c, err := connect(t, proxy, "/"+proxy.Token())
	if err != nil {
		t.Fatal(err)
	}
	_ = c.send(request(proxy.Token()))
	_ = c.send([]byte("early"))
	if m, err := c.next(); err != nil || !bytes.Equal(m, rdp.EncodeError()) {
		t.Fatalf("%x %v", m, err)
	}
	if n := <-got; n != 0 {
		t.Errorf("the refused server got %d bytes", n)
	}
	p.mu.Lock()
	failures := strings.Join(p.failures, "\n")
	p.mu.Unlock()
	if !strings.Contains(failures, "handshake: not the certificate remembered") {
		t.Error(failures)
	}
	// Without the token in the path: turned away at the upgrade.
	if _, err := connect(t, proxy, "/"+strings.Repeat("0", len(proxy.Token()))); err == nil || !strings.Contains(err.Error(), "401") {
		t.Error(err)
	}
	// With it, but a wrong one in the request.
	c, _ = connect(t, proxy, "/"+proxy.Token())
	_ = c.send(request("wrong"))
	if m, _ := c.next(); !bytes.Equal(m, rdp.EncodeError()) {
		t.Error("no RDCleanPath error for a wrong token")
	}
}

func TestClientLeavesAndProxyCloses(t *testing.T) {
	ended := make(chan struct{}, 4)
	p := &plugin{}
	p.port = server(t, func(c *tls.Conn) {
		_, _ = io.Copy(io.Discard, c)
		ended <- struct{}{}
	})
	proxy := start(t, p)
	for i := 0; i < 3; i++ {
		c, err := connect(t, proxy, "/"+proxy.Token())
		if err != nil {
			t.Fatal(err)
		}
		_ = c.send(request(proxy.Token()))
		if _, err := c.next(); err != nil {
			t.Fatal(err)
		}
		// Data on its way, then the client goes: the server's connection goes with it.
		for j := 0; j < 20; j++ {
			_ = c.send(make([]byte, 64<<10))
		}
		c.conn.Close()
		select {
		case <-ended:
		case <-time.After(5 * time.Second):
			t.Fatal("the server's connection outlived the client")
		}
	}
	// A client relaying when the proxy closes: ended too.
	c, _ := connect(t, proxy, "/"+proxy.Token())
	_ = c.send(request(proxy.Token()))
	_, _ = c.next()
	proxy.Close()
	if _, err := c.next(); err == nil {
		t.Error("the client outlived the proxy")
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the server's connection outlived the proxy")
	}
	// Each connection that reached the relay had the room, and gave it back at its end.
	if !p.saw(func() bool {
		resets := 0
		for _, f := range p.flows {
			if f.Reset {
				resets++
			}
		}
		return resets >= 4
	}) {
		t.Errorf("%+v", p.flows)
	}
}
