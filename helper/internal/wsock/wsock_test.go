// The WebSocket frames, both ways, however their bytes arrive; the limits a frame is held to before it is read (a
// control frame's 125 bytes, a data frame's limit); and the server's side: the upgrade it answers or refuses, and the
// messages it reads, put together from their fragments, with the pings and the close among them answered. Ported in
// part from the plugin's former test/unit/gateway.ts, whose frame reader this package now is.
package wsock

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

// frame is a frame as a peer writes it by hand: fin, the opcode, masked with key when there is one, and the length
// in its shortest form unless long asks for the 8-byte one.
func frame(fin bool, opcode byte, payload []byte, key []byte) []byte {
	first := opcode
	if fin {
		first |= 0x80
	}
	maskBit := byte(0)
	if key != nil {
		maskBit = 0x80
	}
	out := []byte{first}
	switch n := len(payload); {
	case n < 126:
		out = append(out, maskBit|byte(n))
	case n < 65536:
		out = append(out, maskBit|126, byte(n>>8), byte(n))
	default:
		out = append(out, maskBit|127)
		out = binary.BigEndian.AppendUint64(out, uint64(n))
	}
	if key == nil {
		return append(out, payload...)
	}
	out = append(out, key...)
	for i, b := range payload {
		out = append(out, b^key[i&3])
	}
	return out
}

func TestAcceptIsTheRFCsExample(t *testing.T) {
	// RFC 6455, 1.3.
	if got := Accept("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("Accept = %s", got)
	}
}

// AppendFrame writes each length in its own form (one byte to 125, two more to 65535, eight past that), masked for a
// client and not for a server, and ReadFrame gives back what went in, either way.
func TestFramesRoundTripInEachLengthForm(t *testing.T) {
	for _, size := range []int{0, 5, 125, 126, 300, 65535, 65536, 70000} {
		payload := bytes.Repeat([]byte{7}, size)
		for _, mask := range []bool{false, true} {
			wire := AppendFrame(nil, OpBinary, payload, mask)
			header := 2
			switch {
			case size >= 65536:
				header += 8
			case size >= 126:
				header += 2
			}
			if mask {
				header += 4
			}
			if len(wire) != header+size {
				t.Fatalf("%d bytes (masked %v): a frame of %d bytes, want %d", size, mask, len(wire), header+size)
			}
			if masked := wire[1]&0x80 != 0; masked != mask {
				t.Fatalf("%d bytes: the mask bit is %v, want %v", size, masked, mask)
			}
			if mask && size > 0 && bytes.Equal(wire[header:], payload) {
				t.Fatalf("%d bytes: masked, yet the payload went as it is", size)
			}
			f, err := ReadFrame(bufio.NewReader(bytes.NewReader(wire)), mask, 1<<20)
			if err != nil {
				t.Fatalf("%d bytes (masked %v): %v", size, mask, err)
			}
			if !f.Fin || f.Opcode != OpBinary || !bytes.Equal(f.Payload, payload) {
				t.Fatalf("%d bytes (masked %v): read back otherwise", size, mask)
			}
		}
	}
}

// A connection hands over what it has when it has it: a frame can come a byte per read, or cut anywhere between two
// reads, and still comes out whole, as do the frames after it.
func TestFramesComeOutWholeHoweverTheBytesArrive(t *testing.T) {
	var stream []byte
	var want [][]byte
	for i, size := range []int{1, 125, 126, 4000, 70000} {
		payload := bytes.Repeat([]byte{byte('a' + i)}, size)
		want = append(want, payload)
		stream = AppendFrame(stream, OpBinary, payload, true)
	}
	readAll := func(r *bufio.Reader) error {
		for i, payload := range want {
			f, err := ReadFrame(r, true, 1<<20)
			if err != nil {
				return err
			}
			if !bytes.Equal(f.Payload, payload) {
				return fmt.Errorf("frame %d came out otherwise", i)
			}
		}
		if _, err := ReadFrame(r, true, 1<<20); err != io.EOF {
			return fmt.Errorf("something after the last frame: %v", err)
		}
		return nil
	}
	// A byte per read, into the smallest buffer bufio takes.
	if err := readAll(bufio.NewReaderSize(iotest.OneByteReader(bytes.NewReader(stream)), 16)); err != nil {
		t.Fatal("a byte at a time:", err)
	}
	// Two reads, cut at every place within the first frames (and a few further on).
	for cut := 0; cut < 300; cut++ {
		r := io.MultiReader(iotest.HalfReader(bytes.NewReader(stream[:cut])), bytes.NewReader(stream[cut:]))
		if err := readAll(bufio.NewReader(r)); err != nil {
			t.Fatalf("cut at %d: %v", cut, err)
		}
	}
}

