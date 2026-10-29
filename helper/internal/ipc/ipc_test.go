// The channel to the plugin, against a stand-in for the plugin's side (src/proxyHelper.ts) on a pair of pipes:
// messages with blobs, requests both ways and their errors, a stream's bytes within its window each way, its end and
// its close, and what waits on the channel when it ends.
package ipc

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// plugin is the stand-in: it reads the helper's frames as they come (the plugin reads at all times), and writes its
// own.
type plugin struct {
	t      *testing.T
	frames chan frame
	out    io.WriteCloser
}

type frame struct {
	typ     byte
	id      uint32
	payload []byte
}

func (p *plugin) readAll(in *bufio.Reader) {
	for {
		var header [headerSize]byte
		if _, err := io.ReadFull(in, header[:]); err != nil {
			close(p.frames)
			return
		}
		f := frame{typ: header[4], id: binary.BigEndian.Uint32(header[5:]), payload: make([]byte, binary.BigEndian.Uint32(header[0:])-5)}
		if _, err := io.ReadFull(in, f.payload); err != nil {
			close(p.frames)
			return
		}
		p.frames <- f
	}
}

func (p *plugin) read() frame {
	p.t.Helper()
	select {
	case f, ok := <-p.frames:
		if !ok {
			p.t.Fatal("the helper's side closed")
		}
		return f
	case <-time.After(5 * time.Second):
		p.t.Fatal("no frame from the helper")
	}
	return frame{}
}

func (p *plugin) message() *Message {
	p.t.Helper()
	f := p.read()
	if f.typ != TypeMessage {
		p.t.Fatalf("frame of type %d, not a message", f.typ)
	}
	m, err := decodeMessage(f.payload)
	if err != nil {
		p.t.Fatal(err)
	}
	return m
}

func (p *plugin) write(typ byte, id uint32, payload []byte) {
	var header [headerSize]byte
	binary.BigEndian.PutUint32(header[0:], uint32(5+len(payload)))
	header[4] = typ
	binary.BigEndian.PutUint32(header[5:], id)
	if _, err := p.out.Write(append(header[:], payload...)); err != nil {
		p.t.Fatal(err)
	}
}

func (p *plugin) send(env Envelope, body any, blobs ...[]byte) {
	if body != nil {
		env.Body, _ = json.Marshal(body)
	}
	for _, b := range blobs {
		env.Blobs = append(env.Blobs, len(b))
	}
	text, _ := json.Marshal(env)
	payload := binary.BigEndian.AppendUint32(nil, uint32(len(text)))
	payload = append(payload, text...)
	for _, b := range blobs {
		payload = append(payload, b...)
	}
	p.write(TypeMessage, 0, payload)
}

func (p *plugin) ack(id uint32, n int) {
	p.write(TypeAck, id, binary.BigEndian.AppendUint32(nil, uint32(n)))
}

// pair is a peer running on pipes, and the stand-in plugin at their other ends.
func pair(t *testing.T) (*Peer, *plugin, chan error) {
	toHelper, fromPlugin := io.Pipe()
	toPlugin, fromHelper := io.Pipe()
	peer := NewPeer(toHelper, fromHelper)
	done := make(chan error, 1)
	go func() { done <- peer.Run() }()
	t.Cleanup(func() { fromPlugin.Close(); toPlugin.Close() })
	p := &plugin{t: t, frames: make(chan frame, 1024), out: fromPlugin}
	go p.readAll(bufio.NewReader(toPlugin))
	return peer, p, done
}

func TestMessagesCarryBlobs(t *testing.T) {
	peer, plugin, _ := pair(t)
	go func() { _ = peer.Hello("1.2.3") }()
	hello := plugin.message()
	var body struct {
		Protocol int    `json:"protocol"`
		Version  string `json:"version"`
	}
	if err := hello.Decode(&body); err != nil || hello.Type != "hello" || body.Protocol != Protocol || body.Version != "1.2.3" {
		t.Fatalf("%+v %+v %v", hello.Envelope, body, err)
	}
	// A request from the helper, with two blobs (binary, not in the JSON), answered with one.
	answered := make(chan *Message, 1)
	go func() {
		m, err := peer.Request(context.Background(), "certificate", map[string]any{"conn": 1}, []byte{0, 1, 2}, []byte("\xff\xfe"))
		if err != nil {
			t.Error(err)
		}
		answered <- m
	}()
	request := plugin.message()
	if request.Method != "certificate" || len(request.Data) != 2 || string(request.Data[0]) != "\x00\x01\x02" || string(request.Data[1]) != "\xff\xfe" {
		t.Fatalf("%+v %q", request.Envelope, request.Data)
	}
	if strings.Contains(string(request.Body), "\\u") {
		t.Error("binary data in the JSON")
	}
	plugin.send(Envelope{Type: "response", ID: request.ID}, map[string]int{"ok": 1}, []byte("blob"))
	m := <-answered
	if string(m.Data[0]) != "blob" {
		t.Errorf("%q", m.Data)
	}
}

