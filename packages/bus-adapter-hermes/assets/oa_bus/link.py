"""One connection to the bus daemon, held open for one Hermes root session."""

import socket
import threading

from . import frames
from .sockpath import bus_home, daemon_socket_path, socket_dir_problem

# The IPC marker (CONTRACT.md): the package version, stamped by the CLI's bundler.
CLIENT_VERSION = "0.0.0"

# Above the daemon's 10 s hub wait plus its 5 s wait for delivered.
REQUEST_TIMEOUT_S = 20.0
HELLO_TIMEOUT_S = 5.0
RECONNECT_S = 3.0
MAX_REFUSED_BACKOFF_S = 60.0


def retry_delay_s(refusals):
    """3 s while the daemon is down; after `refusals` refused hellos in a row, 3 s doubling to 60 s."""
    if refusals <= 1:
        return RECONNECT_S
    return min(RECONNECT_S * 2 ** (refusals - 1), MAX_REFUSED_BACKOFF_S)


class LinkError(Exception):
    def __init__(self, message, refused=False):
        super().__init__(message)
        self.refused = refused


class Link:
    """Connects and says hello in `open`; then `deliver` and `notice` frames arrive on a reader thread."""

    def __init__(self, ref, cwd, name, proc_start, pid, on_deliver, on_notice, on_lost, home=None):
        self.ref = ref
        self.welcome = {}
        self._hello = {
            "id": "hello",
            "type": "hello",
            "kind": "hermes",
            "client_version": CLIENT_VERSION,
            "agent_ref": ref,
            "pid": pid,
            "cwd": cwd,
            "proposed_name": name,
            "caps": ["mailbox", "pending", "follow"],
            "attest": {"proc_start": proc_start} if proc_start else {},
        }
        self._home = home if home is not None else bus_home()
        self._on_deliver = on_deliver
        self._on_notice = on_notice
        self._on_lost = on_lost
        self._sock = None
        self._wlock = threading.Lock()
        self._lock = threading.Lock()
        self._pending = {}
        self._seq = 0
        self._ended = False
        self._welcomed = threading.Event()
        self._refusal = None

    @property
    def closed(self):
        return self._ended

    def open(self):
        problem = socket_dir_problem(self._home)
        if problem:
            raise LinkError(problem)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(HELLO_TIMEOUT_S)
        try:
            sock.connect(daemon_socket_path(self._home))
        except OSError as e:
            sock.close()
            raise LinkError(f"the daemon is not reachable: {e}") from None
        sock.settimeout(None)
        self._sock = sock
        threading.Thread(target=self._read, name="oa-bus-link", daemon=True).start()
        self._send(self._hello)
        if not self._welcomed.wait(HELLO_TIMEOUT_S):
            self._end(lost=False)
            raise LinkError(self._refusal or "the daemon did not answer hello")
        if self._refusal:
            self.close()
            raise LinkError(self._refusal, refused=True)
        return self

    def _send(self, partial):
        data = frames.encode(partial)
        with self._wlock:
            if self._ended or self._sock is None:
                raise LinkError("the daemon connection closed")
            try:
                self._sock.sendall(data)
            except OSError:
                raise LinkError("the daemon connection closed") from None

    def request(self, partial, timeout=REQUEST_TIMEOUT_S):
        """Sends a frame and waits for the reply with its id."""
        with self._lock:
            if self._ended:
                raise LinkError("the daemon connection closed")
            self._seq += 1
            req_id = str(self._seq)
            slot = {"event": threading.Event(), "frame": None}
            self._pending[req_id] = slot
        try:
            self._send({**partial, "id": req_id})
            if not slot["event"].wait(timeout):
                raise LinkError(f"the daemon did not answer {partial.get('type')}")
            if slot["frame"] is None:
                raise LinkError("the daemon connection closed")
            return slot["frame"]
        finally:
            with self._lock:
                self._pending.pop(req_id, None)

    def ack(self, msg_id):
        """Fire-and-forget: the daemon answers an ack with nothing."""
        with self._lock:
            self._seq += 1
            n = self._seq
        self._send({"type": "ack", "id": f"ack-{n}", "msg_id": msg_id})

    def close(self):
        self._end(lost=False)

    def _end(self, lost):
        with self._lock:
            was_open = not self._ended
            self._ended = True
            pending = list(self._pending.values())
        sock = self._sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        for slot in pending:
            slot["event"].set()
        self._welcomed.set()
        if lost and was_open and self.welcome:
            self._on_lost(self)

    def _read(self):
        buf = b""
        try:
            while True:
                chunk = self._sock.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while True:
                    i = buf.find(b"\n")
                    if i == -1:
                        break
                    line, buf = buf[:i], buf[i + 1 :]
                    self._line(line)
                if len(buf) > frames.MAX_LINE_BYTES:
                    break
        except OSError:
            pass
        self._end(lost=True)

    def _line(self, line):
        try:
            f = frames.decode(line)
        except frames.FrameError:
            return
        if not self._welcomed.is_set():
            if f["type"] == "welcome":
                self.welcome = f
            else:
                self._refusal = str(f.get("message") or "the daemon refused hello")
            self._welcomed.set()
            return
        t = f["type"]
        if t == "deliver":
            self._on_deliver(f, self)
        elif t == "notice":
            self._on_notice(self, f["text"], f.get("msg_id"))
        else:
            with self._lock:
                slot = self._pending.get(f["id"])
            if slot is not None:
                slot["frame"] = f
                slot["event"].set()
