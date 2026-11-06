"""IPC frames between this plugin and the Open Artifacts bus daemon.

Mirrors @oa/bus-ipc frames.ts for the frames this plugin sends and receives.
The golden fixtures in packages/bus-adapter-hermes/fixtures are generated from
the zod schemas, and tests hold this code to them.
"""

import json
import re

V = 1
MAX_BODY_BYTES = 1024 * 1024
MAX_LINE_BYTES = 4 * 1024 * 1024

KINDS = ("claude-code", "opencode", "pi", "omp", "hermes", "codex")
STATUS_STATES = ("working", "idle", "blocked", "waiting_on_owner")
RECEIPT_STATES = ("pending", "delivered", "expired", "refused")
RECEIPT_REASONS = (
    "unknown_agent",
    "closed",
    "inbox_full",
    "too_large",
    "other_namespace",
    "revoked",
    "ambiguous",
    "role_vacant",
    "agent_gone",
    "mailbox_full",
    "reserved_name",
    "recipient_closed",
)

_AGENT_REF = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
_MSG_ID = re.compile(r"[1-9A-HJ-NP-Za-km-z]{16}")
_KIND_TOKEN = re.compile(r"[a-z][a-z0-9-]{0,31}")
_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9_-])?")
_IPV4 = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
_NAMESPACE = re.compile(r"[a-z0-9._~/-]+")
_ISO = re.compile(
    r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)"
)
_FORBIDDEN_REFS = ("__proto__", "constructor", "prototype")


class FrameError(ValueError):
    """A frame that does not match the protocol."""


def _fail(msg):
    raise FrameError(msg)


def _is_str(v, lo=0, hi=None):
    return isinstance(v, str) and len(v) >= lo and (hi is None or len(v) <= hi)


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def well_formed(s):
    """No lone surrogates (JSON can carry them; a WebSocket cannot)."""
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _need(frame, key, ok, what):
    if key not in frame or not ok(frame[key]):
        _fail(f"{key}: expected {what}")


def _opt(frame, key, ok, what):
    if key in frame and not ok(frame[key]):
        _fail(f"{key}: expected {what}")


def _agent_ref(v):
    return (
        isinstance(v, str)
        and _AGENT_REF.fullmatch(v) is not None
        and v not in _FORBIDDEN_REFS
    )


def _msg_id(v):
    return isinstance(v, str) and _MSG_ID.fullmatch(v) is not None


def _bus_name(v):
    return (
        isinstance(v, str)
        and len(v) <= 64
        and _NAME.fullmatch(v) is not None
        and _IPV4.fullmatch(v) is None
        and well_formed(v)
    )


def _namespace(v):
    return (
        isinstance(v, str)
        and 1 <= len(v) <= 128
        and _NAMESPACE.fullmatch(v) is not None
    )


def _iso(v):
    return isinstance(v, str) and _ISO.fullmatch(v) is not None


def _base(frame, types):
    if not isinstance(frame, dict):
        _fail("a frame is an object")
    if frame.get("v") != V or isinstance(frame.get("v"), bool):
        _fail("v must be 1")
    if not _is_str(frame.get("id"), 1, 64):
        _fail("id: expected a string of 1 to 64 characters")
    t = frame.get("type")
    if t not in types:
        _fail(f"unknown frame type: {t!r}")
    return t


# --- Frames the plugin sends.

ADAPTER_TYPES = ("hello", "send", "list", "self", "fetch", "ack", "set_status")


def check_adapter_frame(frame):
    """Raises FrameError unless `frame` is one the daemon accepts from an adapter."""
    t = _base(frame, ADAPTER_TYPES)
    if t == "hello":
        _need(frame, "kind", lambda v: v in KINDS, "a known agent kind")
        _need(frame, "agent_ref", _agent_ref, "an agent ref")
        _need(frame, "pid", lambda v: _is_int(v) and v > 0, "a positive integer")
        _opt(frame, "client_version", lambda v: _is_str(v, 1, 64), "1 to 64 chars")
        _opt(frame, "cwd", lambda v: _is_str(v, 1, 4096), "1 to 4096 chars")
        _opt(
            frame,
            "proposed_name",
            lambda v: _is_str(v, 1, 64) and well_formed(v),
            "1 to 64 well-formed chars",
        )
        _opt(
            frame,
            "caps",
            lambda v: isinstance(v, list)
            and len(v) <= 16
            and all(_is_str(c, 0, 32) for c in v),
            "up to 16 short strings",
        )
        if "attest" in frame:
            a = frame["attest"]
            if not isinstance(a, dict):
                _fail("attest: expected an object")
            for k in ("session_id", "socket_path", "proc_start"):
                if k in a and not isinstance(a[k], str):
                    _fail(f"attest.{k}: expected a string")
    elif t == "send":
        _need(frame, "to", _bus_name, "a bus name")
        _opt(frame, "namespace", lambda v: _namespace(v) and well_formed(v), "a namespace")
        _need(
            frame,
            "body",
            lambda v: _is_str(v, 1)
            and well_formed(v)
            and len(v.encode("utf-8")) <= MAX_BODY_BYTES,
            "a well-formed body of 1 byte to 1 MB",
        )
    elif t == "fetch" or t == "ack":
        _need(frame, "msg_id", _msg_id, "a message id")
    elif t == "set_status":
        _need(frame, "state", lambda v: v in STATUS_STATES, "a status state")
        _opt(
            frame,
            "label",
            lambda v: _is_str(v, 1, 128) and len([*v]) <= 64 and v == v.strip(),
            "a label of 1 to 64 characters",
        )
    elif t == "self":
        if "row" in frame and frame["row"] is not True:
            _fail("row: expected true")
    if t in ("send", "list", "self", "fetch", "set_status"):
        _opt(frame, "late", lambda v: v is True, "true")
    return frame


