// tabby-rdp-proxy is the plugin's network helper: the RDCleanPath proxy IronRDP's web client connects to, with the
// connections to RDP servers and RD Gateways behind it (see internal/proxy). The plugin starts one per desktop, with
// the protocol it speaks as an argument, and talks to it on its stdin and stdout (see internal/ipc). It ends when its
// stdin does: when the plugin closes it, or when Tabby's window goes away.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"sync"
	"time"

	"crypto/x509"

	"github.com/meanaverage/tabby-rdp/helper/internal/certs"
	"github.com/meanaverage/tabby-rdp/helper/internal/gateway"
	"github.com/meanaverage/tabby-rdp/helper/internal/ipc"
	"github.com/meanaverage/tabby-rdp/helper/internal/ntlm"
	"github.com/meanaverage/tabby-rdp/helper/internal/proxy"
)

// version is the plugin's version this helper was built with (scripts/build-helper.mjs sets it).
var version = "dev"

func main() {
	protocol := flag.Int("protocol", 0, "the protocol the plugin speaks on stdin and stdout")
	showVersion := flag.Bool("version", false, "print the version and the protocol, and exit")
	flag.Parse()
	if *showVersion {
		fmt.Printf("tabby-rdp-proxy %s (protocol %d)\n", version, ipc.Protocol)
		return
	}
	if *protocol != ipc.Protocol {
		fmt.Fprintf(os.Stderr, "tabby-rdp-proxy %s speaks protocol %d; the plugin asked for %d\n", version, ipc.Protocol, *protocol)
		os.Exit(3)
	}
	peer := ipc.NewPeer(os.Stdin, os.Stdout)
	h := &host{peer: peer}
	peer.OnRequest = h.request
	if err := peer.Hello(version); err != nil {
		os.Exit(1)
	}
	err := peer.Run()
	h.close()
	if err != nil {
		fmt.Fprintln(os.Stderr, "tabby-rdp-proxy:", err)
		os.Exit(1)
	}
}

// host is the helper's one proxy, and what the plugin asks of it.
type host struct {
	peer *ipc.Peer

	mu    sync.Mutex
	proxy *proxy.Proxy
}

func (h *host) close() {
	h.mu.Lock()
	p := h.proxy
	h.mu.Unlock()
	if p != nil {
		p.Close()
	}
}

