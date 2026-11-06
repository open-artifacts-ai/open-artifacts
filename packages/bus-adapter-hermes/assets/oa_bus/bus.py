"""Every Hermes root session this process holds on the bus.

One daemon link per root session (a gateway process serves many). A message
the daemon pushes is handed to Hermes, and acked only once it is injected or
queued.
"""

import os
import re
import threading

from . import copy
from .link import Link, LinkError, retry_delay_s
from .roots import NotOnBus
from .sockpath import proc_start
from .wrap import wrap

# msg_ids already handled, so a hub retry after a lost ack is acked, never shown twice.
SHOWN_MAX = 1000
# A delivery waits this long for the current bus name before using the welcome's.
SELF_TIMEOUT_S = 2.0


def name_of(title, kind="hermes"):
    """A session name as a bus name: lowercase words joined by `-`; the kind when nothing is left."""
    slug = re.sub(r"[^a-z0-9]+", "-", (title or "").lower())
    slug = re.sub(r"^-+", "", slug)[:64]
    slug = re.sub(r"-+$", "", slug)
    return slug or kind


class _Root:
    def __init__(self, ref):
        self.ref = ref
        self.lock = threading.Lock()
        self.link = None
        self.queue = []
        self.busy = False
        self.platform = None
        self.refusals = 0
        self.retry = None
        self.stopped = False
        self.shown = {}


