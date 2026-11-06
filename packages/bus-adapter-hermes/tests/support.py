"""Shared by the tests: the plugin on the path, the fixtures, and fakes for Hermes and the daemon."""

import json
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PKG, "assets"))
FIXTURES = os.path.join(PKG, "fixtures")


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return json.load(f)


class FakeCtx:
    """What Hermes hands `register(ctx)`: tools and hooks are recorded, inject_message is scripted."""

    def __init__(self, inject_result=True):
        self.tools = {}
        self.hooks = {}
        self.injected = []
        self.inject_result = inject_result

    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kw}

    def register_hook(self, name, cb):
        self.hooks.setdefault(name, []).append(cb)

    def inject_message(self, content, role="user"):
        self.injected.append(content)
        return self.inject_result


class FakeLink:
    """A Link that never touches a socket: it records acks and answers requests from `replies`."""

    def __init__(self, ref="root-1", replies=None, bus_name="hermes-proj"):
        self.ref = ref
        self.welcome = {"type": "welcome", "bus_name": bus_name, "namespace": "ns", "global": False}
        self.closed = False
        self.acks = []
        self.requests = []
        self.replies = replies or {}
        self.acked = threading.Event()

    def request(self, frame, timeout=None):
        self.requests.append(frame)
        r = self.replies.get(frame["type"])
        r = r(frame) if callable(r) else r
        if r is None:
            from oa_bus.link import LinkError

            raise LinkError("no reply")
        return {"v": 1, "id": "1", **r}

    def ack(self, msg_id):
        self.acks.append(msg_id)
        self.acked.set()

    def close(self):
        self.closed = True


def deliver_frame(msg_id="mmmmmmmmmmmmmmm1", body="hi", from_name="peer"):
    return {
        "v": 1,
        "id": f"deliver-{msg_id}",
        "type": "deliver",
        "msg_id": msg_id,
        "from_name": from_name,
        "namespace": "ns",
        "body": body,
    }


def inline_spawn(fn):
    """Runs background work at once, so a test needs no waiting."""
    fn()
