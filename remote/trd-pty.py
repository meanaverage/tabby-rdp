#!/usr/bin/env python3
"""trd-pty: a shell session that outlives its terminals and can be shown in several at once.

A session is one small process that owns a PTY running the user's login shell and listens on a Unix
socket in a private per-user directory (0700; peers must have the same uid). Terminals attach with
`trd-pty attach`:

- output from the shell goes, byte for byte, to every attached terminal;
- input from any attached terminal goes to the shell;
- the PTY size follows the *controlling* terminal: the one that attached, typed or was focused last,
  so terminals of different sizes never fight over it;
- a terminal that attaches late first gets a bounded replay of recent output, then a forced redraw
  (full-screen programs repaint on the size change).

Lifetime matches a plain SSH login: the shell gets SIGHUP when its last terminal detaches (set
TRD_PTY_LINGER=<seconds> to keep it around for a reattach), and the session ends when the shell exits.

  trd-pty new           start a session running the login shell and attach this terminal
                        (exit 0: the session ended; 3: no session could be started)
  trd-pty attach ID     attach this terminal to session ID
  trd-pty ls            list sessions (id, attached terminals, shell pid, cwd)
  trd-pty clients ID    print how many terminals are attached to session ID
"""
import errno
import fcntl
import json
import os
import pty
import secrets
import selectors
import signal
import socket
import struct
import sys
import termios
import time
import tty

REPLAY_BYTES = 256 * 1024       # recent output replayed to a terminal that attaches late
MAX_FRAME = 1024 * 1024         # larger frames are treated as a broken client
MAX_BACKLOG = 8 * 1024 * 1024   # a terminal this far behind is dropped rather than stalling the others
QUIET_AFTER_REPLAY = 0.3        # seconds: drop input right after a replay (the terminal's automatic
                                # answers to replayed queries, e.g. cursor position reports)
HEADER = struct.Struct('!cI')
SIZE = struct.Struct('!HH')

# client -> session: h hello(rows, cols, claim) | i input | r resize(rows, cols) | c claim control | q query
# session -> client: o output | x exit(status) | q query answer (json)


def runtime_dir():
    """Private per-user directory for session sockets; refuses anything another user could touch."""
    uid = os.getuid()
    base = os.environ.get('XDG_RUNTIME_DIR')
    if not base or not os.path.isdir(base) or os.stat(base).st_uid != uid:
        base = '/tmp'
    path = os.path.join(base, 'trd-pty' if base != '/tmp' else f'trd-pty-{uid}')
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(path)
    if not os.path.isdir(path) or os.path.islink(path) or st.st_uid != uid or st.st_mode & 0o077:
        sys.exit(f'trd-pty: unsafe session directory {path}')
    return path


def socket_path(session_id):
    if not session_id or not all(c in '0123456789abcdef' for c in session_id):
        sys.exit(f'trd-pty: bad session id {session_id!r}')
    return os.path.join(runtime_dir(), session_id + '.sock')


def frame(kind, payload=b''):
    return HEADER.pack(kind, len(payload)) + payload


