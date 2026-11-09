"""The bus tools: the MCP tools' descriptions and JSON Schemas, named as Pi names them.

Names carry an `oabus_` prefix (#1448). Hermes passes each handler the calling
session as `session_id`; it is resolved to its root, and a subagent is refused.
"""

import json
import time

from . import copy
from .link import LinkError
from .roots import NotOnBus

STATES = ["working", "idle", "blocked", "waiting_on_owner"]

_NONE = {"type": "object", "properties": {}, "additionalProperties": False}

TOOLS = [
    {
        "name": "oabus_list_agents",
        "description": "List the agents you can message, in your Open Artifacts bus namespace and linked ones.",
        "parameters": _NONE,
    },
    {
        "name": "oabus_send_message",
        "description": "Send a message to another agent by name.",
        "parameters": {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "text": {"type": "string"},
                "to_namespace": {
                    "type": "string",
                    "description": "The recipient's namespace, when the target name exists in several: a global agent's, or a linked project's.",
                },
            },
            "required": ["to", "text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "oabus_fetch",
        "description": "Fetch the full body of an oversized message by id.",
        "parameters": {
            "type": "object",
            "properties": {"msg_id": {"type": "string"}},
            "required": ["msg_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "oabus_self",
        "description": "Your own Open Artifacts bus agent entry and bus name. To become global, ask the user to approve running `npx @open-artifacts/bus global add <your start dir>`, then restart.",
        "parameters": _NONE,
    },
    {
        "name": "oabus_set_status",
        "description": "Tell the user what you are doing: working, idle, blocked, or waiting_on_owner (waiting on the user), with an optional short label. The user sees it labelled as your own report.",
        "parameters": {
            "type": "object",
            "properties": {
                "state": {"type": "string", "enum": STATES},
                "label": {
                    "type": "string",
                    "maxLength": 64,
                    "description": "What you are on, in a few words.",
                },
            },
            "required": ["state"],
            "additionalProperties": False,
        },
    },
    {
        "name": "oabus_follow",
        "description": "Follow an Open Artifacts artifact, by id or link, to get a notice when it changes.",
        "parameters": {
            "type": "object",
            "properties": {"artifact": {"type": "string"}},
            "required": ["artifact"],
            "additionalProperties": False,
        },
    },
    {
        "name": "oabus_unfollow",
        "description": "Stop following an artifact, by id or link.",
        "parameters": {
            "type": "object",
            "properties": {"artifact": {"type": "string"}},
            "required": ["artifact"],
            "additionalProperties": False,
        },
    },
    {
        "name": "oabus_following",
        "description": "List the artifacts you follow.",
        "parameters": _NONE,
    },
]


class ToolError(Exception):
    pass


def _failed(f):
    raise ToolError(f"oa-bus: {f.get('message') if f['type'] == 'error' else f['type']}")


def _roster(link):
    try:
        r = link.request({"type": "list"})
    except LinkError:
        return None
    return r.get("agents", []) if r["type"] == "roster" else None


def run(name, args, link):
    """One tool call on the session's attested link; a `from` argument is never read."""
    if name == "oabus_list_agents":
        r = link.request({"type": "list"})
        if r["type"] != "roster":
            _failed(r)
        agents = r.get("agents", [])
        if not agents:
            return "No agents in your namespace and linked ones."
        now = int(time.time() * 1000)
        return "\n".join(
            copy.roster_line(
                {
                    **a,
                    "queued": (a.get("state") or ("live" if a.get("live") else "queued")) == "queued",
                    "away": str(a.get("since", "")) if a.get("state") == "away" else None,
                },
                now,
            )
            for a in agents
        )
    if name == "oabus_send_message":
        to = str(args.get("to") or "")
        body = str(args.get("text") or "")
        if not to or not body:
            raise ToolError("oa-bus: to and text are required")
        ns = args.get("to_namespace")
        namespace = ns if isinstance(ns, str) and ns else None
        frame = {"type": "send", "to": to, "body": body}
        if namespace:
            frame["namespace"] = namespace
        r = link.request(frame)
        if r["type"] != "receipt":
            _failed(r)
        # The daemon's copy for a send it gave up on (C16): verbatim, not an error.
        if isinstance(r.get("text"), str) and r["text"]:
            return r["text"]
        receipt = {"state": str(r["state"]), "reason": r.get("reason")}
        reason = receipt["reason"]
        n = moved = linked = None
        if reason == "ambiguous":
            agents = _roster(link)
            if agents is not None:
                n = len({a["namespace"] for a in agents if a["name"] == to})
        if reason == "revoked":
            agents = _roster(link)
            if agents is not None:
                moved = copy.moved_name(
                    to, [a["name"] for a in agents if namespace is None or a["namespace"] == namespace]
                )
        if reason in ("closed", "revoked") and not namespace:
            agents = _roster(link)
            if agents is not None:
                linked = copy.linked_live_namespace(to, agents)
        out = copy.receipt_text(receipt, to, n, copy.excerpt_of(body), moved, linked)
        if receipt["state"] in ("refused", "expired"):
            raise ToolError(out)
        return out
    if name == "oabus_fetch":
        r = link.request({"type": "fetch", "msg_id": str(args.get("msg_id") or "")})
        if r["type"] != "body":
            _failed(r)
        # A peer's text, like a delivered body; the daemon strips it too.
        return copy.strip_terminal_controls(str(r["body"]))
    if name == "oabus_set_status":
        return _status(args, link)
    if name in ("oabus_follow", "oabus_unfollow", "oabus_following"):
        return _follow(name[len("oabus_") :], args, link)
    r = link.request({"type": "self", "row": True})
    if r["type"] != "agent":
        _failed(r)
    return copy.self_text(r.get("agent"))


def _follow(name, args, link):
    """follow, unfollow and following (#1317). Refusals are the hub's or daemon's copy, as-is."""
    artifact = args.get("artifact").strip() if isinstance(args.get("artifact"), str) else ""
    if name != "following" and not artifact:
        raise ToolError("oa-bus: artifact is required (an id or a link)")
    r = link.request({"type": name} if name == "following" else {"type": name, "artifact": artifact})
    if r["type"] == "followed":
        return copy.follow_text(str(r["url"]))
    if r["type"] == "unfollowed":
        return copy.unfollow_text(r["removed"] is True, artifact)
    if r["type"] == "follows":
        return copy.following_text(r["follows"])
    if r["type"] == "error" and r.get("code") == "bad_frame" and r.get("message") not in copy.FOLLOW_DAEMON_BAD_FRAME:
        raise ToolError(copy.FOLLOW_OLD_DAEMON)
    _failed(r)


def _status(args, link):
    """set_status. Arguments are checked first. Refusals are the daemon's copy, as-is."""
    state = str(args.get("state") or "")
    if state not in STATES:
        raise ToolError(f"oa-bus: state: must be one of {', '.join(STATES)}")
    label = None
    if isinstance(args.get("label"), str):
        label = copy.clean_status_label(args["label"]) or None
    chars = len([*label]) if label else 0
    if chars > 64:
        raise ToolError(copy.status_label_too_long(chars))
    frame = {"type": "set_status", "state": state}
    if label:
        frame["label"] = label
    r = link.request(frame)
    if r["type"] == "error":
        bad = r.get("code") == "bad_frame" and r.get("message") != copy.STATUS_COPY["bad_frame"]
        raise ToolError(copy.STATUS_COPY["bad_frame"] if bad else str(r["message"]))
    if r["type"] == "status_set":
        done = copy.status_set_text(state, label)
        earlier = r.get("earlier")
        return f"{done}\n\n{copy.earlier_status_text(str(earlier['message']))}" if earlier else done
    _failed(r)


class Tools:
    """The handlers Hermes calls: `handler(args, task_id=, session_id=, user_task=)`."""

    def __init__(self, bus):
        self.bus = bus

    def call(self, name, args, session_id=None, **_kw):
        try:
            ref = self.bus.roots.resolve(session_id)
            # A failed link is retried in the background as well (ensure schedules it).
            link = self.bus.ensure(ref)
            # Late deliveries the daemon hands back ride after the result, each after a blank line.
            late = []
            tracked = _Tracked(link, late)
            try:
                out = run(name, args if isinstance(args, dict) else {}, tracked)
            except (ToolError, LinkError) as e:
                if not late:
                    raise
                raise ToolError("\n\n".join([str(e), *late])) from None
            return "\n\n".join([out, *late])
        except NotOnBus as e:
            return json.dumps({"error": str(e)})
        except (ToolError, LinkError) as e:
            return json.dumps({"error": f"oa-bus: {e}" if isinstance(e, LinkError) else str(e)})

    def handler(self, name):
        def handle(args, **kw):
            return self.call(name, args, **kw)

        return handle


class _Tracked:
    """A link whose requests ask for late-delivery notices."""

    def __init__(self, link, late):
        self._link = link
        self._late = late
        self.welcome = link.welcome

    def request(self, frame, timeout=None):
        extra = {} if timeout is None else {"timeout": timeout}
        r = self._link.request({**frame, "late": True}, **extra)
        if isinstance(r.get("late"), list):
            self._late.extend(t for t in r["late"] if isinstance(t, str))
        return r