func TestRequestErrorsAndCodes(t *testing.T) {
	peer, plugin, _ := pair(t)
	failed := make(chan error, 1)
	go func() {
		_, err := peer.Request(context.Background(), "open", nil)
		failed <- err
	}()
	request := plugin.message()
	plugin.send(Envelope{Type: "response", ID: request.ID, Error: "The SSH connection is not open", Code: "x"}, nil)
	var remote *RemoteError
	if err := <-failed; !errors.As(err, &remote) || remote.Message != "The SSH connection is not open" || remote.Code != "x" {
		t.Fatalf("%v", err)
	}
	// A request given up on: its late answer goes nowhere, and nothing waits on it.
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_, err := peer.Request(ctx, "open", nil)
		failed <- err
	}()
	late := plugin.message()
	cancel()
	if err := <-failed; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	plugin.send(Envelope{Type: "response", ID: late.ID}, nil)
	// The plugin's requests reach the handler, which answers them (errors with their codes).
	peer.OnRequest = func(m *Message) { _ = peer.Respond(m.ID, nil, codedError{}) }
	plugin.send(Envelope{Type: "request", ID: 7, Method: "start"}, nil)
	response := plugin.message()
	if response.Type != "response" || response.ID != 7 || response.Error != "refused" || response.Code != "signIn" {
		t.Fatalf("%+v", response.Envelope)
	}
}

type codedError struct{}

func (codedError) Error() string     { return "refused" }
func (codedError) ErrorCode() string { return "signIn" }

func TestStreamWindowEachWay(t *testing.T) {
	peer, plugin, _ := pair(t)
	s := peer.NewStream()
	// The helper writes more than the window: past it, Write waits for the plugin to take some.
	written := make(chan int, 1)
	go func() {
		n, err := s.Write(make([]byte, Window+MaxData))
		if err != nil {
			t.Error(err)
		}
		written <- n
	}()
	got := 0
	for got < Window {
		f := plugin.read()
		if f.typ != TypeData || f.id != s.ID() || len(f.payload) > MaxData {
			t.Fatalf("frame %d of %d bytes", f.typ, len(f.payload))
		}
		got += len(f.payload)
	}
	select {
	case <-written:
		t.Fatal("wrote past the window")
	case <-time.After(50 * time.Millisecond):
	}
	if s.Unacknowledged() != Window {
		t.Errorf("unacknowledged %d", s.Unacknowledged())
	}
	plugin.ack(s.ID(), MaxData)
	if f := plugin.read(); len(f.payload) != MaxData {
		t.Fatalf("%d", len(f.payload))
	}
	if n := <-written; n != Window+MaxData {
		t.Fatal(n)
	}
	// The plugin's bytes wait in the stream until read, and are acknowledged once read.
	plugin.write(TypeData, s.ID(), []byte("hello"))
	buf := make([]byte, 3)
	if n, err := s.Read(buf); n != 3 || err != nil || string(buf) != "hel" {
		t.Fatal(n, err)
	}
	if n, _ := s.Read(buf); n != 2 || string(buf[:2]) != "lo" {
		t.Fatal(n)
	}
	if f := plugin.read(); f.typ != TypeAck || binary.BigEndian.Uint32(f.payload) != 5 {
		t.Fatalf("%d %x", f.typ, f.payload)
	}
	// Past the window from the plugin: its bug, which ends the stream rather than having it kept, and tells the
	// plugin so. Read only once the helper has taken all of it in (frames are dispatched in order: a request sent
	// after them is handled after them), so that reading doesn't make room meanwhile.
	plugin.write(TypeData, s.ID(), make([]byte, MaxData))
	for i := 0; i < Window/MaxData; i++ {
		plugin.write(TypeData, s.ID(), make([]byte, MaxData))
	}
	dispatched := make(chan struct{})
	peer.OnRequest = func(m *Message) { close(dispatched) }
	plugin.send(Envelope{Type: "request", ID: 99, Method: "mark"}, nil)
	select {
	case <-dispatched:
	case <-time.After(5 * time.Second):
		t.Fatal("the frames were never dispatched")
	}
	_ = s.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := s.Read(make([]byte, Window*2)); err == nil || !strings.Contains(err.Error(), "window") {
		t.Errorf("%v", err)
	}
	for f := plugin.read(); ; f = plugin.read() {
		if f.typ == TypeClose && f.id == s.ID() {
			if !strings.Contains(string(f.payload), "window") {
				t.Errorf("the plugin was told %q", f.payload)
			}
			break
		}
	}
}

