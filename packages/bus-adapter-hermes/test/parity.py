"""Runs the plugin's copy, wrapper and socket-path code on JSON cases from stdin (see parity.test.ts)."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets"))
from oa_bus import copy, sockpath, tools, wrap  # noqa: E402

CALLS = {
    "receiptText": copy.receipt_text,
    "movedName": copy.moved_name,
    "linkedLiveNamespace": copy.linked_live_namespace,
    "stripTerminalControls": copy.strip_terminal_controls,
    "displayKind": copy.display_kind,
    "neutralizeBody": copy.neutralize_body,
    "messageHeader": copy.message_header,
    "deliveredText": copy.delivered_text,
    "oversizedText": copy.oversized_text,
    "excerptOf": copy.excerpt_of,
    "cleanStatusLabel": copy.clean_status_label,
    "statusSetText": copy.status_set_text,
    "earlierStatusText": copy.earlier_status_text,
    "statusLabelTooLong": copy.status_label_too_long,
    "statusSaysText": copy.status_says_text,
    "rosterLine": copy.roster_line,
    "selfText": copy.self_text,
    "wrap": lambda from_name, text, source: wrap.wrap(from_name, text, source),
    "daemonSocketPath": sockpath.daemon_socket_path,
    "tools": lambda: tools.TOOLS,
}

cases = json.load(sys.stdin)
print(json.dumps([CALLS[name](*args) for name, args in cases]))
