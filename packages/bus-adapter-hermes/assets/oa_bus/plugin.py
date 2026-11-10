"""Registers the bus tools and hooks with Hermes (a plugin's `register(ctx)`)."""

import atexit

from . import proof as _proof

from .bus import Bus
from .roots import Roots
from .tools import TOOLS, Tools


def _servers():
    return _proof.proof_servers()


def register(ctx, roots=None, bus=None, proof_servers=None, install=None):
    """`proof_servers` (this instance's raw MCP server names) and `install` (what puts the proof
    argument on the wire, see proof.py) are replaced in tests."""
    roots = roots or Roots()
    bus = bus or Bus(roots, inject=ctx.inject_message)
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
        return bus.turn_start(session_id, platform, user_message, conversation_history)

    def on_session_end(session_id=None, **_kw):
        bus.turn_end(session_id)

    def on_session_finalize(session_id=None, **_kw):
        bus.session_finalize(session_id)

    def subagent_start(parent_session_id=None, child_session_id=None, **_kw):
        roots.note_subagent(parent_session_id, child_session_id)

    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("on_session_end", on_session_end)
    ctx.register_hook("on_session_finalize", on_session_finalize)
    ctx.register_hook("subagent_start", subagent_start)
    atexit.register(bus.close_all)
    return bus