// A control frame (close, ping, pong) carries 125 bytes at most, and isn't fragmented: one that says otherwise is
// refused from its header, before any of its payload is read.
func TestControlFramesCarry125BytesAtMost(t *testing.T) {
	ping := bytes.Repeat([]byte{1}, 125)
	f, err := ReadFrame(bufio.NewReader(bytes.NewReader(frame(true, OpPing, ping, nil))), false, 1<<20)
	if err != nil || f.Opcode != OpPing || !bytes.Equal(f.Payload, ping) {
		t.Fatalf("a ping of 125 bytes: %v", err)
	}
	for name, header := range map[string][]byte{
		"a ping of 126 bytes":   {0x89, 126, 0, 126},
		"a ping of 200 bytes":   {0x89, 126, 0, 200},
		"a close of 64 KiB":     {0x88, 127, 0, 0, 0, 0, 0, 1, 0, 0},
		"a fragmented ping":     {0x09, 5},
		"a fragmented pong":     {0x0a, 0},
		"a pong of 126, masked": {0x8a, 0x80 | 126, 0, 126},
	} {
		// The header alone: the refusal can't wait for a payload that isn't there.
		if _, err := ReadFrame(bufio.NewReader(bytes.NewReader(header)), false, 1<<20); err == nil || !strings.Contains(err.Error(), "control frame") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A data frame over the limit is refused from its header too: a peer can't have a gigabyte read (or allocated) by
// saying it will send one.
func TestADataFrameOverTheLimitIsRefusedBeforeItIsRead(t *testing.T) {
	for _, header := range [][]byte{
		{0x82, 126, 0x10, 0x01},                                     // 4097 bytes
		{0x82, 127, 0, 0, 0, 0, 0x40, 0, 0, 0},                      // a gigabyte
		{0x82, 127, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, // more than there is
	} {
		if _, err := ReadFrame(bufio.NewReader(bytes.NewReader(header)), false, 4096); !errors.Is(err, ErrTooLarge) {
			t.Errorf("% x: %v", header, err)
		}
	}
	// At the limit, it is read.
	if _, err := ReadFrame(bufio.NewReader(bytes.NewReader(frame(true, OpBinary, make([]byte, 4096), nil))), false, 4096); err != nil {
		t.Error("a frame at the limit:", err)
	}
}

func TestReservedBitsAndUnmaskedClientFramesAreRefused(t *testing.T) {
	for _, rsv := range []byte{0x40, 0x20, 0x10} {
		wire := frame(true, OpBinary, []byte("x"), nil)
		wire[0] |= rsv
		if _, err := ReadFrame(bufio.NewReader(bytes.NewReader(wire)), false, 1<<20); err == nil || !strings.Contains(err.Error(), "reserved bits") {
			t.Errorf("reserved bit %#x: %v", rsv, err)
		}
	}
	// A server's reader wants its client's frames masked (RFC 6455 5.1); a client's takes a server's either way.
	plain := frame(true, OpBinary, []byte("x"), nil)
	if _, err := ReadFrame(bufio.NewReader(bytes.NewReader(plain)), true, 1<<20); err == nil || !strings.Contains(err.Error(), "unmasked") {
		t.Error("an unmasked frame read as a client's:", err)
	}
	masked := frame(true, OpBinary, []byte("xyz"), []byte{1, 2, 3, 4})
	if f, err := ReadFrame(bufio.NewReader(bytes.NewReader(masked)), false, 1<<20); err != nil || string(f.Payload) != "xyz" {
		t.Error("a masked frame read as a server's:", err)
	}
}

// upgraded is a server's Conn over a pipe, after an upgrade request from the other end, which the test then talks
// through: what it writes reaches the server's reader, and its reader gets the server's frames.
func upgraded(t *testing.T) (*Conn, net.Conn, *bufio.Reader) {
	t.Helper()
	server, client := net.Pipe()
	t.Cleanup(func() { _ = server.Close(); _ = client.Close() })
	go func() {
		_, _ = io.WriteString(client, "GET /token HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n"+
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	}()
	in := bufio.NewReader(client)
	answered := make(chan string, 1)
	go func() {
		var head []byte
		for !bytes.HasSuffix(head, []byte("\r\n\r\n")) {
			line, err := in.ReadSlice('\n')
			head = append(head, line...)
			if err != nil {
				break
			}
		}
		answered <- string(head)
	}()
	conn, err := Upgrade(server, time.Second, func(r *Request) bool { return r.Target == "/token" })
	if err != nil {
		t.Fatal(err)
	}
	if head := <-answered; !strings.HasPrefix(head, "HTTP/1.1 101 ") || !strings.Contains(head, "\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n") {
		t.Fatalf("the answer: %q", head)
	}
	return conn, client, in
}

// A message in fragments, with a ping between them: the ping is answered (unmasked, as a server's frames are), and
// the message comes out joined; a whole message after it comes as it is.
func TestTheServerJoinsFragmentsAndAnswersPings(t *testing.T) {
	conn, client, in := upgraded(t)
	key := []byte{9, 8, 7, 6}
	go func() {
		_, _ = client.Write(bytes.Join([][]byte{
			frame(false, OpBinary, []byte("hel"), key),
			frame(true, OpPing, []byte("are you there"), key),
			frame(false, OpContinuation, []byte("lo, "), key),
			frame(true, OpPong, []byte("unasked"), key),
			frame(true, OpContinuation, []byte("world"), key),
			frame(true, OpText, []byte("whole"), key),
		}, nil))
	}()
	pong := make(chan Frame, 1)
	go func() {
		f, _ := ReadFrame(in, false, 1<<20)
		pong <- f
	}()
	message, err := conn.ReadMessage(1 << 20)
	if err != nil || string(message) != "hello, world" {
		t.Fatalf("the message: %q, %v", message, err)
	}
	if f := <-pong; f.Opcode != OpPong || string(f.Payload) != "are you there" {
		t.Fatalf("the ping's answer: %+v", f)
	}
	if message, err := conn.ReadMessage(1 << 20); err != nil || string(message) != "whole" {
		t.Fatalf("the next message: %q, %v", message, err)
	}
}

// A message is held to the limit as a whole, its fragments counted together; the order of fragments is held to as well.
func TestTheServerRefusesWhatIsntAMessage(t *testing.T) {
	key := []byte{1, 1, 1, 1}
	for name, c := range map[string]struct {
		frames [][]byte
		want   string
	}{
		"fragments over the limit together":       {[][]byte{frame(false, OpBinary, make([]byte, 600), key), frame(true, OpContinuation, make([]byte, 600), key)}, ErrTooLarge.Error()},
		"a continuation without a message":        {[][]byte{frame(true, OpContinuation, []byte("x"), key)}, "continuation without a message"},
		"a new message before the last one ended": {[][]byte{frame(false, OpBinary, []byte("x"), key), frame(true, OpText, []byte("y"), key)}, "before the last one ended"},
		"an opcode of no frame":                   {[][]byte{frame(true, 0x3, []byte("x"), key)}, "unknown opcode"},
		"an unmasked frame":                       {[][]byte{frame(true, OpBinary, []byte("x"), nil)}, "unmasked"},
	} {
		conn, client, _ := upgraded(t)
		go func() { _, _ = client.Write(bytes.Join(c.frames, nil)) }()
		if _, err := conn.ReadMessage(1000); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A close from the client is answered with its own code, and nothing goes out after it; a close of the server's own
// goes once.
func TestTheServerAnswersACloseAndThenSendsNothing(t *testing.T) {
	conn, client, in := upgraded(t)
	go func() {
		_, _ = client.Write(frame(true, OpClose, []byte{0x0f, 0xa0, 'b', 'y', 'e'}, []byte{5, 6, 7, 8}))
	}()
	answer := make(chan Frame, 1)
	go func() {
		f, _ := ReadFrame(in, false, 1<<20)
		answer <- f
	}()
	if _, err := conn.ReadMessage(1 << 20); !errors.Is(err, ErrClosing) {
		t.Fatal("a close read as:", err)
	}
	if f := <-answer; f.Opcode != OpClose || !bytes.Equal(f.Payload, []byte{0x0f, 0xa0}) {
		t.Fatalf("the close's answer: %+v", f)
	}
	if err := conn.WriteMessage([]byte("late")); !errors.Is(err, net.ErrClosed) {
		t.Error("a message after the close:", err)
	}
	if err := conn.WriteClose(1000); !errors.Is(err, net.ErrClosed) {
		t.Error("a second close:", err)
	}
}

// What a request has to be for the upgrade, and the answers to one that isn't: 400 for what isn't a WebSocket
// request, 426 for another version, 401 for what allow turns away (which sees only well-formed requests).
func TestUpgradeAnswersOrRefuses(t *testing.T) {
	const good = "GET /t HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
	for name, c := range map[string]struct {
		request string
		allow   bool
		status  string
	}{
		"a well-formed request":           {good + "\r\n", true, "101"},
		"one allow turns away":            {good + "\r\n", false, "401"},
		"a POST":                          {strings.Replace(good, "GET", "POST", 1) + "\r\n", true, "400"},
		"HTTP/1.0":                        {strings.Replace(good, "HTTP/1.1", "HTTP/1.0", 1) + "\r\n", true, "400"},
		"no upgrade":                      {strings.Replace(good, "Upgrade: websocket\r\n", "", 1) + "\r\n", true, "400"},
		"a key that isn't 16 bytes":       {strings.Replace(good, "dGhlIHNhbXBsZSBub25jZQ==", "c2hvcnQ=", 1) + "\r\n", true, "400"},
		"another version":                 {strings.Replace(good, "Version: 13", "Version: 8", 1) + "\r\n", true, "426"},
		"tokens in other cases and lists": {strings.Replace(strings.Replace(good, "Upgrade: websocket", "Upgrade: WebSocket", 1), "Connection: Upgrade", "Connection: keep-alive, UPGRADE", 1) + "\r\n", true, "101"},
	} {
		server, client := net.Pipe()
		go func() { _, _ = io.WriteString(client, c.request) }()
		status := make(chan string, 1)
		go func() {
			line, _ := bufio.NewReader(client).ReadString('\n')
			status <- line
		}()
		allowed := false
		_, err := Upgrade(server, time.Second, func(*Request) bool { allowed = true; return c.allow })
		line := <-status
		if !strings.HasPrefix(line, "HTTP/1.1 "+c.status+" ") {
			t.Errorf("%s: answered %q (%v)", name, line, err)
		}
		if c.status == "101" && err != nil || c.status != "101" && !errors.Is(err, ErrRefused) {
			t.Errorf("%s: %v", name, err)
		}
		if allowed != (c.status == "101" || c.status == "401") {
			t.Errorf("%s: allow was asked: %v", name, allowed)
		}
		_ = server.Close()
		_ = client.Close()
	}
}

// A request whose header lines aren't lines (a CR or LF of their own inside one, a line without a name) isn't
// answered at all, and neither is one with a head larger than a server takes.
func TestUpgradeRefusesMalformedHeads(t *testing.T) {
	for name, request := range map[string]string{
		"a stray LF":            "GET /t HTTP/1.1\r\nHost: x\nUpgrade: websocket\r\n\r\n",
		"a stray CR":            "GET /t HTTP/1.1\r\nHost: x\rUpgrade: websocket\r\n\r\n",
		"a line without a name": "GET /t HTTP/1.1\r\n: x\r\n\r\n",
		"not a request line":    "GET /t\r\nHost: x\r\n\r\n",
		"a head over 16 KiB":    "GET /t HTTP/1.1\r\nX: " + strings.Repeat("a", 17<<10) + "\r\n\r\n",
	} {
		server, client := net.Pipe()
		go func() { _, _ = io.WriteString(client, request) }()
		go func() { _, _ = io.Copy(io.Discard, client) }()
		if _, err := Upgrade(server, time.Second, func(*Request) bool { return true }); err == nil || errors.Is(err, ErrRefused) {
			t.Errorf("%s: %v", name, err)
		}
		_ = server.Close()
		_ = client.Close()
	}
}

// A client that sends its first frame in the same write as its request: the frame is read, not lost with the request.
func TestFramesSentWithTheRequestAreRead(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	request := "GET /t HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
	go func() {
		_, _ = client.Write(append([]byte(request), frame(true, OpBinary, []byte("early"), []byte{1, 2, 3, 4})...))
	}()
	go func() { _, _ = io.Copy(io.Discard, client) }()
	conn, err := Upgrade(server, time.Second, func(*Request) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	if message, err := conn.ReadMessage(1 << 20); err != nil || string(message) != "early" {
		t.Fatalf("%q, %v", message, err)
	}
}