# --- Frames the plugin receives.

DAEMON_TYPES = (
    "welcome",
    "receipt",
    "roster",
    "agent",
    "body",
    "deliver",
    "notice",
    "error",
    "status_set",
)


def _agent_info(v):
    if not isinstance(v, dict):
        return False
    if not (_is_str(v.get("name")) and _is_str(v.get("namespace"))):
        return False
    k = v.get("kind")
    if not (isinstance(k, str) and _KIND_TOKEN.fullmatch(k)):
        return False
    if not isinstance(v.get("live"), bool) or not isinstance(v.get("global"), bool):
        return False
    if "state" in v and v["state"] not in ("live", "queued", "away"):
        return False
    if "since" in v and not _iso(v["since"]):
        return False
    if "status" in v and v["status"] not in STATUS_STATES:
        return False
    if "status_at" in v and not _iso(v["status_at"]):
        return False
    return True


def parse_daemon_frame(frame):
    """Returns `frame` when it is one the daemon sends an adapter; raises FrameError otherwise."""
    t = _base(frame, DAEMON_TYPES)
    if t == "welcome":
        _need(frame, "agent_ref", _agent_ref, "an agent ref")
        _need(frame, "bus_name", _is_str, "a string")
        _need(frame, "namespace", _is_str, "a string")
        _need(frame, "global", lambda v: isinstance(v, bool), "a boolean")
    elif t == "receipt":
        _need(frame, "msg_id", _is_str, "a string")
        _need(frame, "state", lambda v: v in RECEIPT_STATES, "a receipt state")
        _opt(frame, "reason", lambda v: v in RECEIPT_REASONS, "a receipt reason")
        _opt(frame, "held", lambda v: v is True, "true")
        _opt(frame, "text", lambda v: _is_str(v, 1), "a non-empty string")
    elif t == "roster":
        _need(
            frame,
            "agents",
            lambda v: isinstance(v, list) and all(_agent_info(a) for a in v),
            "a list of agents",
        )
    elif t == "agent":
        _need(
            frame,
            "agent",
            lambda v: v is None or _agent_info(v),
            "an agent or null",
        )
    elif t == "body":
        _need(frame, "msg_id", _is_str, "a string")
        _need(frame, "body", _is_str, "a string")
    elif t == "deliver":
        _need(frame, "msg_id", _is_str, "a string")
        _need(frame, "from_name", _is_str, "a string")
        _need(frame, "namespace", _is_str, "a string")
        _opt(frame, "body", _is_str, "a string")
        _opt(
            frame,
            "notice",
            lambda v: isinstance(v, dict)
            and _is_num(v.get("size"))
            and _is_str(v.get("msg_id")),
            "a notice",
        )
        if ("body" in frame) == ("notice" in frame):
            _fail("deliver needs exactly one of body or notice")
    elif t == "notice":
        _need(frame, "text", lambda v: _is_str(v, 1), "a non-empty string")
        _opt(frame, "msg_id", _is_str, "a string")
    elif t == "error":
        _need(frame, "code", _is_str, "a string")
        _need(frame, "message", _is_str, "a string")
    elif t == "status_set":
        _opt(
            frame,
            "earlier",
            lambda v: isinstance(v, dict)
            and _is_str(v.get("code"))
            and _is_str(v.get("message")),
            "an earlier status",
        )
    _opt(
        frame,
        "late",
        lambda v: isinstance(v, list) and all(_is_str(x, 1) for x in v),
        "a list of strings",
    )
    return frame


def encode(partial):
    """One JSON line for the daemon: `v` first, as the other adapters write it."""
    frame = {"v": V, **partial}
    check_adapter_frame(frame)
    return (json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def decode(line):
    """A received line to a validated frame; FrameError for anything else."""
    try:
        obj = json.loads(line.decode("utf-8") if isinstance(line, bytes) else line)
    except (ValueError, UnicodeDecodeError) as e:
        raise FrameError(f"not JSON: {e}") from None
    return parse_daemon_frame(obj)
