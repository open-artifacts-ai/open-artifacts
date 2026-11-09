"""Registers the bus tools and hooks with Hermes (a plugin's `register(ctx)`)."""

import atexit

from . import proof as _proof

from .bus import Bus
from .proof import ARG, hermes_server_of, instance_tool
from .roots import Roots
from .tools import TOOLS, Tools


def _servers():
    return _proof.proof_servers()


def register(ctx, roots=None, bus=None, mcp_servers=None, proof_servers=None):
    """`mcp_servers` (tool name -> raw MCP server name) and `proof_servers` (this instance's
    server names) are replaced in tests."""
    roots = roots or Roots()
    bus = bus or Bus(roots, inject=ctx.inject_message)
    tools = Tools(bus)
    server_of = mcp_servers or hermes_server_of
    mine = proof_servers if proof_servers is not None else _servers()

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
        return bus.turn_start(session_id, platform, user_message, conversation_history)

    def on_session_end(session_id=None, **_kw):
        bus.turn_end(session_id)

    def on_session_finalize(session_id=None, **_kw):
        bus.session_finalize(session_id)

    def subagent_start(parent_session_id=None, child_session_id=None, **_kw):
        roots.note_subagent(parent_session_id, child_session_id)

    # #1822: the proof argument, added for one call to this instance's MCP tools. It must
    # call next_call exactly once, and a failure here never stops the tool.
    def tool_execution(tool_name=None, args=None, next_call=None, session_id=None, **_kw):
        send = args
        try:
            if isinstance(args, dict) and instance_tool(tool_name, server_of, mine):
                proof = bus.proof_for(session_id)
                if proof:
                    send = {**args, ARG: proof}
        except Exception:
            send = args
        return next_call(send)

    # Hermes before middleware existed has no such method: that root stays unlinked.
    register_middleware = getattr(ctx, "register_middleware", None)
    if callable(register_middleware):
        register_middleware("tool_execution", tool_execution)

    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("on_session_end", on_session_end)
    ctx.register_hook("on_session_finalize", on_session_finalize)
    ctx.register_hook("subagent_start", subagent_start)
    atexit.register(bus.close_all)
    return bus