func (h *host) request(m *ipc.Message) {
	switch m.Method {
	case "start":
		var body struct {
			Autologon          bool   `json:"autologon"`
			ServerName         string `json:"serverName"`
			HandshakeTimeoutMs int    `json:"handshakeTimeoutMs"`
			Trace              bool   `json:"trace"`
		}
		if err := m.Decode(&body); err != nil {
			_ = h.peer.Respond(m.ID, nil, err)
			return
		}
		roots := &certs.Roots{Pool: x509.NewCertPool()}
		if len(m.Data) > 0 {
			roots = certs.ParseRoots(m.Data[0])
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.proxy != nil {
			_ = h.peer.Respond(m.ID, nil, errors.New("the proxy is running already"))
			return
		}
		options := proxy.Options{
			Autologon:        body.Autologon,
			ServerName:       body.ServerName,
			HandshakeTimeout: time.Duration(body.HandshakeTimeoutMs) * time.Millisecond,
			Roots:            roots,
		}
		if body.Trace {
			options.Tap = func(direction string, data []byte, kind string) {
				for len(data) > 0 {
					part := data
					if len(part) > 1<<20 {
						part = part[:1<<20]
					}
					_ = h.peer.Send(ipc.Envelope{Type: "event", Event: "tap"},
						map[string]any{"direction": direction, "kind": kind}, part)
					data = data[len(part):]
				}
			}
		}
		p, err := proxy.Start(&plugin{peer: h.peer}, options)
		if err != nil {
			_ = h.peer.Respond(m.ID, nil, err)
			return
		}
		h.proxy = p
		_ = h.peer.Respond(m.ID, map[string]any{"port": p.Port(), "token": p.Token()}, nil)
	case "shutdown":
		h.close()
		_ = h.peer.Respond(m.ID, map[string]any{}, nil)
	default:
		_ = h.peer.Respond(m.ID, nil, fmt.Errorf("unknown method %q", m.Method))
	}
}

// plugin is proxy.Plugin over the channel to the plugin.
type plugin struct{ peer *ipc.Peer }

type direct struct {
	proxy.Direct
	Kind string `json:"kind"`
}

func (p *plugin) Open(ctx context.Context, conn uint32, destination string) (proxy.Route, error) {
	stream := p.peer.NewStream()
	m, err := p.peer.Request(ctx, "open", map[string]any{"conn": conn, "destination": destination, "stream": stream.ID()})
	if err != nil {
		// A stream the plugin opened after all, once nobody waited for it, ends here.
		_ = stream.Close()
		return proxy.Route{}, err
	}
	var answer struct {
		direct
		Gateway    *gateway.Endpoint `json:"gateway"`
		Target     *gateway.Endpoint `json:"target"`
		ClientName string            `json:"clientName"`
		TimeoutMs  int               `json:"timeoutMs"`
		Via        *direct           `json:"via"`
	}
	if err := m.Decode(&answer); err != nil {
		_ = stream.Close()
		return proxy.Route{}, err
	}
	way := func(d *direct) (proxy.Route, error) {
		switch d.Kind {
		case "stream":
			return proxy.Route{Conn: stream}, nil
		case "direct":
			stream.Forget()
			return proxy.Route{Direct: &d.Direct}, nil
		}
		_ = stream.Close()
		return proxy.Route{}, fmt.Errorf("the plugin gave an unknown way to the server (%q)", d.Kind)
	}
	if answer.Kind != "gateway" {
		return way(&answer.direct)
	}
	if answer.Gateway == nil || answer.Target == nil || answer.Via == nil {
		_ = stream.Close()
		return proxy.Route{}, errors.New("the plugin gave a gateway without its address, its target or the way to it")
	}
	via, err := way(answer.Via)
	if err != nil {
		return proxy.Route{}, err
	}
	return proxy.Route{Gateway: &proxy.GatewayRoute{
		Gateway: *answer.Gateway, Target: *answer.Target, ClientName: answer.ClientName,
		Timeout: time.Duration(answer.TimeoutMs) * time.Millisecond, Via: via,
	}}, nil
}

func (p *plugin) WithoutNLA(ctx context.Context, conn uint32) error {
	_, err := p.peer.Request(ctx, "withoutNla", map[string]any{"conn": conn})
	return err
}

func (p *plugin) Certificate(ctx context.Context, conn uint32, scope string, chain []*x509.Certificate, chainOK bool, reason string, nla *bool) error {
	raw := make([][]byte, len(chain))
	for i, c := range chain {
		raw[i] = c.Raw
	}
	_, err := p.peer.Request(ctx, "certificate", map[string]any{"conn": conn, "scope": scope, "chainOk": chainOK, "reason": reason, "nla": nla}, raw...)
	return err
}

func (p *plugin) GatewayAccount(ctx context.Context, conn uint32) (ntlm.Account, error) {
	m, err := p.peer.Request(ctx, "gatewayAccount", map[string]any{"conn": conn})
	if err != nil {
		return ntlm.Account{}, err
	}
	var account struct {
		Username string `json:"username"`
		Domain   string `json:"domain"`
		Password string `json:"password"`
	}
	if err := m.Decode(&account); err != nil {
		return ntlm.Account{}, err
	}
	return ntlm.Account{Username: account.Username, Domain: account.Domain, Password: account.Password}, nil
}

func (p *plugin) Failure(ctx context.Context, conn uint32, stage, message string, signIn bool) {
	_, _ = p.peer.Request(ctx, "failure", map[string]any{"conn": conn, "stage": stage, "message": message, "signIn": signIn})
}

func (p *plugin) Log(message string) { _ = p.peer.Event("log", map[string]any{"message": message}) }

func (p *plugin) Accepted(conn uint32) { _ = p.peer.Event("accepted", map[string]any{"conn": conn}) }

func (p *plugin) Closed(conn uint32) { _ = p.peer.Event("closed", map[string]any{"conn": conn}) }

func (p *plugin) GatewayOpened(conn uint32) {
	_ = p.peer.Event("gatewayOpened", map[string]any{"conn": conn})
}

func (p *plugin) Flow(f proxy.Flow) { _ = p.peer.Event("flow", f) }
