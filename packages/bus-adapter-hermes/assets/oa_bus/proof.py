"""The per-session proof argument (#1822, #1856).

Hermes calls a tool through `tool_execution` middleware, which may hand the
tool different arguments than the model wrote, only for that one call: hooks,
guardrails and the transcript see the model's own. Our middleware adds one
reserved argument to calls to this instance's open-artifacts MCP tools, and to
no other server's, so the instance's /mcp can tell which bus agent is calling.
It is in no schema the model sees.

Which server a tool belongs to comes from Hermes's own record of the raw server
name that registered it (tools/mcp_tool.py `_mcp_tool_server_names`, Hermes
v0.23.0). The tool's name cannot say: `mcp__<server>__<tool>` replaces every
character outside [A-Za-z0-9_] with `_`, so `open-artifacts` and `open_artifacts`
make the same prefix. No record means no argument.
"""

import os

# The reserved argument the instance's /mcp reads and removes.
ARG = "_oa_agent_proof"

# The raw MCP server key of an instance's entry by default; OA_BUS_MCP_SERVER names another.
DEFAULT_SERVERS = ("open-artifacts",)

# Hermes's own utility tools for an MCP server (tools/mcp_tool_schema.py _UTILITY_TOOL_SPECS):
# not the instance's tools.
_UTILITY = (
    "list_resources",
    "read_resource",
    "list_prompts",
    "get_prompt",
    "list_event_types",
    "subscribe_event",
    "unsubscribe_event",
)


def proof_servers(env=None):
    """The raw server names that are this instance's."""
    extra = (env if env is not None else os.environ).get("OA_BUS_MCP_SERVER", "").strip()
    return DEFAULT_SERVERS + ((extra,) if extra and extra not in DEFAULT_SERVERS else ())


def hermes_server_of(tool_name):
    """The raw name of the MCP server that registered `tool_name`, or None."""
    from tools.mcp_tool import _mcp_tool_server_names  # only importable inside Hermes

    return _mcp_tool_server_names.get(tool_name)


def instance_tool(tool_name, server_of, names):
    """Whether `tool_name` is a tool of an MCP server named exactly one of `names`."""
    try:
        if not isinstance(tool_name, str) or not tool_name.startswith("mcp__"):
            return False
        if any(tool_name.endswith("__" + op) for op in _UTILITY):
            return False
        raw = server_of(tool_name)
        return isinstance(raw, str) and raw in names
    except Exception:
        return False
