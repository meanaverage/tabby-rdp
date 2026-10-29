// Package wsock is as much of WebSocket (RFC 6455) as the helper needs: the server IronRDP's web client connects to,
// and the frames of a client (an RD Gateway's tunnel, see package gateway). Binary and text messages, fragments,
// pings, close; no extensions. Written out here rather than taken from a module: the helper uses the standard library
// only.
package wsock

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"
)

// Opcodes.
const (
	OpContinuation byte = 0x0
	OpText         byte = 0x1
	OpBinary       byte = 0x2
	OpClose        byte = 0x8
	OpPing         byte = 0x9
	OpPong         byte = 0xa
)

// Accept is the Sec-WebSocket-Accept value for a key.
func Accept(key string) string {
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// Request is a WebSocket upgrade request, as much of it as the server looks at.
type Request struct {
	Method, Target, Proto string
	Header                map[string][]string
}

// Get is a header's first value ("" for none); name is lower case.
func (r *Request) Get(name string) string {
	if v := r.Header[name]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// What a request's head may be at most (Node's HTTP server takes 16 KiB).
const maxRequestHead = 16 << 10

// ErrRefused: the request wasn't let in (see Upgrade).
var ErrRefused = errors.New("the WebSocket request was refused")

func readRequest(r *bufio.Reader) (*Request, error) {
	var head []byte
	for {
		line, err := r.ReadSlice('\n')
		head = append(head, line...)
		if len(head) > maxRequestHead {
			return nil, errors.New("request head too large")
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return nil, err
		}
		if bytes.HasSuffix(head, []byte("\r\n\r\n")) {
			break
		}
	}
	lines := strings.Split(strings.TrimSuffix(string(head), "\r\n\r\n"), "\r\n")
	parts := strings.Split(lines[0], " ")
	if len(parts) != 3 {
		return nil, errors.New("not an HTTP request")
	}
	req := &Request{Method: parts[0], Target: parts[1], Proto: parts[2], Header: map[string][]string{}}
	for _, line := range lines[1:] {
		colon := strings.IndexByte(line, ':')
		if colon <= 0 || strings.ContainsAny(line, "\r\n") {
			return nil, errors.New("a malformed header")
		}
		name := strings.ToLower(line[:colon])
		req.Header[name] = append(req.Header[name], strings.TrimSpace(line[colon+1:]))
	}
	return req, nil
}

func hasToken(values []string, token string) bool {
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// Upgrade reads a WebSocket upgrade request from conn and answers it: let in if allow says so (allow sees it only once
// it is a well-formed upgrade), refused with 401 otherwise, as the ws module refuses what its verifyClient turns away.
// timeout bounds reading the request.
func Upgrade(conn net.Conn, timeout time.Duration, allow func(*Request) bool) (*Conn, error) {
	_ = conn.SetDeadline(time.Now().Add(timeout))
	in := bufio.NewReaderSize(conn, 64<<10)
	req, err := readRequest(in)
	if err != nil {
		return nil, err
	}
	refuse := func(status string) (*Conn, error) {
		_, _ = io.WriteString(conn, "HTTP/1.1 "+status+"\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n")
		return nil, ErrRefused
	}
	key := req.Get("sec-websocket-key")
	decoded, keyErr := base64.StdEncoding.DecodeString(key)
	if req.Method != "GET" || req.Proto != "HTTP/1.1" || !hasToken(req.Header["upgrade"], "websocket") ||
		!hasToken(req.Header["connection"], "upgrade") || keyErr != nil || len(decoded) != 16 {
		return refuse("400 Bad Request")
	}
	if req.Get("sec-websocket-version") != "13" {
		_, _ = io.WriteString(conn, "HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
		return nil, ErrRefused
	}
	if !allow(req) {
		return refuse("401 Unauthorized")
	}
	// Anything the client sent after its request is already in `in`, which the connection reads frames from.
	if _, err := io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+
		Accept(key)+"\r\n\r\n"); err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return &Conn{conn: conn, in: in, server: true}, nil
}

// Conn is the server's side of a WebSocket connection.
type Conn struct {
	conn   net.Conn
	in     *bufio.Reader
	server bool

	wmu       sync.Mutex
	closeSent bool
}

// NetConn is the connection under the WebSocket.
func (c *Conn) NetConn() net.Conn { return c.conn }

// Frame is one frame as read.
type Frame struct {
	Fin     bool
	Opcode  byte
	Payload []byte
}

// ErrTooLarge: a frame, or a message, larger than allowed.
var ErrTooLarge = errors.New("a WebSocket message larger than allowed")

// ReadFrame reads one frame. masked says whether frames must come masked (a server's reader: RFC 6455 5.1) or may
// come either way (a client's: a server's frames shouldn't be, which some gateways ignore). Data frames' payloads
// over limit, and control frames' over 125 bytes, are refused before they are read.
func ReadFrame(r *bufio.Reader, mustMask bool, limit uint64) (Frame, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return Frame{}, err
	}
	f := Frame{Fin: head[0]&0x80 != 0, Opcode: head[0] & 0x0f}
	if head[0]&0x70 != 0 {
		return f, errors.New("a WebSocket frame with reserved bits set")
	}
	masked := head[1]&0x80 != 0
	if mustMask && !masked {
		return f, errors.New("an unmasked WebSocket frame from a client")
	}
	length := uint64(head[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return f, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return f, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if f.Opcode >= 0x8 {
		if length > 125 || !f.Fin {
			return f, errors.New("a WebSocket control frame too large, or fragmented")
		}
	} else if length > limit {
		return f, ErrTooLarge
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return f, err
		}
	}
	f.Payload = make([]byte, length)
	if _, err := io.ReadFull(r, f.Payload); err != nil {
		return f, err
	}
	if masked {
		for i := range f.Payload {
			f.Payload[i] ^= mask[i&3]
		}
	}
	return f, nil
}

// AppendFrame appends a whole frame to dst: masked with a random key when mask (a client's frames), not otherwise.
func AppendFrame(dst []byte, opcode byte, payload []byte, mask bool) []byte {
	maskBit := byte(0)
	if mask {
		maskBit = 0x80
	}
	n := len(payload)
	dst = append(dst, 0x80|opcode)
	switch {
	case n < 126:
		dst = append(dst, maskBit|byte(n))
	case n < 65536:
		dst = append(dst, maskBit|126, byte(n>>8), byte(n))
	default:
		dst = append(dst, maskBit|127)
		dst = binary.BigEndian.AppendUint64(dst, uint64(n))
	}
	if !mask {
		return append(dst, payload...)
	}
	var key [4]byte
	_, _ = rand.Read(key[:])
	dst = append(dst, key[:]...)
	start := len(dst)
	dst = append(dst, payload...)
	for i := range payload {
		dst[start+i] ^= key[i&3]
	}
	return dst
}

// ErrClosing: the client sent a close frame (it was answered).
var ErrClosing = errors.New("the WebSocket client closed the connection")

// ReadMessage reads the next whole data message (fragments joined), answering pings and ignoring pongs on the way. A
// message over limit bytes fails with ErrTooLarge; a close from the client is answered and fails with ErrClosing.
func (c *Conn) ReadMessage(limit int) ([]byte, error) {
	var message []byte
	started := false
	for {
		f, err := ReadFrame(c.in, c.server, uint64(limit-len(message)))
		if err != nil {
			return nil, err
		}
		switch f.Opcode {
		case OpPing:
			if err := c.write(OpPong, f.Payload); err != nil {
				return nil, err
			}
		case OpPong:
		case OpClose:
			code := []byte{0x03, 0xe8}
			if len(f.Payload) >= 2 {
				code = f.Payload[:2]
			}
			_ = c.write(OpClose, code)
			return nil, ErrClosing
		case OpText, OpBinary:
			if started {
				return nil, errors.New("a new WebSocket message before the last one ended")
			}
			if f.Fin {
				return f.Payload, nil
			}
			started = true
			message = append(message, f.Payload...)
		case OpContinuation:
			if !started {
				return nil, errors.New("a WebSocket continuation without a message")
			}
			message = append(message, f.Payload...)
			if f.Fin {
				return message, nil
			}
		default:
			return nil, fmt.Errorf("a WebSocket frame of unknown opcode %d", f.Opcode)
		}
	}
}

func (c *Conn) write(opcode byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closeSent {
		return net.ErrClosed
	}
	if opcode == OpClose {
		c.closeSent = true
	}
	if c.server && len(payload) > 4096 {
		// A server's frame is its header and the payload as it is: written together, without copying the payload.
		buffers := net.Buffers{appendLength([]byte{0x80 | opcode}, len(payload)), payload}
		_, err := buffers.WriteTo(c.conn)
		return err
	}
	frame := AppendFrame(make([]byte, 0, len(payload)+10), opcode, payload, !c.server)
	_, err := c.conn.Write(frame)
	return err
}

// appendLength appends an unmasked frame's length field.
func appendLength(dst []byte, n int) []byte {
	switch {
	case n < 126:
		return append(dst, byte(n))
	case n < 65536:
		return append(dst, 126, byte(n>>8), byte(n))
	}
	dst = append(dst, 127)
	return binary.BigEndian.AppendUint64(dst, uint64(n))
}

// WriteMessage sends payload as one binary message.
func (c *Conn) WriteMessage(payload []byte) error {
	return c.write(OpBinary, payload)
}

// WriteClose starts the closing handshake: a close frame with code (1000: normal), or none (0), once.
func (c *Conn) WriteClose(code uint16) error {
	if code == 0 {
		return c.write(OpClose, nil)
	}
	return c.write(OpClose, []byte{byte(code >> 8), byte(code)})
}

// Close ends the connection at once.
func (c *Conn) Close() error { return c.conn.Close() }
