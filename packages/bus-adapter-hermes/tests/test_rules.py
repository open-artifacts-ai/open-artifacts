import unittest

import support
from oa_bus.bus import Bus
from oa_bus.roots import Roots

AGENT = {
    "type": "agent",
    "agent": {"name": "hermes-1", "namespace": "ns", "kind": "hermes", "live": True, "global": False},
}
M1 = "mmmmmmmmmmmmmmm1"


def make_bus(replies):
    ctx = support.FakeCtx()
    roots = Roots({"root-1": "root-1"}.get)
    link = support.FakeLink(ref="root-1", replies={"self": AGENT, **replies})

    def connect(root, _on_deliver, _on_notice, _on_lost):
        return link

    bus = Bus(
        roots,
        inject=ctx.inject_message,
        connect=connect,
        spawn=support.inline_spawn,
        start="t",
        codex_runtime=lambda: False,
    )
    return bus, link


def turn(bus, sid="root-1", msg="hi"):
    return bus.turn_start(sid, "telegram", msg, [{"role": "user", "content": msg}])


class BusRules(unittest.TestCase):
    def test_rules_from_daemon_reach_turn_context(self):
        bus, link = make_bus({"habits": {"type": "habits", "rules": "RULES v1"}})
        bus.ensure("root-1")
        self.assertIn({"type": "habits"}, link.requests)
        self.assertEqual(turn(bus), {"context": "RULES v1"})

    def test_fresh_bus_picks_up_new_rules_after_simulated_update(self):
        bus1, _ = make_bus({"habits": {"type": "habits", "rules": "RULES v1"}})
        bus1.ensure("root-1")
        self.assertEqual(turn(bus1), {"context": "RULES v1"})

        bus2, _ = make_bus({"habits": {"type": "habits", "rules": "RULES v2"}})
        bus2.ensure("root-1")
        self.assertEqual(turn(bus2), {"context": "RULES v2"})

    def test_null_rules_opted_out_gives_no_rules_in_context(self):
        bus, _ = make_bus({"habits": {"type": "habits", "rules": None}})
        bus.ensure("root-1")
        self.assertIsNone(turn(bus))

    def test_error_frame_gives_no_rules_and_does_not_break_delivery(self):
        bus, link = make_bus({"habits": {"type": "error", "code": "bad_frame", "message": "unknown"}})
        bus.ensure("root-1")
        self.assertIsNone(turn(bus))

        bus.deliver(support.deliver_frame(M1, body="hello peer"), link)
        out = turn(bus)
        self.assertIsNotNone(out)
        self.assertIn("hello peer", out["context"])
        self.assertEqual(link.acks, [M1])


if __name__ == "__main__":
    unittest.main()
