"""Registers the bus tools and hooks with Hermes (a plugin's `register(ctx)`)."""

import atexit
import os
import time

from . import proof as _proof

from .bus import Bus
from .roots import Roots, hermes_session_exists
from .state import RootStore
from .tools import TOOLS, Tools


def _servers():
    return _proof.proof_servers()


def _bound_session_key():
    """The gateway's routing key for the session this hook runs for, or None (not a gateway process,
    an older Hermes, or no session bound to this thread)."""
    try:
        from gateway.session_context import bound_session_key

        return bound_session_key() or None
    except Exception:
        return None


def _bound_chat_type():
    """"dm" for a chat with one person, "shared" for a dm-type chat with no single user, else the
    gateway's own chat type ("group", "channel", "thread"); None when it cannot be told."""
    try:
        from gateway.session_context import get_session_env

        kind = get_session_env("HERMES_SESSION_CHAT_TYPE", "")
        if not kind:
            return None
        if kind == "dm" and not get_session_env("HERMES_SESSION_USER_ID", ""):
            return "shared"
        return kind
    except Exception:
        return None


def _restore_when_live(bus, ready, tries=120, pause=0.5, sleep=time.sleep):
    for _ in range(tries):
        try:
            if ready():
                bus.restore()
                return
        except Exception:
            return
        sleep(pause)


def _wake_list(ctx):
    """plugins.entries.<id>.settings.wake: the owner's list of session keys and platform names."""
    try:
        v = ctx.get_config("wake", [])
    except Exception:
        return []
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def register(ctx, roots=None, bus=None, proof_servers=None, install=None, gateway_ready=None):
    """`proof_servers` (this instance's raw MCP server names) and `install` (what puts the proof
    argument on the wire, see proof.py) are replaced in tests."""
    roots = roots or Roots()
    bus = bus or Bus(roots, inject=ctx.inject_message, store=RootStore(), session_exists=hermes_session_exists,
                         wake_allow=lambda: _wake_list(ctx))
    tools = Tools(bus)
    mine = proof_servers if proof_servers is not None else _servers()
    put_on_wire = install or _proof.install
    installed = []

    for tool in TOOLS:
        ctx.register_tool(
            name=tool["name"],
            toolset="oa_bus",
            schema=tool,
            handler=tools.handler(tool["name"]),
            description=tool["description"],
        )

    # Hooks get keyword arguments only, and may gain more: always take **kwargs.
    def pre_llm_call(session_id=None, platform=None, user_message=None, conversation_history=None, **_kw):
        # #1822: the proof argument, once Hermes has loaded: never at registration. Any failure
        # leaves roots unlinked and the turn as it was.
        if not installed:
            installed.append(True)
            try:
                put_on_wire(bus, mine)
            except Exception:
                pass
        return bus.turn_start(session_id, platform, user_message, conversation_history,
                              session_key=_bound_session_key(), chat_type=_bound_chat_type())

    def on_session_open(session_id=None, **_kw):
        bus.session_open(session_id)

    def on_session_start(session_id=None, **_kw):
        bus.session_open(session_id)

    def on_session_end(session_id=None, **_kw):
        bus.turn_end(session_id)

    def on_session_finalize(session_id=None, reason=None, **_kw):
        bus.session_finalize(session_id, reason)

    def subagent_start(parent_session_id=None, child_session_id=None, **_kw):
        roots.note_subagent(parent_session_id, child_session_id)

    ctx.register_hook("pre_llm_call", pre_llm_call)
    # Presence before the first turn: on_session_open (a local session created or resumed) and
    # on_session_start (a messaging chat's first turn). An older Hermes without either keeps
    # opening the link at the first pre_llm_call.
    for name, cb in (("on_session_open", on_session_open), ("on_session_start", on_session_start)):
        try:
            ctx.register_hook(name, cb)
        except Exception:
            pass
    ctx.register_hook("on_session_end", on_session_end)
    ctx.register_hook("on_session_finalize", on_session_finalize)
    ctx.register_hook("subagent_start", subagent_start)
    # The CLI's current session, when Hermes already knows it at load.
    current = os.environ.get("HERMES_SESSION_ID")
    if current:
        bus._spawn(lambda: bus.session_open(current))
    # A gateway process: link the chats it served before a restart once the gateway is live (Hermes
    # publishes its injector then). Nowhere else: a CLI process must not take a gateway's roots.
    ready = gateway_ready or (lambda: bool(getattr(getattr(ctx, "_manager", None), "has_gateway_message_injector", False)))
    if gateway_ready is not None or hasattr(ctx, "_manager"):
        bus._spawn(lambda: _restore_when_live(bus, ready))
    atexit.register(bus.close_all)
    # A reload unloads the plugin without exiting: shut this Bus then, so the next one can take over
    # the proof wiring. An older Hermes has no on_unload.
    on_unload = getattr(ctx, "on_unload", None)
    if callable(on_unload):
        on_unload(bus.close_all)
    return bus
