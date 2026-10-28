package ipc

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

// Stream is a byte stream the plugin carries for the helper (an SSH channel to a desktop or a gateway, say), as a
// net.Conn. Each way, the sender keeps within Window bytes the receiver hasn't acknowledged: what the plugin sends
// waits here until it is read, and Write waits while the plugin hasn't taken what was sent, so a stream that isn't
// read holds no more than that, here or in the plugin.
type Stream struct {
	p  *Peer
	id uint32

	mu   sync.Mutex
	cond *sync.Cond
	// What came from the plugin and hasn't been read: buf[off:].
	buf []byte
	off int
	// Read, and not yet acknowledged.
	consumed int
	// The plugin's END: no more bytes come.
	eof bool
	// The plugin closed the stream: why, as the error reads give once what came is read.
	remoteClosed bool
	rerr         error
	// Sent, and not yet acknowledged.
	unacked int
	closed  bool
	ended   bool
	// Why the stream failed here (closed with it), if it did: what reads and writes fail with.
	failure error

	readDeadline, writeDeadline time.Time
	readTimer, writeTimer       *time.Timer

	// One Write at a time, so that each one's bytes go in order.
	wmu sync.Mutex

	// Hears whenever the plugin took bytes (Unacknowledged went down); see SetOnAcknowledged.
	onAcknowledged func()
}

// SetOnAcknowledged has f hear whenever the plugin took bytes (Unacknowledged went down).
func (s *Stream) SetOnAcknowledged(f func()) {
	s.mu.Lock()
	s.onAcknowledged = f
	s.mu.Unlock()
}

func newStream(p *Peer, id uint32) *Stream {
	s := &Stream{p: p, id: id}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// ID is the stream's number, as the plugin knows it.
func (s *Stream) ID() uint32 { return s.id }

// Unacknowledged is how many bytes were written to the stream and the plugin hasn't taken yet.
func (s *Stream) Unacknowledged() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.unacked
}

func (s *Stream) remoteData(b []byte) {
	s.mu.Lock()
	if s.closed || s.remoteClosed {
		s.mu.Unlock()
		return
	}
	if len(s.buf)-s.off+len(b) > Window {
		// The plugin sent past the window: its bug, and nothing to keep waiting on. The stream fails here, and the
		// plugin is told, so that its own stream (an SSH channel) ends too rather than wait on a stream gone.
		s.closed = true
		s.failure = errors.New("the plugin sent more than the stream's window")
		s.buf, s.off = nil, 0
		s.cond.Broadcast()
		s.mu.Unlock()
		s.p.forgetStream(s.id)
		go func() { _ = s.p.writeFrame(TypeClose, s.id, []byte(s.failure.Error())) }()
		return
	}
	defer s.mu.Unlock()
	if s.off > 0 && s.off == len(s.buf) {
		s.buf, s.off = s.buf[:0], 0
	} else if s.off > len(s.buf)/2 && cap(s.buf)-len(s.buf) < len(b) {
		n := copy(s.buf, s.buf[s.off:])
		s.buf, s.off = s.buf[:n], 0
	}
	s.buf = append(s.buf, b...)
	s.cond.Broadcast()
}

func (s *Stream) remoteAck(n int) {
	s.mu.Lock()
	s.unacked -= n
	if s.unacked < 0 {
		s.unacked = 0
	}
	s.cond.Broadcast()
	hook := s.onAcknowledged
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
}

func (s *Stream) remoteEnd() {
	s.mu.Lock()
	s.eof = true
	s.cond.Broadcast()
	s.mu.Unlock()
}

func (s *Stream) remoteClose(why string) {
	s.mu.Lock()
	if !s.remoteClosed {
		s.remoteClosed = true
		if why != "" {
			s.rerr = errors.New(why)
		} else {
			s.rerr = io.EOF
		}
	}
	s.cond.Broadcast()
	s.mu.Unlock()
	s.p.forgetStream(s.id)
}

func expired(deadline time.Time) bool {
	return !deadline.IsZero() && !time.Now().Before(deadline)
}

