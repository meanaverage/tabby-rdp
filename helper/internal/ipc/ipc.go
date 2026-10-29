// Package ipc is the helper's side of its channel to the plugin: binary frames on the helper's stdin and stdout.
//
// A frame is a 4-byte big-endian length (of everything after it), a type byte, a 4-byte big-endian id, then the
// payload. Messages (requests, their responses, events) are JSON, with any binary data they carry (a certificate
// chain, trust roots) appended after the JSON as raw bytes and listed by length in its "blobs"; a stream's bytes go in
// frames of their own, never in JSON. Each side reads whatever comes at all times, so neither waits on the other to
// read; a stream's sender keeps within a window of bytes the receiver hasn't acknowledged (see Stream).
//
// The plugin's side is src/proxyHelper.ts; the two change together, and Protocol says which version they speak.
package ipc

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// Protocol is the version of this channel. The plugin passes the one it speaks as an argument and checks the one in
// the helper's hello; any change to frames or messages that the other side could misread changes it.
const Protocol = 2

// Frame types.
const (
	// TypeMessage: JSON (an Envelope), its length first (4 bytes), then the blobs it lists.
	TypeMessage byte = 1
	// TypeData: a stream's bytes, at most MaxData of them.
	TypeData byte = 2
	// TypeAck: the receiver has taken this many (4 bytes) of a stream's bytes: the sender may send as many more.
	TypeAck byte = 3
	// TypeEnd: the sender has no more bytes for the stream (it may still read).
	TypeEnd byte = 4
	// TypeClose: the stream is over, both ways; the payload, if any, says why (an error's text).
	TypeClose byte = 5
)

const (
	headerSize = 9
	// MaxFrame is what a frame's payload may be at most: a message with the trust roots of a computer with a large
	// store is the largest by far (a megabyte or so).
	MaxFrame = 16 << 20
	// MaxData is what one data frame carries at most.
	MaxData = 64 << 10
	// Window is how many of a stream's bytes may be sent and not yet acknowledged, each way.
	Window = 1 << 20
)

// Envelope is a message's JSON.
type Envelope struct {
	// "hello", "request", "response" or "event".
	Type string `json:"type"`
	// A request's number, which its response repeats. Each side numbers its own requests.
	ID     uint32 `json:"id,omitempty"`
	Method string `json:"method,omitempty"`
	Event  string `json:"event,omitempty"`
	// A response's error, for the request's caller; Code says what kind of error it is, where that matters.
	Error string          `json:"error,omitempty"`
	Code  string          `json:"code,omitempty"`
	Body  json.RawMessage `json:"body,omitempty"`
	// The length of each blob that follows the JSON.
	Blobs []int `json:"blobs,omitempty"`
}

// Message is a message as read: its envelope and its blobs.
type Message struct {
	Envelope
	Data [][]byte
}

// Decode reads the message's body into v.
func (m *Message) Decode(v any) error {
	if len(m.Body) == 0 {
		return nil
	}
	return json.Unmarshal(m.Body, v)
}

// RemoteError is the error a response carried.
type RemoteError struct {
	Message string
	Code    string
}

func (e *RemoteError) Error() string { return e.Message }

// ErrClosed is what waits on the peer fail with once the channel has ended.
var ErrClosed = errors.New("the plugin's channel to the helper closed")

// Peer is one end of the channel.
type Peer struct {
	in  io.Reader
	wmu sync.Mutex
	out *bufio.Writer

	mu      sync.Mutex
	nextID  uint32
	pending map[uint32]chan *Message
	streams map[uint32]*Stream
	nextSID uint32
	done    chan struct{}
	ended   bool

	// OnRequest handles a request from the plugin, in a goroutine of its own; it answers with Respond.
	OnRequest func(m *Message)
	// OnEvent handles an event from the plugin, in the reading goroutine.
	OnEvent func(m *Message)
}

// NewPeer makes a peer that reads frames from in and writes them to out.
func NewPeer(in io.Reader, out io.Writer) *Peer {
	return &Peer{
		in:      in,
		out:     bufio.NewWriterSize(out, 128<<10),
		pending: map[uint32]chan *Message{},
		streams: map[uint32]*Stream{},
		done:    make(chan struct{}),
	}
}

