#!/usr/bin/env python3
"""Behavioral tests for remote/trd-pty.py, run on a Linux host:

    scp remote/trd-pty.py test/trd-pty-test.py host:/tmp/ && ssh host python3 /tmp/trd-pty-test.py /tmp/trd-pty.py

Every "terminal" here is a real trd-pty client on its own PTY, so this exercises the same code paths
as Tabby's console and the desktop terminal. Uses its own XDG_RUNTIME_DIR, so real sessions are untouched.
"""
import fcntl
import importlib.util
import os
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time

TRD = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'remote', 'trd-pty.py')
RUNTIME = tempfile.mkdtemp(prefix='trd-pty-test-')
os.chmod(RUNTIME, 0o700)
ENV = dict(os.environ, XDG_RUNTIME_DIR=RUNTIME, TERM='xterm-256color', SHELL='/bin/bash',
           TABBY_NO_TMUX='1', HISTFILE='/dev/null')
failures = 0
timings = {}


def check(name, ok, detail=None):
    global failures
    failures += 0 if ok else 1
    print(('PASS  ' if ok else 'FAIL  ') + name + ('' if ok or detail is None else f'  {detail!r}'), flush=True)


class Term:
    """A terminal running `trd-pty <args>`, with its own size (`before`: Python run first, in the same process)."""

    def __init__(self, args, rows=30, cols=100, env=None, before=None):
        self.rows, self.cols = rows, cols
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            if before:
                run = f'import runpy, sys; {before}; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")'
                os.execve(sys.executable, [sys.executable, '-c', run, TRD] + args, env or ENV)
            os.execve(sys.executable, [sys.executable, TRD] + args, env or ENV)
        self.resize(rows, cols)
        self.buf = b''

    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        try:
            os.kill(self.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    def read(self, timeout=0.3):
        end = time.monotonic() + timeout
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return
            r, _, _ = select.select([self.fd], [], [], left)
            if not r:
                return
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if not data:
                return
            self.buf += data

    def wait_for(self, pattern, timeout=5.0):
        rx = re.compile(pattern.encode() if isinstance(pattern, str) else pattern)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if rx.search(self.buf):
                return True
            self.read(0.1)
        return bool(rx.search(self.buf))

    def send(self, data):
        os.write(self.fd, data.encode() if isinstance(data, str) else data)

    def run(self, line):
        self.send(line + '\r')

    def close(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass

    def exit_status(self, timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.read(0.05)
            pid, st = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return os.waitstatus_to_exitcode(st)
        return None


def trd(*args, env=None):
    return subprocess.run([sys.executable, TRD, *args], capture_output=True, text=True, env=env or ENV, timeout=10).stdout


def sessions():
    return [line.split() for line in trd('ls').splitlines()]


PROMPT = r'\$ (\x1b\[[0-9;]*m)*$'


def wait_prompt(t, marker):
    t.run(f'echo {marker}-$((40+2))')
    return t.wait_for(f'{marker}-42')


def new_session(rows=30, cols=100, env=None):
    """Starts a session and waits for the shell's prompt (bash drops input typed before that)."""
    t0 = time.monotonic()
    t = Term(['new'], rows, cols, env)
    ready = t.wait_for(PROMPT, 10)
    return t, ready, time.monotonic() - t0


try:
    # ---- lifecycle: create -------------------------------------------------------------------
    a, prompt, secs = new_session(30, 100)
    timings['create session → shell prompt'] = secs
    check('new: shell prompt appears', prompt, a.buf[-300:])
    check('new: shell answers', wait_prompt(a, 'ready'), a.buf[-300:])
    ss = sessions()
    check('ls: one session, one terminal', len(ss) == 1 and ss[0][1] == '1', ss)
    sid, shell_pid = ss[0][0], int(ss[0][2])
    sock_path = os.path.join(RUNTIME, 'trd-pty', sid + '.sock')
    st = os.stat(os.path.join(RUNTIME, 'trd-pty'))
    check('session dir is 0700', st.st_mode & 0o777 == 0o700, oct(st.st_mode))
    check('socket is 0600', os.stat(sock_path).st_mode & 0o777 == 0o600, oct(os.stat(sock_path).st_mode))

    a.run('cd /tmp && export TRD_TEST_VAR=kept && echo "state-$PWD-$TRD_TEST_VAR-$TRD_SESSION"')
    check('cwd/env/TRD_SESSION in the shell', a.wait_for(f'state-/tmp-kept-{sid}'))

    # ---- multi-attach -------------------------------------------------------------------------
    t0 = time.monotonic()
    b = Term(['attach', sid], 40, 120)
    got_replay = b.wait_for('state-/tmp-kept', 3)
    timings['attach → replay shown'] = time.monotonic() - t0
    check('late attach gets a replay of recent output', got_replay)
    check('ls: two terminals', sessions()[0][1] == '2', sessions())
    time.sleep(0.4)  # past the post-replay quiet period

    b.run('stty size')
    check('attaching terminal (typed last) controls the size', b.wait_for(r'\b40 120\b'))
    a.buf = b.buf = b''
    a.run('echo from-a-$((1+1))')
    check('output reaches both terminals', a.wait_for('from-a-2') and b.wait_for('from-a-2'), (a.buf[-200:], b.buf[-200:]))
    a.buf = b''
    a.run('stty size')
    check('typing makes a terminal the controller (size follows it)', a.wait_for(r'\b30 100\b'), a.buf[-200:])

    # no duplicated input
    marker = f'/tmp/trd-dup-{os.getpid()}'
    b.run(f'echo once >> {marker}')
    time.sleep(0.5)
    a.run(f'echo twice >> {marker}')
    time.sleep(0.5)
    lines = open(marker).read().split() if os.path.exists(marker) else []
    check('each keystroke reaches the shell exactly once', lines == ['once', 'twice'], lines)
    os.unlink(marker) if os.path.exists(marker) else None

    # resize ownership: only the controller sets the size; focus-in claims control
    a.buf = b''
    a.run("python3 -c \"import signal,os,time; signal.signal(signal.SIGWINCH, lambda *a: print('SZ', *os.get_terminal_size(), flush=True)); print('watching', flush=True); time.sleep(4)\"")
    a.wait_for('watching')
    a.buf = b''
    b.resize(45, 130)  # b is not the controller: nothing may change
    time.sleep(0.6)
    check('non-controller resize does not change the PTY', b'SZ' not in a.buf, a.buf[-200:])
    b.send('\x1b[I')  # b gets focus -> becomes controller
    check('focus-in transfers control (PTY takes its size)', a.wait_for(r'SZ 130 45'), a.buf[-200:])
    a.buf = b''
    a.send('\x1b[I')
    check('focus back: size follows the other terminal again', a.wait_for(r'SZ 100 30'), a.buf[-200:])
    time.sleep(3.5)
    a.buf = b.buf = b''
    check('focus reports are not typed into the shell', not re.search(rb'\[I', a.buf + b.buf))

    # ---- terminal fidelity -----------------------------------------------------------------------
    a.run('sleep 30')
    time.sleep(0.5)
    a.buf = b''
    a.send('\x03')
    check('Ctrl-C interrupts the foreground program', wait_prompt(a, 'after-ctrlc'))
    a.run('sleep 31')
    time.sleep(0.5)
    a.send('\x1a')
    check('Ctrl-Z stops it (job control)', a.wait_for(r'Stopped\s+sleep 31'), a.buf[-200:])
    a.buf = b''
    a.run('jobs; kill %1; wait; echo jobs-done')
    check('jobs/kill %1 work', a.wait_for(r'sleep 31') and a.wait_for('jobs-done'), a.buf[-300:])
    a.buf = b.buf = b''
    a.run("printf 'utf8: h\\303\\251llo \\342\\234\\223 \\033[31mred\\033[0m\\n'")
    check('UTF-8 and colors pass through byte for byte', b.wait_for('utf8: héllo ✓ \x1b\\[31mred\x1b\\[0m'.encode()), b.buf[-200:])
    a.buf = b''
    a.run("printf '\\033]0;trd-title\\007'; echo title-sent")
    check('terminal title (OSC 0) passes through', a.wait_for(rb'\x1b\]0;trd-title\x07'))

    # full-screen program: a late attach makes it repaint
    a.buf = b''
    a.run("python3 -c \"import signal,sys,time; w=sys.stdout.write; w('\\033[?1049h\\033[HFULLSCREEN'); sys.stdout.flush(); signal.signal(signal.SIGWINCH, lambda *a: (w('\\033[HREPAINT'), sys.stdout.flush())); time.sleep(5); w('\\033[?1049l')\"")
    a.wait_for('FULLSCREEN')
    c = Term(['attach', sid], 30, 100)  # same size as the controller: still must repaint
    check('late attach: full-screen program repaints', c.wait_for('REPAINT', 3), c.buf[-200:])
    check('late attach: replay includes the alternate screen switch', b'\x1b[?1049h' in c.buf)
    c.close()
    time.sleep(5)

    # ---- detach / reattach -----------------------------------------------------------------------
    b.close()
    time.sleep(0.5)
    check('detaching one terminal keeps the session', sessions() and sessions()[0][1] == '1', sessions())
    check('the other terminal still works', wait_prompt(a, 'still-alive'))
    t0 = time.monotonic()
    b2 = Term(['attach', sid], 40, 120)
    re_ok = b2.wait_for('still-alive-42', 3)
    timings['reattach → replay shown'] = time.monotonic() - t0
    check('reattach shows the session', re_ok)
    time.sleep(0.4)
    check('reattached terminal can type', wait_prompt(b2, 'b2-typed'))

    # ---- robustness / security ---------------------------------------------------------------------
    for garbage in (b'\xff' * 64, struct.pack('!cI', b'i', 10 ** 9), struct.pack('!cI', b'i', 3) + b'abc', b'h'):
        s = socket.socket(socket.AF_UNIX)
        s.connect(sock_path)
        s.sendall(garbage)
        time.sleep(0.2)
        s.close()
    time.sleep(0.3)
    check('malformed clients cannot kill the session', sessions() and wait_prompt(a, 'survived'), sessions())
    if shutil.which('ss'):  # Linux
        listening = subprocess.run(['ss', '-ltnupH'], capture_output=True, text=True).stdout
        owner_pid = int(subprocess.run(['ps', '-o', 'ppid=', '-p', str(shell_pid)], capture_output=True, text=True).stdout)
        check('no TCP/UDP listener from the session owner', f'pid={owner_pid},' not in listening)
    other = subprocess.run(['sudo', '-n', '-u', 'nobody', sys.executable, '-c',
                            f'import socket; s=socket.socket(socket.AF_UNIX); s.connect({sock_path!r})'],
                           capture_output=True, text=True)
    check('another user cannot connect', other.returncode != 0 and ('Permission denied' in other.stderr or 'sudo' in other.stderr), other.stderr[-120:])

    # ---- session end -------------------------------------------------------------------------------
    b2.run('exit 3')
    st_a = a.exit_status()
    check('shell exit ends the session; terminals exit 0 (even for `exit 3`)', st_a == 0, st_a)
    time.sleep(0.3)
    check('session gone after shell exit', sessions() == [], sessions())
    b2.close()
    a.close()

    # last terminal detaching hangs the shell up (like a dropped SSH login) ...
    d, _, _ = new_session()
    wait_prompt(d, 'd')
    d_pid = int(sessions()[0][2])
    d.close()
    time.sleep(0.8)
    gone = subprocess.run(['kill', '-0', str(d_pid)], capture_output=True).returncode != 0
    check('last terminal gone: shell gets SIGHUP, session ends', gone and sessions() == [], sessions())

    # ... unless TRD_PTY_LINGER keeps it for a reattach
    e, _, _ = new_session(env=dict(ENV, TRD_PTY_LINGER='5'))
    wait_prompt(e, 'e')
    e.run('cd /usr && echo e-in-usr')
    e.wait_for('e-in-usr')
    esid = sessions()[0][0]
    e.close()
    time.sleep(1)
    e2 = Term(['attach', esid])
    replayed = e2.wait_for('e-in-usr', 2)
    time.sleep(0.4)  # past the post-replay quiet period
    check('TRD_PTY_LINGER: session survives with no terminals and reattaches', replayed and wait_prompt(e2, 'e2'))
    e2.run('pwd')
    # Bash 5.1 and later write a CR after the line typed, as they turn bracketed paste off; macOS's bash 3.2 doesn't.
    check('reattached shell kept its cwd', e2.wait_for(r'[\r\n]/usr\r\n'))
    e2.run('exit')
    e2.exit_status()
    e2.close()

    # stale socket: owner killed hard -> ls cleans it up
    f, _, _ = new_session()
    wait_prompt(f, 'f')
    fsid, fpid = sessions()[0][0], int(sessions()[0][2])
    owner = int(subprocess.run(['ps', '-o', 'ppid=', '-p', str(fpid)], capture_output=True, text=True).stdout)
    os.kill(owner, signal.SIGKILL)
    time.sleep(0.3)
    stale = os.path.exists(os.path.join(RUNTIME, 'trd-pty', fsid + '.sock'))
    check('stale socket is cleaned up by ls', stale and sessions() == [] and not os.path.exists(os.path.join(RUNTIME, 'trd-pty', fsid + '.sock')))
    f.close()
    subprocess.run(['pkill', '-HUP', '-P', str(fpid)], capture_output=True)
    try:
        os.kill(fpid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    check('attach to a missing session fails cleanly', 'no session' in subprocess.run(
        [sys.executable, TRD, 'attach', 'deadbeef'], capture_output=True, text=True, env=ENV).stderr)

    # ---- whose session: both ends check, and the session folder's place ---------------------------
    sys.dont_write_bytecode = True  # no __pycache__ in remote/, which the package ships
    spec = importlib.util.spec_from_file_location('trd_pty', TRD)
    trd_pty = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(trd_pty)
    probe_path = os.path.join(RUNTIME, 'peer.sock')
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(probe_path)
    listener.listen(1)
    client = socket.socket(socket.AF_UNIX)
    client.connect(probe_path)
    peer = trd_pty.peer_uid(client)
    check('a client can tell which user serves a session', peer == os.getuid(), (peer, os.getuid()))
    real_getuid = os.getuid
    os.getuid = lambda: real_getuid() + 1  # as if the session served another user
    try:
        foreign = trd_pty.serves_me(client)
    finally:
        os.getuid = real_getuid
    check('... and refuses one served by another user', foreign is False)
    client.close()
    listener.close()
    os.unlink(probe_path)
    # Linux's answer for a user whose uid is 2^31 or more (uid_t is unsigned): read as the system has it, not negative.
    class Credentials:
        def getsockopt(self, level, option, size):
            return struct.pack('iII', 4242, 2**31 + 5, 2**31 + 6)
    had = hasattr(socket, 'SO_PEERCRED')
    if not had:
        socket.SO_PEERCRED = 17
    try:
        large = trd_pty.peer_uid(Credentials())
    finally:
        if not had:
            del socket.SO_PEERCRED
    check('... a uid of 2^31 or more included', large == 2**31 + 5, large)
    # Where the system can't say who is at the other end (no peer credentials, or asking fails), neither end takes the
    # other's word for it: the client sends nothing, the session lets nobody in.
    real_peer_uid = trd_pty.peer_uid
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(probe_path)
    listener.listen(4)
    owner = type('Owner', (), {})()  # a session, as far as accept() looks at it
    owner.listener, owner.clients, owner.sel = listener, {}, trd_pty.selectors.DefaultSelector()
    verdicts = []
    try:
        def failing(sock):
            raise OSError('no answer')
        for unknown in (lambda sock: None, failing):
            trd_pty.peer_uid = unknown
            other = socket.socket(socket.AF_UNIX)
            other.connect(probe_path)
            trd_pty.Session.accept(owner)
            verdicts.append((trd_pty.serves_me(other), len(owner.clients)))
            other.close()
    finally:
        trd_pty.peer_uid = real_peer_uid
    check('... and, without the system\'s word on who is there, neither end goes on', verdicts == [(False, 0), (False, 0)], verdicts)
    listener.close()
    os.unlink(probe_path)
    no_peer = Term(['new'], before='import socket; [delattr(socket, n) for n in ("SO_PEERCRED", "LOCAL_PEERCRED") if hasattr(socket, n)]')
    status = no_peer.exit_status()
    check('a system without peer credentials: new exits 3, so the login falls back to tmux', status == 3, (status, no_peer.buf[-200:]))
    no_peer.close()

    base = tempfile.mkdtemp(prefix='trd-pty-base-')
    verdicts = []
    for mode in (0o777, 0o1777, 0o700):
        os.chmod(base, mode)
        verdicts.append(trd_pty.safe_base(base, (os.getuid(),)))
    check('a base folder anyone can rename things in is refused; sticky (like /tmp) or private is not', verdicts == [False, True, True], verdicts)
    os.makedirs(os.path.join(base, 'trd-pty'))
    os.chmod(os.path.join(base, 'trd-pty'), 0o755)
    bad = Term(['new'], env=dict(ENV, XDG_RUNTIME_DIR=base))
    status = bad.exit_status()
    check('an unsafe session folder: new exits 3, so the login falls back to tmux', status == 3, (status, bad.buf[-200:]))
    bad.close()
    shutil.rmtree(base, ignore_errors=True)
    # A runtime folder of the user's that can't be written to: no session folder can be made there, exit 3 as well
    # (not a Python error, which the login wouldn't fall back on).
    locked = tempfile.mkdtemp(prefix='trd-pty-locked-')
    os.chmod(locked, 0o500)
    stuck = Term(['new'], env=dict(ENV, XDG_RUNTIME_DIR=locked))
    status = stuck.exit_status()
    check('a session folder that can\'t be made: new exits 3 too', status == 3 or os.geteuid() == 0, (status, stuck.buf[-200:]))
    stuck.close()
    os.chmod(locked, 0o700)
    shutil.rmtree(locked, ignore_errors=True)

    # Another user's session socket, linked into this user's folder (as if swapped in): the client neither asks it
    # anything nor sends it keystrokes. Needs sudo to `nobody` (CI has it).
    if subprocess.run(['sudo', '-n', '-u', 'nobody', 'true'], capture_output=True).returncode == 0:
        theirs = tempfile.mkdtemp(prefix='trd-pty-theirs-')
        os.chmod(theirs, 0o777)
        their_sock, got = os.path.join(theirs, 's.sock'), os.path.join(theirs, 'got')
        server = subprocess.Popen(['sudo', '-n', '-u', 'nobody', sys.executable, '-c', r'''
import json, os, socket, struct, sys, time
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
os.chmod(sys.argv[1], 0o777)
s.listen(4)
s.settimeout(1)
got, end = b'', time.monotonic() + 6
while time.monotonic() < end:
    try:
        c, _ = s.accept()
    except OSError:
        continue
    c.settimeout(1)
    try:
        data = c.recv(65536)
        got += data
        if data[:1] == b'q':  # answers like a session with 99 terminals
            body = json.dumps({'id': 'x', 'clients': 99, 'pid': 1}).encode()
            c.sendall(struct.pack('!cI', b'q', len(body)) + body)
    except OSError:
        pass
    c.close()
open(sys.argv[2], 'wb').write(got)
''', their_sock, got])
        for _ in range(50):
            if os.path.exists(their_sock):
                break
            time.sleep(0.1)
        os.makedirs(os.path.join(RUNTIME, 'trd-pty'), mode=0o700, exist_ok=True)
        os.symlink(their_sock, os.path.join(RUNTIME, 'trd-pty', 'feedface.sock'))
        counted = trd('clients', 'feedface').strip()
        attached = subprocess.run([sys.executable, TRD, 'attach', 'feedface'], capture_output=True, text=True, env=ENV, stdin=subprocess.DEVNULL)
        server.wait(timeout=15)
        sent = open(got, 'rb').read() if os.path.exists(got) else None
        check("another user's session: not counted, not attached, sent nothing",
              counted == '0' and 'not yours' in attached.stderr and sent == b'', (counted, attached.stderr[-120:], sent))
        os.unlink(os.path.join(RUNTIME, 'trd-pty', 'feedface.sock'))
        shutil.rmtree(theirs, ignore_errors=True)
    else:
        print('SKIP  another user\'s session (needs sudo -n -u nobody)', flush=True)
finally:
    shutil.rmtree(RUNTIME, ignore_errors=True)

for name, secs in timings.items():
    print(f'TIME  {name}: {secs * 1000:.0f} ms')
print(f'{failures} FAILED' if failures else 'ALL PASSED')
sys.exit(1 if failures else 0)
