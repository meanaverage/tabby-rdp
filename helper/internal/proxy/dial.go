package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

// Direct is a server reached with a TCP connection from this computer: its addresses, as the plugin resolved its name
// (with the system's resolver, as Node did: the hosts file, mDNS, a VPN's DNS), and how it is shown.
type Direct struct {
	Host      string   `json:"host"`
	Port      int      `json:"port"`
	Label     string   `json:"label"`
	Addresses []string `json:"addresses"`
}

// dialTimeout: how long reaching the server may take.
const dialTimeout = 15 * time.Second

// attemptDelay: how long one address is tried before the next is tried alongside it (Node's autoSelectFamily).
const attemptDelay = 250 * time.Millisecond

// errnoName is the system's name for a connection's failure, as Node reports it (ECONNREFUSED), or "".
func errnoName(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			return "ETIMEDOUT"
		}
		return ""
	}
	if runtime.GOOS == "windows" {
		// Winsock's codes.
		switch uintptr(errno) {
		case 10061:
			return "ECONNREFUSED"
		case 10060:
			return "ETIMEDOUT"
		case 10065:
			return "EHOSTUNREACH"
		case 10051:
			return "ENETUNREACH"
		case 10054:
			return "ECONNRESET"
		case 10049:
			return "EADDRNOTAVAIL"
		case 10013:
			return "EACCES"
		}
		return ""
	}
	switch errno {
	case syscall.ECONNREFUSED:
		return "ECONNREFUSED"
	case syscall.ETIMEDOUT:
		return "ETIMEDOUT"
	case syscall.EHOSTUNREACH:
		return "EHOSTUNREACH"
	case syscall.ENETUNREACH:
		return "ENETUNREACH"
	case syscall.ECONNRESET:
		return "ECONNRESET"
	case syscall.EADDRNOTAVAIL:
		return "EADDRNOTAVAIL"
	case syscall.EACCES:
		return "EACCES"
	}
	return ""
}

// connectError is a failure to connect to address, in Node's words (`connect ECONNREFUSED 10.0.0.5:3389`).
func connectError(err error, address string, port int) error {
	if name := errnoName(err); name != "" {
		return fmt.Errorf("connect %s %s:%d", name, address, port)
	}
	var op *net.OpError
	if errors.As(err, &op) && op.Err != nil {
		return fmt.Errorf("connect %s:%d: %v", address, port, op.Err)
	}
	return fmt.Errorf("connect %s:%d: %v", address, port, err)
}

// dial connects to d: each of its addresses in turn, the next one started alongside once the one before has had
// attemptDelay (or failed), the first to answer taken. 15 seconds in all, as before; keepalive notices a dead peer
// (sleep, a dropped VPN) where the SSH path has the SSH connection's.
func dial(ctx context.Context, d Direct) (net.Conn, error) {
	if len(d.Addresses) == 0 {
		return nil, fmt.Errorf("%s has no address", d.Label)
	}
	ctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	dialer := net.Dialer{KeepAliveConfig: net.KeepAliveConfig{Enable: true, Idle: 10 * time.Second, Interval: time.Second, Count: 10}}
	type result struct {
		conn net.Conn
		err  error
	}
	results := make(chan result, len(d.Addresses))
	started := 0
	start := func() {
		address := d.Addresses[started]
		started++
		go func() {
			conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(address, strconv.Itoa(d.Port)))
			if err != nil {
				err = connectError(err, address, d.Port)
			}
			results <- result{conn, err}
		}()
	}
	start()
	var firstErr error
	pending := 1
	timer := time.NewTimer(attemptDelay)
	defer timer.Stop()
	for pending > 0 {
		select {
		case r := <-results:
			pending--
			if r.err == nil {
				// The others, if any connect after all, are let go.
				go func(n int) {
					for i := 0; i < n; i++ {
						if late := <-results; late.conn != nil {
							_ = late.conn.Close()
						}
					}
				}(pending)
				if tcp, ok := r.conn.(*net.TCPConn); ok {
					_ = tcp.SetNoDelay(true)
				}
				return r.conn, nil
			}
			if firstErr == nil {
				firstErr = r.err
			}
			if started < len(d.Addresses) && ctx.Err() == nil {
				start()
				pending++
				timer.Reset(attemptDelay)
			}
		case <-timer.C:
			if started < len(d.Addresses) {
				start()
				pending++
				timer.Reset(attemptDelay)
			}
		}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, fmt.Errorf("%s did not answer", d.Label)
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, firstErr
}