// Done is closed once the channel has ended (the plugin closed it, or it failed).
func (p *Peer) Done() <-chan struct{} { return p.done }

func (p *Peer) writeFrame(typ byte, id uint32, parts ...[]byte) error {
	length := 5
	for _, part := range parts {
		length += len(part)
	}
	if length-5 > MaxFrame {
		return fmt.Errorf("a frame of %d bytes is too large", length-5)
	}
	var header [headerSize]byte
	binary.BigEndian.PutUint32(header[0:], uint32(length))
	header[4] = typ
	binary.BigEndian.PutUint32(header[5:], id)
	p.wmu.Lock()
	defer p.wmu.Unlock()
	select {
	case <-p.done:
		return ErrClosed
	default:
	}
	if _, err := p.out.Write(header[:]); err != nil {
		return err
	}
	for _, part := range parts {
		if _, err := p.out.Write(part); err != nil {
			return err
		}
	}
	return p.out.Flush()
}

// Send writes a message: env with body as its JSON body, and blobs after it.
func (p *Peer) Send(env Envelope, body any, blobs ...[]byte) error {
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		env.Body = raw
	}
	env.Blobs = nil
	for _, blob := range blobs {
		env.Blobs = append(env.Blobs, len(blob))
	}
	text, err := json.Marshal(env)
	if err != nil {
		return err
	}
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(text)))
	return p.writeFrame(TypeMessage, 0, append([][]byte{length[:], text}, blobs...)...)
}

// Hello is the first message the helper sends.
func (p *Peer) Hello(version string) error {
	return p.Send(Envelope{Type: "hello"}, map[string]any{"protocol": Protocol, "version": version})
}

// Event sends an event to the plugin.
func (p *Peer) Event(name string, body any) error {
	return p.Send(Envelope{Type: "event", Event: name}, body)
}

// Respond answers the plugin's request id: with body (and blobs), or with err.
func (p *Peer) Respond(id uint32, body any, err error, blobs ...[]byte) error {
	env := Envelope{Type: "response", ID: id}
	if err != nil {
		env.Error = err.Error()
		var coded interface{ ErrorCode() string }
		if errors.As(err, &coded) {
			env.Code = coded.ErrorCode()
		}
		return p.Send(env, nil)
	}
	return p.Send(env, body, blobs...)
}

// Request sends a request to the plugin and waits for its response, ctx's end, or the channel's. A response that
// carries an error comes back as a *RemoteError.
func (p *Peer) Request(ctx context.Context, method string, body any, blobs ...[]byte) (*Message, error) {
	// Nothing is asked for what is no longer waited for.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p.mu.Lock()
	if p.ended {
		p.mu.Unlock()
		return nil, ErrClosed
	}
	p.nextID++
	id := p.nextID
	reply := make(chan *Message, 1)
	p.pending[id] = reply
	p.mu.Unlock()
	forget := func() {
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
	}
	if err := p.Send(Envelope{Type: "request", ID: id, Method: method}, body, blobs...); err != nil {
		forget()
		return nil, err
	}
	select {
	case m := <-reply:
		if m.Error != "" {
			return nil, &RemoteError{Message: m.Error, Code: m.Code}
		}
		return m, nil
	case <-ctx.Done():
		forget()
		return nil, ctx.Err()
	case <-p.done:
		forget()
		return nil, ErrClosed
	}
}

// NewStream makes a stream, numbered by the helper, for the plugin to put bytes through once it knows the number
// (in the request that asks it to open one). Bytes for it that come before it is used wait in it.
func (p *Peer) NewStream() *Stream {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nextSID++
	s := newStream(p, p.nextSID)
	if p.ended {
		s.remoteClosed = true
		s.rerr = ErrClosed
	}
	p.streams[s.id] = s
	return s
}

func (p *Peer) stream(id uint32) *Stream {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.streams[id]
}

func (p *Peer) forgetStream(id uint32) {
	p.mu.Lock()
	delete(p.streams, id)
	p.mu.Unlock()
}

