"""The per-session proof argument (#1822, #1856).

The instance's /mcp reads a reserved argument on a `tools/call` to tell which
bus agent is calling. It must reach the wire and nothing else: Hermes shows a
call's arguments to hooks, callbacks, approval prompts, its tool guardrails (a
repeated call's stub result prints them to the model) and the CLI progress line.
So it is added at the last layer, in Hermes's one function that hands arguments
to the MCP SDK (tools/mcp_tool_handlers.py `_call_tool_racing_stdio_death`,
Hermes v0.23.0), and not by middleware, whose output every layer above sees.

How the proof gets from the agent thread to that function, which runs on the MCP
loop thread and has no session: `registry.dispatch` (tools/registry.py, the
last call before the handler, which receives the same `args` object) hands the
handler a copy of the arguments and notes the session's proof under that copy's
identity; the wire function looks the identity up. Its `server_name` is the raw
server name Hermes was configured with, so the match is exact: `open-artifacts`
and `open_artifacts` make the same registry prefix but are different names here.

Every piece fails to unlinked: a missing function leaves both untouched, an error
finding the proof sends the call as it was, a call that did not come through
`dispatch` finds no note.
"""

import functools

# The reserved argument the instance's /mcp reads and removes.
ARG = "_oa_agent_proof"

# The raw MCP server key of an instance's entry: exactly this, nothing else is trusted.
DEFAULT_SERVERS = ("open-artifacts",)

# id(args copy handed to the handler) -> the proof for that call, only while it is in flight.
_CALLS = {}
_STATE = {"bus": None, "names": DEFAULT_SERVERS}
_MARK = "_oa_proof_wrapper"


def proof_servers():
    """The raw server names that are this instance's."""
    return DEFAULT_SERVERS


def _wire_wrapper(original):
    async def wrapped(*a, **kw):
        a2, kw2 = a, kw
        try:
            # (server, server_name, tool_name, args, progress_callback=None)
            if "args" in kw:
                args, server_name = kw["args"], kw.get("server_name", a[1] if len(a) > 1 else None)
            else:
                args, server_name = (a[3], a[1]) if len(a) > 3 else (None, None)
            proof = _CALLS.get(id(args)) if isinstance(args, dict) else None
            if proof and isinstance(server_name, str) and server_name in _STATE["names"]:
                send = {**args, ARG: proof}
                if "args" in kw:
                    kw2 = {**kw, "args": send}
                else:
                    a2 = a[:3] + (send,) + a[4:]
        except Exception:
            a2, kw2 = a, kw
        return await original(*a2, **kw2)

    setattr(wrapped, _MARK, original)
    functools.update_wrapper(wrapped, original, assigned=("__name__", "__qualname__", "__doc__"), updated=())
    setattr(wrapped, _MARK, original)
    return wrapped


def _dispatch_wrapper(original):
    def wrapped(name, args, **kwargs):
        sent = args
        key = None
        try:
            bus = _STATE["bus"]
            if bus is not None and isinstance(name, str) and name.startswith("mcp__") and isinstance(args, dict):
                proof = bus.proof_for(kwargs.get("session_id"))
                if proof:
                    sent = dict(args)  # a copy with a identity of its own, and the same content
                    key = id(sent)
                    _CALLS[key] = proof
        except Exception:
            sent, key = args, None
        try:
            return original(name, sent, **kwargs)
        finally:
            if key is not None:
                _CALLS.pop(key, None)

    setattr(wrapped, _MARK, original)
    return wrapped


def install(bus, names, registry=None, handlers=None):
    """Wraps the two Hermes functions, once; a later call only swaps in the new `bus` and `names`.
    False (nothing touched) when Hermes does not have both."""
    try:
        if registry is None:
            from tools.registry import registry  # only importable inside Hermes
        if handlers is None:
            import tools.mcp_tool_handlers as handlers
        dispatch = getattr(registry, "dispatch", None)
        wire = getattr(handlers, "_call_tool_racing_stdio_death", None)
        if not callable(dispatch) or not callable(wire):
            return False
        _STATE["bus"], _STATE["names"] = bus, tuple(names)
        if not hasattr(dispatch, _MARK):
            registry.dispatch = _dispatch_wrapper(dispatch)
        if not hasattr(wire, _MARK):
            handlers._call_tool_racing_stdio_death = _wire_wrapper(wire)
        return True
    except Exception:
        return False
