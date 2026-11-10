"""One connection to the bus daemon, held open for one Hermes root session."""

import base64
import hashlib
import os
import socket
import threading
import time

from . import frames
from .sockpath import bus_home, daemon_socket_path, socket_dir_problem

# The IPC marker (CONTRACT.md): the package version, stamped by the CLI's bundler.
CLIENT_VERSION = "0.0.0"

# Above the daemon's 10 s hub wait plus its 5 s wait for delivered.
REQUEST_TIMEOUT_S = 20.0
HELLO_TIMEOUT_S = 5.0
# The daemon is local and answers link_proof at once; past this the root stays unlinked.
PROOF_TIMEOUT_S = 2.0
# A link whose proof was not taken (the hub was down) tries again on a later turn, at most this often.
PROOF_RETRY_S = 60.0
_monotonic = time.monotonic
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


# #1608: the daemon's binding token per ref, in memory only. A reconnect is a new Link and echoes it.
_BIND_TOKENS = {}


class Link:
    """Connects and says hello in `open`; then `deliver` and `notice` frames arrive on a reader thread."""

    def __init__(self, ref, cwd, name, proc_start, pid, on_deliver, on_notice, on_lost, home=None):
        self.ref = ref
        self.welcome = {}
        # #1822: this link's proof, in memory only (never written or logged); set once the
        # daemon took its hash. A reconnect is a new Link, so a new proof.
        self.proof = None
        self._candidate = None  # the proof this link offered; a retry offers the same one
        self._tried_at = None
        self._proving = False
        self._hello = {
            "id": "hello",
            "type": "hello",
            "kind": "hermes",
            "client_version": CLIENT_VERSION,
            "agent_ref": ref,
            "pid": pid,
            "cwd": cwd,
            "proposed_name": name,
            "caps": ["mailbox", "pending", "follow", "link"],
            **({"bind_token": _BIND_TOKENS[ref]} if ref in _BIND_TOKENS else {}),
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
        self._prove()
        return self

    def _prove(self):
        """Makes this link's proof and tells the daemon its hash, for a daemon whose welcome listed
        `link`. Any failure leaves this root unlinked; the link and every tool keep working."""
        try:
            caps = self.welcome.get("caps")
            if not isinstance(caps, list) or "link" not in caps:
                return
            self._candidate = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode("ascii")
            self._attempt()
        except Exception:
            pass

    def retry_proof(self):
        """A later turn: offers the same proof again when the daemon did not take it (its hub link
        was down), at most once per PROOF_RETRY_S. Does nothing once taken, or without the cap."""
        try:
            if self.proof is not None or self._candidate is None or self._ended:
                return
            if _monotonic() - self._tried_at < PROOF_RETRY_S:
                return
            self._attempt()
        except Exception:
            pass

    def _attempt(self):
        with self._lock:
            if self._proving or self.proof is not None or self._ended:
                return
            self._proving = True
        try:
            self._tried_at = _monotonic()
            hash_ = hashlib.sha256(self._candidate.encode("ascii")).hexdigest()
            r = self.request({"type": "link_proof", "hash": hash_}, PROOF_TIMEOUT_S)
            if r.get("type") == "link_proofed" and r.get("bound") is True and not self._ended:
                self.proof = self._candidate
        except Exception:
            pass
        finally:
            self._proving = False

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
                if isinstance(f.get("bind_token"), str):
                    _BIND_TOKENS[self.ref] = f["bind_token"]
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
