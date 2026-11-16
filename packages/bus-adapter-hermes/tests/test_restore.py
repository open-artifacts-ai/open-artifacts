import json
import os
import tempfile
import unittest

import support
from oa_bus import register
from oa_bus.bus import Bus
from oa_bus.roots import Roots
from oa_bus.state import MAX_AGE_S, MAX_ROOTS, RootStore

KEY = "agent:main:telegram:dm:1"
M1 = "mmmmmmmmmmmmmmm1"


def store(now):
    d = tempfile.mkdtemp()
    return RootStore(os.path.join(d, "gateway_roots.json"), clock=lambda: now[0])


class Store(unittest.TestCase):
    def test_file_is_owner_only_and_roundtrips(self):
        now = [1000.0]
        s = store(now)
        s.upsert("r1", "sid", KEY, "telegram")
        self.assertEqual(os.stat(s.path).st_mode & 0o777, 0o600)
        self.assertEqual(s.recent()[0][0], "r1")
        self.assertEqual(s.recent()[0][1]["key"], KEY)

    def test_old_entries_are_not_returned_and_cap_is_20(self):
        now = [0.0]
        s = store(now)
        s.upsert("old", "s", KEY, "telegram")
        now[0] = MAX_AGE_S + 1
        for i in range(MAX_ROOTS + 5):
            now[0] += 1
            s.upsert(f"r{i}", "s", KEY, "telegram")
        got = [r for r, _ in s.recent()]
        self.assertNotIn("old", got)
        self.assertEqual(len(got), MAX_ROOTS)
        self.assertEqual(got[0], f"r{MAX_ROOTS + 4}")
        with open(s.path) as f:
            self.assertEqual(len(json.load(f)), MAX_ROOTS)

    def test_a_corrupt_file_is_empty_and_drop_of_unknown_is_fine(self):
        now = [1.0]
        s = store(now)
        with open(s.path, "w") as f:
            f.write("{nope")
        self.assertEqual(s.recent(), [])
        s.drop("x")


class Env:
    def __init__(self, exists=True):
        self.now = [100.0]
        self.store = store(self.now)
        self.ctx = support.FakeCtx()
        self.roots = Roots({"s1": "r1", "s2": "r2"}.get)
        self.exists = exists
        self.bus = Bus(self.roots, inject=self.ctx.inject_message, spawn=support.inline_spawn, start="t",
                       codex_runtime=lambda: False, habits_marker=support.habits_marker(False),
                       store=self.store, session_exists=lambda sid: self.exists)
        self.opened = []
        self.bus.touch = self.opened.append

    def turn(self, sid="s1", platform="telegram", key=KEY):
        self.bus.turn_start(sid, platform, "hi", [{"role": "user", "content": "hi"}], session_key=key)
        self.bus.turn_end(sid)


class Restore(unittest.TestCase):
    def restarted(self, e):
        """A new process: a fresh Bus over the same file."""
        n = Env(e.exists)
        n.now, n.store = e.now, e.store
        n.bus._store = e.store
        return n

    def test_a_chat_turn_is_remembered_a_cli_turn_is_not(self):
        e = Env()
        e.turn("s1", "telegram")
        e.turn("s2", "cli", key="k")
        self.assertEqual([r for r, _ in e.store.recent()], ["r1"])

    def test_after_a_restart_the_root_is_linked_with_its_key_and_woken_without_a_turn(self):
        e = Env()
        e.turn()
        n = self.restarted(e)
        n.bus.restore()
        self.assertEqual(n.opened, ["r1"])
        self.assertEqual(n.bus.state("r1").session_key, KEY)
        link = support.FakeLink(ref="r1", replies={"self": {"type": "agent", "agent": {"name": "a", "global": False}}})
        n.bus.deliver(support.deliver_frame(M1), link)
        self.assertEqual(n.ctx.keys, [KEY])
        self.assertEqual(link.acks, [M1])

    def test_a_session_gone_from_hermes_is_dropped_not_linked(self):
        e = Env()
        e.turn()
        n = self.restarted(e)
        n.exists = False
        n.bus.restore()
        self.assertEqual(n.opened, [])
        self.assertEqual(n.store.recent(), [])

    def test_week_old_entries_are_not_restored(self):
        e = Env()
        e.turn()
        e.now[0] += MAX_AGE_S + 1
        n = self.restarted(e)
        n.bus.restore()
        self.assertEqual(n.opened, [])

    def test_shutdown_keeps_the_entry_any_other_finalize_drops_it(self):
        e = Env()
        e.turn()
        e.bus.session_finalize("s1", "shutdown")
        self.assertEqual(len(e.store.recent()), 1)
        e.bus.session_finalize("s1", "new_session")
        self.assertEqual(e.store.recent(), [])

    def test_the_plugin_restores_in_the_background_only_when_the_gateway_is_live(self):
        e = Env()
        e.turn()
        n = self.restarted(e)
        calls = []
        n.bus._spawn = lambda fn: calls.append(fn)
        register(n.ctx, roots=n.roots, bus=n.bus, gateway_ready=lambda: True)
        self.assertEqual(n.opened, [])  # load did not run it inline
        calls[-1]()
        self.assertEqual(n.opened, ["r1"])

    def test_a_cli_process_never_restores(self):
        e = Env()
        e.turn()
        n = self.restarted(e)
        register(n.ctx, roots=n.roots, bus=n.bus)  # FakeCtx has no gateway manager
        self.assertEqual(n.opened, [])

    def test_the_plugin_waits_for_the_gateway_then_restores_once(self):
        from oa_bus.plugin import _restore_when_live

        e = Env()
        e.turn()
        n = self.restarted(e)
        states = iter([False, False, True])
        _restore_when_live(n.bus, lambda: next(states), sleep=lambda _s: None)
        self.assertEqual(n.opened, ["r1"])
        _restore_when_live(n.bus, lambda: False, tries=3, sleep=lambda _s: None)
        self.assertEqual(n.opened, ["r1"])

    def test_the_finalize_hook_passes_the_reason(self):
        e = Env()
        e.turn()
        register(e.ctx, roots=e.roots, bus=e.bus)
        e.ctx.hooks["on_session_finalize"][0](session_id="s1", reason="shutdown", session_key=KEY)
        self.assertEqual(len(e.store.recent()), 1)
        e.ctx.hooks["on_session_finalize"][0](session_id="s1", reason="new_session")
        self.assertEqual(e.store.recent(), [])


if __name__ == "__main__":
    unittest.main()
