"""Which conversation a Hermes session id belongs to.

The bus identity (`agent_ref`) is the lineage ROOT: the first session of a
conversation. Context compression rotates the live session id to a new row
that links back to its parent; subagents (`delegate_task`) run in this process
under ids of their own. A session whose root cannot be told is refused, never
guessed: a wrong root would be a second agent on the bus.
"""

import threading


class NotOnBus(Exception):
    """A session that cannot use the bus; the message is for the agent."""


NO_SESSION = (
    "oa-bus: Hermes did not say which session made this call, so it cannot be "
    "placed on the bus. Update Hermes (the oa-bus plugin needs 0.19 or newer)."
)
UNRESOLVED = (
    "oa-bus: this session's conversation could not be found in Hermes's session "
    "history, so it is not on the bus. Send another message in this session and "
    "try again."
)
SUBAGENT = (
    "oa-bus: a subagent is not on the bus; only the main Hermes session can use "
    "Open Artifacts bus"
)


_dbs = {}


def hermes_lineage_root(session_id):
    """The root of `session_id`'s compression lineage, through Hermes's own SessionDB.

    Hermes's public API (hermes_state.SessionDB.get_compression_lineage), in
    process, on a read-only handle. The path is resolved on each call, so it
    follows the active profile or home override. None when the history file or
    the session does not exist.
    """
    from hermes_constants import get_hermes_home  # only importable inside Hermes
    from hermes_state import SessionDB

    path = get_hermes_home() / "state.db"
    if not path.exists():
        return None
    db = _dbs.get(path)
    if db is None:
        db = _dbs[path] = SessionDB(path, read_only=True)
    lineage = db.get_compression_lineage(session_id)
    return lineage[0] if lineage and session_id in lineage else None


class Roots:
    def __init__(self, lineage_root=hermes_lineage_root):
        self._lineage_root = lineage_root
        self._lock = threading.Lock()
        self._root_of = {}
        # child session id -> the session that delegated to it.
        self._subagents = {}

    def note_subagent(self, parent_session_id, child_session_id):
        """subagent_start: `child_session_id` is a subagent of `parent_session_id`."""
        if child_session_id and child_session_id != parent_session_id:
            with self._lock:
                self._subagents[child_session_id] = parent_session_id

    def _lineage(self, session_id):
        with self._lock:
            root = self._root_of.get(session_id)
        if root is None:
            try:
                root = self._lineage_root(session_id)
            except Exception:
                root = None
            if not isinstance(root, str) or not root:
                raise NotOnBus(UNRESOLVED)
            with self._lock:
                self._root_of[session_id] = root
        return root

    def root_of(self, session_id):
        """The root session id of any session: a subagent maps to its delegator's root."""
        if not isinstance(session_id, str) or not session_id:
            raise NotOnBus(NO_SESSION)
        for _ in range(32):
            with self._lock:
                parent = self._subagents.get(session_id)
            if parent is None:
                break
            session_id = parent
        root = self._lineage(session_id)
        with self._lock:
            parent = self._subagents.get(root)
        return root if parent is None else self.root_of(parent)

    def is_subagent(self, session_id):
        """Whether the session, or the lineage it rotated from, is a subagent's."""
        with self._lock:
            if session_id in self._subagents:
                return True
        try:
            root = self._lineage(session_id)
        except NotOnBus:
            return False
        with self._lock:
            return root in self._subagents

    def resolve(self, session_id):
        """The root session id of a main session; raises NotOnBus for a subagent or an unknown session."""
        if not isinstance(session_id, str) or not session_id:
            raise NotOnBus(NO_SESSION)
        if self.is_subagent(session_id):
            raise NotOnBus(SUBAGENT)
        return self._lineage(session_id)