func TestStreamEndAndClose(t *testing.T) {
	peer, plugin, _ := pair(t)
	s := peer.NewStream()
	plugin.write(TypeData, s.ID(), []byte("last"))
	plugin.write(TypeEnd, s.ID(), nil)
	data, err := io.ReadAll(s)
	if string(data) != "last" || err != nil {
		t.Fatalf("%q %v", data, err)
	}
	// It can still be written to: END is one way only.
	if _, err := s.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	for f := plugin.read(); f.typ != TypeData; f = plugin.read() {
	}
	// The plugin's close, with why: what came first is read, then its error.
	other := peer.NewStream()
	plugin.write(TypeData, other.ID(), []byte("ab"))
	plugin.write(TypeClose, other.ID(), []byte("the SSH connection closed"))
	buf := make([]byte, 8)
	if n, err := other.Read(buf); n != 2 || err != nil {
		t.Fatal(n, err)
	}
	if _, err := other.Read(buf); err == nil || err.Error() != "the SSH connection closed" {
		t.Fatal(err)
	}
	if _, err := other.Write([]byte("x")); err == nil {
		t.Error("written after the plugin closed it")
	}
	// The helper's close tells the plugin; Forget doesn't.
	third, fourth := peer.NewStream(), peer.NewStream()
	fourth.Forget()
	_ = third.Close()
	for {
		f := plugin.read()
		if f.typ == TypeClose {
			if f.id != third.ID() {
				t.Fatalf("closed %d", f.id)
			}
			break
		}
	}
	if _, err := third.Read(buf); !errors.Is(err, net.ErrClosed) {
		t.Error(err)
	}
}

func TestStreamDeadlines(t *testing.T) {
	peer, _, _ := pair(t)
	s := peer.NewStream()
	_ = s.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	started := time.Now()
	if _, err := s.Read(make([]byte, 1)); !errors.Is(err, os.ErrDeadlineExceeded) || time.Since(started) > time.Second {
		t.Fatal(err)
	}
}

func TestChannelEnd(t *testing.T) {
	peer, plugin, done := pair(t)
	s := peer.NewStream()
	waiting := make(chan error, 1)
	go func() {
		_, err := peer.Request(context.Background(), "open", nil)
		waiting <- err
	}()
	plugin.message()
	// The plugin goes: its end of the channel closes.
	plugin.out.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-waiting; !errors.Is(err, ErrClosed) {
		t.Fatal(err)
	}
	if _, err := s.Read(make([]byte, 1)); err == nil {
		t.Error("a stream outlived the channel")
	}
	if _, err := peer.Request(context.Background(), "open", nil); !errors.Is(err, ErrClosed) {
		t.Error(err)
	}
}

func TestMalformedFramesEndTheChannel(t *testing.T) {
	for name, frame := range map[string][]byte{
		"too large":    append(binary.BigEndian.AppendUint32(nil, MaxFrame+6), 2, 0, 0, 0, 1),
		"unknown type": {0, 0, 0, 5, 9, 0, 0, 0, 0},
		"bad message":  {0, 0, 0, 7, 1, 0, 0, 0, 0, 0, 0},
	} {
		peer, plugin, done := pair(t)
		_ = peer
		go func() { _, _ = plugin.out.Write(frame) }()
		select {
		case err := <-done:
			if err == nil {
				t.Errorf("%s: no error", name)
			}
		case <-time.After(time.Second):
			t.Errorf("%s: the channel went on", name)
		}
	}
}

// A message whose JSON is said to be longer than the message, by any amount (past 2^31 too, which on a 32-bit system
// would be a negative int), is refused rather than sliced.
func TestMessageLengthOutOfRange(t *testing.T) {
	for _, declared := range []uint32{3, 1 << 31, 0xffffffff} {
		payload := binary.BigEndian.AppendUint32(nil, declared)
		payload = append(payload, '{', '}')
		if _, err := decodeMessage(payload); err == nil {
			t.Errorf("length %#x: decoded", declared)
		}
	}
}