// Read reads what the plugin sent: io.EOF after its END, or the error it closed the stream with.
func (s *Stream) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	s.mu.Lock()
	for s.off == len(s.buf) && !s.eof && !s.remoteClosed && !s.closed && !expired(s.readDeadline) {
		s.cond.Wait()
	}
	if !s.closed && expired(s.readDeadline) {
		// As a net.Conn's: past its deadline, a read fails, whatever is there to read.
		s.mu.Unlock()
		return 0, os.ErrDeadlineExceeded
	}
	if s.closed {
		err := s.failure
		s.mu.Unlock()
		if err == nil {
			err = net.ErrClosed
		}
		return 0, err
	}
	if s.off < len(s.buf) {
		n := copy(b, s.buf[s.off:])
		s.off += n
		s.consumed += n
		ack := 0
		// Acknowledged in steps, and whenever all of it was read, so that a sender waiting for room gets it soon.
		if s.consumed >= Window/4 || s.off == len(s.buf) {
			ack, s.consumed = s.consumed, 0
		}
		s.mu.Unlock()
		if ack > 0 {
			var count [4]byte
			binary.BigEndian.PutUint32(count[:], uint32(ack))
			_ = s.p.writeFrame(TypeAck, s.id, count[:])
		}
		return n, nil
	}
	defer s.mu.Unlock()
	if s.remoteClosed {
		return 0, s.rerr
	}
	if s.eof {
		return 0, io.EOF
	}
	return 0, os.ErrDeadlineExceeded
}

// Write sends b to the plugin, waiting while it hasn't taken Window bytes of what was sent.
func (s *Stream) Write(b []byte) (int, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	written := 0
	for written < len(b) {
		s.mu.Lock()
		for s.unacked >= Window && !s.closed && !s.remoteClosed && !s.ended && !expired(s.writeDeadline) {
			s.cond.Wait()
		}
		switch {
		case s.closed:
			err := s.failure
			s.mu.Unlock()
			if err == nil {
				err = net.ErrClosed
			}
			return written, err
		case s.remoteClosed:
			err := s.rerr
			s.mu.Unlock()
			if err == io.EOF {
				err = io.ErrClosedPipe
			}
			return written, err
		case s.ended:
			s.mu.Unlock()
			return written, io.ErrClosedPipe
		case s.unacked >= Window || expired(s.writeDeadline):
			s.mu.Unlock()
			return written, os.ErrDeadlineExceeded
		}
		n := min(len(b)-written, MaxData, Window-s.unacked)
		s.unacked += n
		s.mu.Unlock()
		if err := s.p.writeFrame(TypeData, s.id, b[written:written+n]); err != nil {
			return written, err
		}
		written += n
	}
	return written, nil
}

// CloseWrite tells the plugin no more bytes come (its stream ends), and leaves reading as it is.
func (s *Stream) CloseWrite() error {
	s.mu.Lock()
	if s.ended || s.closed || s.remoteClosed {
		s.mu.Unlock()
		return nil
	}
	// A writer waiting for credit gives up; one sending a frame finishes it, before the END.
	s.ended = true
	s.cond.Broadcast()
	s.mu.Unlock()
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return s.p.writeFrame(TypeEnd, s.id)
}

// Forget lets go of a stream the plugin never opened (it answered with another way to the server): nothing is sent.
func (s *Stream) Forget() {
	s.mu.Lock()
	s.closed = true
	s.cond.Broadcast()
	s.mu.Unlock()
	s.p.forgetStream(s.id)
}

// Close ends the stream both ways, and has the plugin end its own (an SSH channel's, say).
func (s *Stream) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	tell := !s.remoteClosed
	s.buf, s.off = nil, 0
	for _, t := range []*time.Timer{s.readTimer, s.writeTimer} {
		if t != nil {
			t.Stop()
		}
	}
	s.cond.Broadcast()
	s.mu.Unlock()
	s.p.forgetStream(s.id)
	if tell {
		return s.p.writeFrame(TypeClose, s.id)
	}
	return nil
}

type streamAddr struct{ id uint32 }

func (streamAddr) Network() string  { return "plugin" }
func (a streamAddr) String() string { return "plugin stream" }

func (s *Stream) LocalAddr() net.Addr  { return streamAddr{s.id} }
func (s *Stream) RemoteAddr() net.Addr { return streamAddr{s.id} }

func (s *Stream) SetDeadline(t time.Time) error {
	_ = s.SetReadDeadline(t)
	return s.SetWriteDeadline(t)
}

func (s *Stream) setDeadline(deadline *time.Time, timer **time.Timer, t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	*deadline = t
	if *timer != nil {
		(*timer).Stop()
		*timer = nil
	}
	if !t.IsZero() {
		*timer = time.AfterFunc(time.Until(t), func() {
			s.mu.Lock()
			s.cond.Broadcast()
			s.mu.Unlock()
		})
	}
	s.cond.Broadcast()
}

func (s *Stream) SetReadDeadline(t time.Time) error {
	s.setDeadline(&s.readDeadline, &s.readTimer, t)
	return nil
}

func (s *Stream) SetWriteDeadline(t time.Time) error {
	s.setDeadline(&s.writeDeadline, &s.writeTimer, t)
	return nil
}