class Frames:
    """Splits a byte stream into (kind, payload) frames."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        self.buf += data
        frames = []
        while len(self.buf) >= HEADER.size:
            kind, length = HEADER.unpack_from(self.buf)
            if length > MAX_FRAME:
                raise ValueError('frame too large')
            if len(self.buf) < HEADER.size + length:
                break
            frames.append((kind, bytes(self.buf[HEADER.size:HEADER.size + length])))
            del self.buf[:HEADER.size + length]
        return frames


def term_size(fd):
    try:
        rows, cols, _, _ = struct.unpack('HHHH', fcntl.ioctl(fd, termios.TIOCGWINSZ, b'\0' * 8))
        return rows or 24, cols or 80
    except OSError:
        return 24, 80


# ---- session owner -------------------------------------------------------------------------------

class Client:
    def __init__(self, sock):
        self.sock = sock
        self.frames = Frames()
        self.out = bytearray()
        self.hello = False
        self.size = (24, 80)
        self.quiet_until = 0.0
        self.active = time.monotonic()


class Session:
    def __init__(self, session_id, path, rows, cols, cwd, env):
        self.id = session_id
        self.path = path
        self.sel = selectors.DefaultSelector()
        self.clients = {}
        self.controller = None
        self.replay = bytearray()
        self.to_shell = bytearray()
        self.size = None
        self.linger = float(os.environ.get('TRD_PTY_LINGER', '0') or 0)
        self.empty_since = None

        shell = env.get('SHELL') or '/bin/sh'
        pid, fd = pty.fork()
        if pid == 0:  # the shell
            try:
                os.chdir(cwd)
            except OSError:
                pass
            env = dict(env, TRD_SESSION=session_id, TRD_SOCKET=path)
            os.execve(shell, ['-' + os.path.basename(shell)], env)  # login shell, like a fresh SSH login
        self.pid, self.master = pid, fd
        os.set_blocking(fd, False)
        self.apply_size(rows, cols)

        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old_umask = os.umask(0o177)
        try:
            self.listener.bind(path)
        finally:
            os.umask(old_umask)
        self.listener.listen(8)
        self.listener.setblocking(False)
        self.sel.register(self.listener, selectors.EVENT_READ, 'accept')
        self.sel.register(self.master, selectors.EVENT_READ, 'pty')

    # -- pty

    def apply_size(self, rows, cols, force=False):
        if (rows, cols) == self.size and not force:
            return
        if force and (rows, cols) == self.size and rows > 1:
            # Same size: nudge it so full-screen programs still get SIGWINCH and repaint.
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows - 1, cols, 0, 0))
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.size = (rows, cols)

    def take_control(self, client, force=False):
        self.controller = client
        self.apply_size(*client.size, force=force)

    def from_shell(self):
        try:
            data = os.read(self.master, 65536)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                return True
            data = b''  # EIO: the shell side is gone
        if not data:
            return False
        self.replay += data
        if len(self.replay) > REPLAY_BYTES:
            del self.replay[:len(self.replay) - REPLAY_BYTES]
            # Start the replay at a line boundary, not inside an escape sequence or character.
            nl = self.replay.find(b'\n')
            if 0 <= nl < 4096:
                del self.replay[:nl + 1]
        out = frame(b'o', data)
        for client in list(self.clients.values()):
            if client.hello:
                self.send(client, out)
        return True

    def write_shell(self, data):
        self.to_shell += data
        self.flush_shell()

    def flush_shell(self):
        try:
            while self.to_shell:
                n = os.write(self.master, self.to_shell)
                del self.to_shell[:n]
        except OSError as e:
            if e.errno not in (errno.EAGAIN, errno.EINTR):
                self.to_shell.clear()
        events = selectors.EVENT_READ | (selectors.EVENT_WRITE if self.to_shell else 0)
        self.sel.modify(self.master, events, 'pty')

    # -- clients

    def accept(self):
        try:
            sock, _ = self.listener.accept()
        except OSError:
            return
        if hasattr(socket, 'SO_PEERCRED'):
            _, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                sock.close()
                return
        sock.setblocking(False)
        client = Client(sock)
        self.clients[sock] = client
        self.sel.register(sock, selectors.EVENT_READ, client)

    def send(self, client, data):
        client.out += data
        if len(client.out) > MAX_BACKLOG:
            self.drop(client)
            return
        self.flush(client)

    def flush(self, client):
        try:
            while client.out:
                n = client.sock.send(client.out)
                del client.out[:n]
        except BlockingIOError:
            pass
        except OSError:
            self.drop(client)
            return
        if client.sock in self.clients:
            events = selectors.EVENT_READ | (selectors.EVENT_WRITE if client.out else 0)
            self.sel.modify(client.sock, events, client)

    def drop(self, client):
        if self.clients.pop(client.sock, None) is None:
            return
        try:
            self.sel.unregister(client.sock)
        except (KeyError, ValueError):
            pass
        client.sock.close()
        if self.controller is client:
            self.controller = None
            rest = [c for c in self.clients.values() if c.hello]
            if rest:
                self.take_control(max(rest, key=lambda c: c.active))
        if not any(c.hello for c in self.clients.values()):
            self.empty_since = time.monotonic()

    def from_client(self, client):
        try:
            data = client.sock.recv(65536)
        except BlockingIOError:
            return
        except OSError:
            data = b''
        if not data:
            self.drop(client)
            return
        try:
            frames = client.frames.feed(data)
        except ValueError:
            self.drop(client)
            return
        for kind, payload in frames:
            try:
                self.handle(client, kind, payload)
            except (struct.error, ValueError):
                self.drop(client)  # malformed: this client goes, the session stays
                return

    def handle(self, client, kind, payload):
        now = time.monotonic()
        if kind == b'q':
            info = {'id': self.id, 'pid': self.pid, 'clients': sum(c.hello for c in self.clients.values())}
            try:
                info['cwd'] = os.readlink(f'/proc/{self.pid}/cwd')
            except OSError:
                pass
            self.send(client, frame(b'q', json.dumps(info).encode()))
            return
        if kind == b'h' and not client.hello:
            rows, cols, claim = struct.unpack('!HHB', payload)
            client.hello = True
            client.size = (max(rows, 1), max(cols, 1))
            client.active = now
            self.empty_since = None
            if self.replay:
                self.send(client, frame(b'o', bytes(self.replay)))
                client.quiet_until = now + QUIET_AFTER_REPLAY
            if claim or self.controller is None:
                self.take_control(client, force=True)
            return
        if not client.hello:
            raise ValueError('frame before hello')
        if kind == b'i':
            if now < client.quiet_until:
                return
            client.active = now
            if self.controller is not client:
                self.take_control(client)
            self.write_shell(payload)
        elif kind == b'r':
            rows, cols = SIZE.unpack(payload)
            client.size = (max(rows, 1), max(cols, 1))
            if self.controller is client:
                self.apply_size(*client.size)
        elif kind == b'c':
            client.active = now
            if self.controller is not client:
                self.take_control(client)
        else:
            raise ValueError('unknown frame')

    # -- main loop

    def run(self):
        status = 0
        try:
            while True:
                timeout = None
                if self.empty_since is not None:
                    left = self.linger - (time.monotonic() - self.empty_since)
                    if left <= 0:
                        os.killpg(os.getpgid(self.pid), signal.SIGHUP)  # like a dropped SSH connection
                        self.empty_since = None
                    else:
                        timeout = left
                for key, events in self.sel.select(timeout):
                    if key.data == 'accept':
                        self.accept()
                    elif key.data == 'pty':
                        if events & selectors.EVENT_WRITE:
                            self.flush_shell()
                        if events & selectors.EVENT_READ and not self.from_shell():
                            raise StopIteration
                    else:
                        client = key.data
                        if events & selectors.EVENT_WRITE:
                            self.flush(client)
                        if events & selectors.EVENT_READ and client.sock in self.clients:
                            self.from_client(client)
        except StopIteration:
            pass
        finally:
            try:
                _, st = os.waitpid(self.pid, 0)
                status = os.waitstatus_to_exitcode(st)
            except ChildProcessError:
                pass
            try:
                os.unlink(self.path)
            except OSError:
                pass
            bye = frame(b'x', struct.pack('!i', status))
            for client in list(self.clients.values()):
                client.sock.setblocking(True)
                try:
                    client.sock.sendall(client.out + bye)
                except OSError:
                    pass
                client.sock.close()


def start_session(rows, cols):
    """Forks a detached session owner; returns its id once its socket accepts connections."""
    session_id = secrets.token_hex(4)
    path = socket_path(session_id)
    cwd, env = os.getcwd(), dict(os.environ)
    ready_r, ready_w = os.pipe()
    if os.fork() == 0:
        os.close(ready_r)
        os.setsid()  # not part of the SSH login: survives it like tmux does
        if os.fork() != 0:
            os._exit(0)
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)
        try:
            session = Session(session_id, path, rows, cols, cwd, env)
        except Exception:
            os._exit(1)
        os.write(ready_w, b'1')
        os.close(ready_w)
        session.run()
        os._exit(0)
    os.close(ready_w)
    ok = os.read(ready_r, 1) == b'1'
    os.close(ready_r)
    os.wait()  # the intermediate child
    if not ok:
        sys.stderr.write('trd-pty: could not start a session\n')
        sys.exit(3)  # login.sh falls back to tmux / a plain shell on this
    return session_id


# ---- terminal side -------------------------------------------------------------------------------

FOCUS_ON, FOCUS_OFF = b'\x1b[?1004h', b'\x1b[?1004l'
FOCUS_IN, FOCUS_OUT = b'\x1b[I', b'\x1b[O'


def attach(session_id, claim=True):
    """Relays this terminal to a session until the session ends (0) or the connection breaks (1)."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(socket_path(session_id))
    except OSError as e:
        sys.exit(f'trd-pty: no session {session_id} ({e.strerror})')
    fd_in, fd_out = sys.stdin.fileno(), sys.stdout.fileno()
    rows, cols = term_size(fd_in)
    sock.sendall(frame(b'h', struct.pack('!HHB', rows, cols, 1 if claim else 0)))

    winch_r, winch_w = os.pipe()
    os.set_blocking(winch_w, False)
    signal.set_wakeup_fd(winch_w)
    signal.signal(signal.SIGWINCH, lambda *_: None)

    saved = termios.tcgetattr(fd_in)
    tty.setraw(fd_in)
    # Ask this terminal for focus reports: focusing it makes it the controlling terminal. They are
    # only forwarded to the program in the session when that program asked for them itself.
    os.write(fd_out, FOCUS_ON)
    app_wants_focus = False
    frames = Frames()
    status = 1
    try:
        while True:
            ready = select_read([fd_in, sock.fileno(), winch_r])
            if winch_r in ready:
                os.read(winch_r, 64)
                sock.sendall(frame(b'r', SIZE.pack(*term_size(fd_in))))
            if fd_in in ready:
                data = os.read(fd_in, 65536)
                if not data:
                    break
                if FOCUS_IN in data:
                    sock.sendall(frame(b'c'))
                if not app_wants_focus:
                    data = data.replace(FOCUS_IN, b'').replace(FOCUS_OUT, b'')
                if data:
                    sock.sendall(frame(b'i', data))
            if sock.fileno() in ready:
                data = sock.recv(65536)
                if not data:
                    break
                for kind, payload in frames.feed(data):
                    if kind == b'o':
                        on, off = payload.rfind(FOCUS_ON), payload.rfind(FOCUS_OFF)
                        if on != off:
                            app_wants_focus = on > off
                        write_all(fd_out, payload)
                    elif kind == b'x':
                        status = 0
                        return status
    finally:
        if not app_wants_focus:
            os.write(fd_out, FOCUS_OFF)
        termios.tcsetattr(fd_in, termios.TCSAFLUSH, saved)
        sock.close()
    return status


