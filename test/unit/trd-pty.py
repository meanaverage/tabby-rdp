#!/usr/bin/env python3
"""Behavioral tests for remote/trd-pty.py, run on a Linux host:

    scp remote/trd-pty.py test/trd-pty-test.py host:/tmp/ && ssh host python3 /tmp/trd-pty-test.py /tmp/trd-pty.py

Every "terminal" here is a real trd-pty client on its own PTY, so this exercises the same code paths
as Tabby's console and the desktop terminal. Uses its own XDG_RUNTIME_DIR, so real sessions are untouched.
"""
import fcntl
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
    """A terminal running `trd-pty <args>`, with its own size."""

    def __init__(self, args, rows=30, cols=100, env=None):
        self.rows, self.cols = rows, cols
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
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
    check('reattached shell kept its cwd', e2.wait_for(r'\r/usr\r\n'))
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
finally:
    shutil.rmtree(RUNTIME, ignore_errors=True)

for name, secs in timings.items():
    print(f'TIME  {name}: {secs * 1000:.0f} ms')
print(f'{failures} FAILED' if failures else 'ALL PASSED')
sys.exit(1 if failures else 0)
