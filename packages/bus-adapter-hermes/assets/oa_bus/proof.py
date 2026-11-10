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

One process, several profiles: the first Bus to install is wired in (see `install`); a second
profile stays unlinked, with no second link and no overwritten hash, unless the first holds no open
link or is shut down (a plugin reload), when the new Bus takes over. The dispatch path is a
read: it never opens a link.

Every piece fails to unlinked: a missing function leaves both untouched, an error
finding the proof sends the call as it was, a call that did not come through
`dispatch` finds no note.
"""

import functools
import inspect

# The reserved argument the instance's /mcp reads and removes.
ARG = "_oa_agent_proof"

# The raw MCP server key of an instance's entry: exactly this, nothing else is trusted.
DEFAULT_SERVERS = ("open-artifacts",)

# id(args copy handed to the handler) -> the proof for that call, only while it is in flight.
_CALLS = {}
_MARK = "_oa_proof_wrapper"
_CFG = "_oa_proof_cfg"


def proof_servers():
    """The raw server names that are this instance's."""
    return DEFAULT_SERVERS


def _wire_wrapper(original, cfg):
    async def wrapped(*a, **kw):
        a2, kw2 = a, kw
        try:
            # (server, server_name, tool_name, args, progress_callback=None)
            if "args" in kw:
                args, server_name = kw["args"], kw.get("server_name", a[1] if len(a) > 1 else None)
            else:
                args, server_name = (a[3], a[1]) if len(a) > 3 else (None, None)
            proof = _CALLS.get(id(args)) if isinstance(args, dict) else None
            if proof and isinstance(server_name, str) and server_name in cfg["names"]:
                send = {**args, ARG: proof}
                if "args" in kw:
                    kw2 = {**kw, "args": send}
                else:
                    a2 = a[:3] + (send,) + a[4:]
        except Exception:
            a2, kw2 = a, kw
        return await original(*a2, **kw2)

    functools.update_wrapper(wrapped, original, assigned=("__name__", "__qualname__", "__doc__"), updated=())
    setattr(wrapped, _MARK, original)
    setattr(wrapped, _CFG, cfg)
    return wrapped


def _dispatch_wrapper(original, cfg):
    def wrapped(name, args, **kwargs):
        sent = args
        key = None
        try:
            bus = cfg["bus"]
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
    setattr(wrapped, _CFG, cfg)
    return wrapped


def _positional(fn):
    """The names of fn's parameters that can be passed by position, in order; None when unreadable."""
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return None
    return [p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]


def _dispatch_fits(fn):
    """dispatch(name, args, ..., **kwargs): the wrapper reads `name` and `args` by position and
    `session_id` from the keywords, so it must be able to take them."""
    try:
        pos = _positional(fn)
        if pos is None or [p.name for p in pos[:2]] != ["name", "args"]:
            return False
        params = inspect.signature(fn).parameters
        return "session_id" in params and params["session_id"].kind != inspect.Parameter.POSITIONAL_ONLY or any(
            p.kind is p.VAR_KEYWORD for p in params.values()
        )
    except Exception:
        return False


def _wire_fits(fn):
    """(server, server_name, tool_name, args, ...): the wrapper reads server_name and args by
    position 1 and 3, or by keyword."""
    try:
        pos = _positional(fn)
        return pos is not None and len(pos) >= 4 and pos[1].name == "server_name" and pos[3].name == "args"
    except Exception:
        return False


def _holder_is_free(cfg):
    """True when the Bus holding the wiring has no open link or is shut down. Anything it cannot
    say counts as in use."""
    try:
        return cfg["bus"].wiring_free() is True
    except Exception:
        return False


def install(bus, names, registry=None, handlers=None):
    """Wraps the two Hermes functions, once per process. True when `bus` is the one in charge of them.

    Several Hermes profiles can load this plugin into one process, each with its own Bus. The first
    install wins; a later one for another Bus changes nothing and returns False: that profile stays
    unlinked (its sessions find no open link in the first Bus, so they get no proof), and it opens no
    second link and overwrites no hash. False too, with nothing touched, when Hermes lacks either
    function."""
    try:
        if registry is None:
            from tools.registry import registry  # only importable inside Hermes
        if handlers is None:
            import tools.mcp_tool_handlers as handlers
        dispatch = getattr(registry, "dispatch", None)
        wire = getattr(handlers, "_call_tool_racing_stdio_death", None)
        if not callable(dispatch) or not callable(wire):
            return False
        cfg = getattr(dispatch, _CFG, None) or getattr(wire, _CFG, None)
        if cfg is not None:
            if cfg["bus"] is bus:
                return True
            # A plugin reload makes a new Bus: it takes the wiring over once the holder has no open
            # link. Never while one is open: that is another profile, which stays unlinked.
            if not _holder_is_free(cfg):
                return False
            cfg["bus"], cfg["names"] = bus, tuple(names)
            return True
        if not (_dispatch_fits(dispatch) and _wire_fits(wire)):
            return False
        cfg = {"bus": bus, "names": tuple(names)}
        registry.dispatch = _dispatch_wrapper(dispatch, cfg)
        handlers._call_tool_racing_stdio_death = _wire_wrapper(wire, cfg)
        return True
    except Exception:
        return False