def select_read(fds):
    sel = selectors.DefaultSelector()
    for fd in fds:
        sel.register(fd, selectors.EVENT_READ)
    try:
        return {key.fd for key, _ in sel.select()}
    finally:
        sel.close()


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except BlockingIOError:
            select_write(fd)
            continue
        view = view[n:]


def select_write(fd):
    sel = selectors.DefaultSelector()
    sel.register(fd, selectors.EVENT_WRITE)
    sel.select()
    sel.close()


def query(path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(2)
    sock.connect(path)
    sock.sendall(frame(b'q'))
    frames = Frames()
    while True:
        data = sock.recv(65536)
        if not data:
            raise OSError('closed')
        for kind, payload in frames.feed(data):
            if kind == b'q':
                sock.close()
                return json.loads(payload)


def list_sessions():
    base = runtime_dir()
    sessions = []
    for name in sorted(os.listdir(base)):
        if not name.endswith('.sock'):
            continue
        path = os.path.join(base, name)
        try:
            sessions.append(query(path))
        except ConnectionRefusedError:
            os.unlink(path)  # its owner is gone (killed, or before a reboot's tmpfs wipe)
        except OSError:
            pass
    return sessions


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'new':
        if not os.isatty(0):
            sys.exit('trd-pty: new needs a terminal')
        return attach(start_session(*term_size(0)))
    if cmd == 'attach' and len(argv) == 3:
        return attach(argv[2])
    if cmd == 'ls':
        for s in list_sessions():
            print(s['id'], s['clients'], s['pid'], s.get('cwd', ''))
        return 0
    if cmd == 'clients' and len(argv) == 3:
        try:
            print(query(socket_path(argv[2]))['clients'])
        except OSError:
            print(0)
        return 0
    sys.stderr.write(__doc__.split('\n\n', 1)[1])
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
