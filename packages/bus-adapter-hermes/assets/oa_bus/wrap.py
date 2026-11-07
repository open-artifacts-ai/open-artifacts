"""The frame a peer's message reaches Hermes in.

The same `<cross-session-message>` wrapper Claude Code gets
(bus-adapter-claude-code/src/inject.ts): a body can neither close it nor open
a second one with a forged sender.
"""

import re

from .copy import WS

# JavaScript's /i is ASCII-only here, and its \s is the WS class.
_NESTED = re.compile(rf"<([{WS}]*/?[{WS}]*cross-session-message)", re.IGNORECASE | re.ASCII)


def attr(s):
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def neutralize(s):
    return _NESTED.sub(lambda m: "&lt;" + m.group(1), s)


def wrap(from_name, text, source="oa-bus"):
    """`text` inside the wrapper, a sender that is the bus's own word for it."""
    return (
        f'<cross-session-message from="{attr(source)}" from-name="{attr(from_name)}" '
        f'from-mode="prompting">\n{neutralize(text)}\n</cross-session-message>'
    )