// Run reads frames until the channel ends, and returns why (nil when the plugin closed it). Everything waiting on
// the peer is let go then: requests fail with ErrClosed, streams as closed.
func (p *Peer) Run() error {
	err := p.read()
	p.mu.Lock()
	p.ended = true
	streams := p.streams
	p.streams = map[uint32]*Stream{}
	p.mu.Unlock()
	// Not under the writer's lock: a write blocked on a plugin that has stopped reading mustn't hold up the end.
	close(p.done)
	for _, s := range streams {
		s.remoteClose("")
	}
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (p *Peer) read() error {
	in := bufio.NewReaderSize(p.in, 256<<10)
	var header [headerSize]byte
	scratch := make([]byte, MaxData)
	for {
		if _, err := io.ReadFull(in, header[:]); err != nil {
			return err
		}
		length := binary.BigEndian.Uint32(header[0:])
		if length < 5 || length-5 > MaxFrame {
			return fmt.Errorf("a frame of %d bytes from the plugin", length)
		}
		typ, id, size := header[4], binary.BigEndian.Uint32(header[5:]), int(length-5)
		var payload []byte
		if typ == TypeData && size <= len(scratch) {
			// Copied into the stream as it is delivered: read into one buffer, over and over.
			payload = scratch[:size]
		} else {
			payload = make([]byte, size)
		}
		if _, err := io.ReadFull(in, payload); err != nil {
			return err
		}
		if err := p.dispatch(typ, id, payload); err != nil {
			return err
		}
	}
}

func (p *Peer) dispatch(typ byte, id uint32, payload []byte) error {
	switch typ {
	case TypeMessage:
		m, err := decodeMessage(payload)
		if err != nil {
			return err
		}
		switch m.Type {
		case "response":
			p.mu.Lock()
			reply := p.pending[m.ID]
			delete(p.pending, m.ID)
			p.mu.Unlock()
			// A response to a request no longer waited on (it was given up) goes nowhere.
			if reply != nil {
				reply <- m
			}
		case "request":
			if p.OnRequest != nil {
				go p.OnRequest(m)
			} else {
				_ = p.Respond(m.ID, nil, fmt.Errorf("unknown method %q", m.Method))
			}
		case "event":
			if p.OnEvent != nil {
				p.OnEvent(m)
			}
		}
	case TypeData:
		if s := p.stream(id); s != nil {
			s.remoteData(payload)
		}
	case TypeAck:
		if len(payload) != 4 {
			return fmt.Errorf("an acknowledgement of %d bytes", len(payload))
		}
		if s := p.stream(id); s != nil {
			// No more than the window can be outstanding: a larger count (negative as an int on a 32-bit system) is
			// taken as all of it.
			s.remoteAck(int(min(binary.BigEndian.Uint32(payload), Window)))
		}
	case TypeEnd:
		if s := p.stream(id); s != nil {
			s.remoteEnd()
		}
	case TypeClose:
		if s := p.stream(id); s != nil {
			s.remoteClose(string(payload))
		}
	default:
		return fmt.Errorf("a frame of unknown type %d", typ)
	}
	return nil
}

func decodeMessage(payload []byte) (*Message, error) {
	if len(payload) < 4 {
		return nil, errors.New("a message without its length")
	}
	// Compared before it becomes an int: on a 32-bit system a length past 2^31 would be negative.
	declared := binary.BigEndian.Uint32(payload)
	if uint64(declared) > uint64(len(payload)-4) {
		return nil, errors.New("a message cut short")
	}
	length := int(declared)
	m := &Message{}
	if err := json.Unmarshal(payload[4:4+length], &m.Envelope); err != nil {
		return nil, fmt.Errorf("a message that isn't JSON: %w", err)
	}
	rest := payload[4+length:]
	for _, size := range m.Blobs {
		if size < 0 || size > len(rest) {
			return nil, errors.New("a message whose blobs don't add up")
		}
		m.Data = append(m.Data, rest[:size:size])
		rest = rest[size:]
	}
	if len(rest) != 0 {
		return nil, errors.New("a message whose blobs don't add up")
	}
	return m, nil
}