class Bus:
    """`inject` is ctx.inject_message; `connect` makes a Link (replaced in tests)."""

    def __init__(self, roots, inject=None, connect=None, start=None, cwd=None, spawn=None):
        self.roots = roots
        self._inject = inject
        self._connect = connect or self._real_connect
        self._start = start if start is not None else proc_start()
        self._cwd = cwd
        self._spawn = spawn or self._thread
        self._lock = threading.Lock()
        self._by_root = {}
        self._timers = set()

    # --- Links.

    @staticmethod
    def _thread(fn):
        threading.Thread(target=fn, name="oa-bus", daemon=True).start()

    def _real_connect(self, root, on_deliver, on_notice, on_lost):
        cwd = self._cwd or os.getcwd()
        base = os.path.basename(cwd.rstrip("/"))
        return Link(
            root.ref,
            cwd,
            name_of(f"hermes-{base}" if base else None),
            self._start,
            os.getpid(),
            on_deliver,
            on_notice,
            on_lost,
        ).open()

    def state(self, ref):
        with self._lock:
            return self._by_root.setdefault(ref, _Root(ref))

    def ensure(self, ref):
        """The live link for root `ref`, opening it if needed; raises LinkError."""
        root = self.state(ref)
        with root.lock:
            if root.link is not None and not root.link.closed:
                return root.link
            root.stopped = False
            try:
                link = self._connect(root, self._on_deliver, self._on_notice, self._on_lost)
            except LinkError as e:
                self._retry_later(root, e.refused)
                raise
            root.link = link
            root.refusals = 0
            return link

    def touch(self, ref):
        """Opens the link in the background when it is not open, so a turn never waits on it."""
        root = self.state(ref)
        if root.link is not None and not root.link.closed:
            return
        if root.retry is not None:
            return

        def go():
            try:
                self.ensure(ref)
            except LinkError:
                pass

        self._spawn(go)

    def _retry_later(self, root, refused):
        if root.stopped or root.retry is not None:
            return
        root.refusals = root.refusals + 1 if refused else 0

        def fire():
            root.retry = None
            if not root.stopped:
                try:
                    self.ensure(root.ref)
                except LinkError:
                    pass

        t = threading.Timer(retry_delay_s(root.refusals), fire)
        t.daemon = True
        root.retry = t
        t.start()

    def _on_lost(self, link):
        root = self.state(link.ref)
        if root.link is link:
            root.link = None
            self._retry_later(root, False)

    def close(self, ref):
        root = self.state(ref)
        root.stopped = True
        if root.retry is not None:
            root.retry.cancel()
            root.retry = None
        link, root.link = root.link, None
        if link is not None:
            link.close()

    def close_all(self):
        with self._lock:
            refs = list(self._by_root)
        for ref in refs:
            self.close(ref)

    # --- Delivery.

    def _on_notice(self, link, text, msg_id=None):
        # An Open Artifacts bus notice (a sent message expired or was refused); never a peer's
        # message, so it is not wrapped as one.
        self._spawn(
            lambda: self._hand_over(self.state(link.ref), f"[oa-bus] {copy.strip_terminal_controls(text)}")
        )

    def _on_deliver(self, frame, link):
        self._spawn(lambda: self.deliver(frame, link))

    def deliver(self, f, link):
        """Hands one pushed message to Hermes, then acks it; no ack when it could not be handed over."""
        root = self.state(link.ref)
        msg_id = str(f["msg_id"])
        with root.lock:
            before = root.shown.get(msg_id)
            if before:
                # A repeat (the ack was lost, the hub retried): ack it again, never queue it twice.
                if before == "shown":
                    self._ack(link, msg_id)
                return
            root.shown[msg_id] = "showing"
            if len(root.shown) > SHOWN_MAX:
                root.shown.pop(next(iter(root.shown)))
        sender = copy.strip_terminal_controls(str(f.get("from_name", "")))
        namespace = str(f.get("namespace", ""))
        # The hub may have renamed this agent since hello: ask for the current name.
        to = str(link.welcome.get("bus_name", ""))
        is_global = link.welcome.get("global") is True
        try:
            r = link.request({"type": "self"}, SELF_TIMEOUT_S)
            agent = r.get("agent")
            if r["type"] == "agent" and agent:
                to = str(agent["name"])
                is_global = agent.get("global") is True
        except LinkError:
            pass
        m = {"from": sender, "to": to, "namespace": namespace, "global": is_global}
        notice = f.get("notice")
        if notice is not None:
            text = f"{copy.message_header(m)}\n\n{copy.oversized_text(int(notice.get('size', 0)), str(f['msg_id']))}"
        else:
            # The daemon strips these too; this copy does not rely on it.
            text = copy.delivered_text({**m, "body": copy.strip_terminal_controls(str(f["body"]))})
        wrapped = wrap(sender, text)
        if not self._hand_over(root, wrapped):
            with root.lock:
                root.shown.pop(msg_id, None)
            return  # Not handed to Hermes: no ack, so the daemon does not call it delivered.
        with root.lock:
            root.shown[msg_id] = "shown"
        self._ack(link, msg_id)

    @staticmethod
    def _ack(link, msg_id):
        try:
            link.ack(msg_id)
        except LinkError:
            pass

    def _hand_over(self, root, text):
        """Injects into an idle interactive CLI, else queues for the next turn's context."""
        with root.lock:
            idle_cli = root.platform == "cli" and not root.busy
        if idle_cli and self._inject is not None:
            try:
                if self._inject(text):
                    return True
            except Exception:
                pass
        with root.lock:
            root.queue.append(text)
        return True

    # --- Hooks.

    def turn_start(self, session_id, platform):
        """pre_llm_call: the queued messages as this turn's context, or None."""
        try:
            ref = self.roots.resolve(session_id)
        except NotOnBus:
            return None
        root = self.state(ref)
        with root.lock:
            root.busy = True
            root.platform = platform or root.platform
            out, root.queue = root.queue, []
        self.touch(ref)
        return {"context": "\n\n".join(out)} if out else None

    def turn_end(self, session_id):
        """on_session_end: the end of one run_conversation call."""
        try:
            ref = self.roots.resolve(session_id)
        except NotOnBus:
            return
        root = self.state(ref)
        with root.lock:
            root.busy = False

    def session_finalize(self, session_id):
        """on_session_finalize: a session closed; None means the whole process is going."""
        if session_id is None:
            self.close_all()
            return
        if self.roots.is_subagent(session_id):
            return
        try:
            self.close(self.roots.root_of(session_id))
        except NotOnBus:
            return
