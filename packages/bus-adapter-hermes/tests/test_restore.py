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
        s.upsert("r1", "sid", KEY, "telegram", "dm")
        self.assertEqual(os.stat(s.path).st_mode & 0o777, 0o600)
        self.assertEqual(s.recent()[0][1]["chat_type"], "dm")
        self.assertEqual(s.recent()[0][0], "r1")
        self.assertEqual(s.recent()[0][1]["key"], KEY)

    def test_old_entries_are_not_returned_and_cap_is_20(self):
        now = [0.0]
        s = store(now)
        s.upsert("old", "s", "k-old", "telegram", "dm")
        now[0] = MAX_AGE_S + 1
        for i in range(MAX_ROOTS + 5):
            now[0] += 1
            s.upsert(f"r{i}", "s", f"k{i}", "telegram", "dm")
        got = [r for r, _ in s.recent()]
        self.assertNotIn("old", got)
        self.assertEqual(len(got), MAX_ROOTS)
        self.assertEqual(got[0], f"r{MAX_ROOTS + 4}")
        with open(s.path) as f:
            self.assertEqual(len(json.load(f)), MAX_ROOTS)

    def test_no_fchmod_means_no_file(self):
        now = [1.0]
        s = store(now)
        real = os.fchmod
        del os.fchmod
        try:
            s.upsert("r1", "sid", KEY, "telegram", "dm")
        finally:
            os.fchmod = real
        self.assertFalse(os.path.exists(s.path))
        self.assertEqual(os.listdir(os.path.dirname(s.path)), [])

    def test_a_file_that_is_not_owner_only_or_is_a_link_is_ignored(self):
        now = [1.0]
        s = store(now)
        s.upsert("r1", "sid", KEY, "telegram", "dm")
        os.chmod(s.path, 0o644)
        self.assertEqual(s.recent(), [])
        os.chmod(s.path, 0o600)
        self.assertEqual(len(s.recent()), 1)
        real = s.path + ".real"
        os.rename(s.path, real)
        os.symlink(real, s.path)
        self.assertEqual(s.recent(), [])

    def test_one_key_is_one_root_in_the_file(self):
        now = [1.0]
        s = store(now)
        s.upsert("old", "s1", KEY, "telegram", "dm")
        s.upsert("new", "s2", KEY, "telegram", "dm")
        self.assertEqual([r for r, _ in s.recent()], ["new"])

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

    def turn(self, sid="s1", platform="telegram", key=KEY, chat_type="dm"):
        self.bus.turn_start(sid, platform, "hi", [{"role": "user", "content": "hi"}], session_key=key, chat_type=chat_type)
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


class WhoIsWoken(unittest.TestCase):
    def run_case(self, chat_type, key=KEY, platform="telegram", wake=()):
        e = Env()
        e.bus._wake_allow = lambda: list(wake)
        e.turn("s1", platform, key=key, chat_type=chat_type)
        link = support.FakeLink(ref="r1", replies={"self": {"type": "agent", "agent": {"name": "a", "global": False}}})
        e.bus.deliver(support.deliver_frame(M1), link)
        return e, link

    def test_a_dm_is_woken(self):
        e, link = self.run_case("dm")
        self.assertEqual(e.ctx.keys, [KEY])
        self.assertEqual(link.acks, [M1])

    def test_a_group_a_channel_a_shared_chat_and_an_unknown_type_queue(self):
        for t in ("group", "channel", "shared", None, "weird"):
            e, link = self.run_case(t)
            self.assertEqual(e.ctx.injected, [], t)
            self.assertEqual(link.acks, [], t)
            self.assertEqual(len(e.bus.state("r1").queue), 1, t)

    def test_a_group_is_woken_only_by_its_exact_key(self):
        e, _ = self.run_case("group", wake=["telegram"])  # a platform never wakes a group
        self.assertEqual(e.ctx.injected, [])
        e, _ = self.run_case("group", wake=[KEY])
        self.assertEqual(e.ctx.keys, [KEY])
        e, _ = self.run_case(None, wake=[KEY])
        self.assertEqual(e.ctx.keys, [KEY])
        e, _ = self.run_case("channel", wake=["other-key"])
        self.assertEqual(e.ctx.injected, [])

    def test_a_listed_platform_wakes_a_thread_not_a_group(self):
        e, _ = self.run_case("thread", wake=["telegram"])
        self.assertEqual(e.ctx.keys, [KEY])
        e, _ = self.run_case("thread", wake=["discord"])
        self.assertEqual(e.ctx.injected, [])

    def test_a_broken_wake_list_means_no_wake_for_a_group(self):
        e = Env()
        e.bus._wake_allow = lambda: 1 / 0
        e.turn("s1", "telegram", chat_type="group")
        self.assertFalse(e.bus._may_wake(e.bus.state("r1")))

    def test_restore_applies_the_same_rule(self):
        e = Env()
        e.turn("s1", "telegram", key=KEY, chat_type="group")
        n = Restore().restarted(e)
        n.bus.restore()
        link = support.FakeLink(ref="r1", replies={"self": {"type": "agent", "agent": {"name": "a", "global": False}}})
        n.bus.deliver(support.deliver_frame(M1), link)
        self.assertEqual(n.ctx.injected, [])
        n.bus._wake_allow = lambda: [KEY]
        n.bus.deliver(support.deliver_frame("mmmmmmmmmmmmmmm2"), link)
        self.assertEqual(n.ctx.keys, [KEY])

    def test_the_owners_config_is_read_from_the_plugin_settings(self):
        from oa_bus.plugin import _wake_list

        ctx = support.FakeCtx()
        self.assertEqual(_wake_list(ctx), [])
        ctx.config["wake"] = ["telegram", 3, KEY]
        self.assertEqual(_wake_list(ctx), ["telegram", KEY])
        ctx.config["wake"] = "telegram"
        self.assertEqual(_wake_list(ctx), [])

    def test_the_chat_type_comes_from_the_gateway_session(self):
        import sys
        import types

        from oa_bus.plugin import _bound_chat_type

        env = {}
        mod = types.ModuleType("gateway.session_context")
        mod.get_session_env = lambda name, default="": env.get(name, default)
        saved = {k: sys.modules.get(k) for k in ("gateway", "gateway.session_context")}
        sys.modules.update({"gateway": types.ModuleType("gateway"), "gateway.session_context": mod})
        try:
            self.assertIsNone(_bound_chat_type())
            env["HERMES_SESSION_CHAT_TYPE"] = "dm"
            self.assertEqual(_bound_chat_type(), "shared")  # no single user
            env["HERMES_SESSION_USER_ID"] = "42"
            self.assertEqual(_bound_chat_type(), "dm")
            env["HERMES_SESSION_CHAT_TYPE"] = "group"
            self.assertEqual(_bound_chat_type(), "group")
        finally:
            for k, v in saved.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v


class KeyMoves(unittest.TestCase):
    def test_a_key_that_moves_to_a_new_root_drops_the_old_one_and_its_mail_stays_put(self):
        e = Env()
        e.turn("s1", "telegram", key=KEY)
        old = e.bus.state("r1")
        old.queue.append(("old mail", M1))
        e.turn("s2", "telegram", key=KEY)  # /new: the chat now has another root
        self.assertIsNone(old.session_key)
        self.assertEqual([r for r, _ in e.store.recent()], ["r2"])
        self.assertTrue(old.stopped)
        link = support.FakeLink(ref="r1", replies={"self": {"type": "agent", "agent": {"name": "a", "global": False}}})
        e.bus.deliver(support.deliver_frame("mmmmmmmmmmmmmmm2"), link)
        self.assertEqual(e.ctx.injected, [])  # the old root's mail is not injected into the new session
        self.assertEqual(len(old.queue), 2)


class EndedSessions(unittest.TestCase):
    def fake_hermes(self, rows, lineage=None):
        import pathlib
        import sys
        import types

        home = pathlib.Path(tempfile.mkdtemp())
        (home / "state.db").write_text("")

        class DB:
            def __init__(self, *_a, **_k):
                pass

            def get_session(self, sid):
                return rows.get(sid)

            def get_compression_lineage(self, sid):
                return (lineage or {}).get(sid, [sid])

        c = types.ModuleType("hermes_constants")
        c.get_hermes_home = lambda: home
        st = types.ModuleType("hermes_state")
        st.SessionDB = DB
        saved = {k: sys.modules.get(k) for k in ("hermes_constants", "hermes_state")}
        sys.modules.update({"hermes_constants": c, "hermes_state": st})

        def undo():
            for k, v in saved.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v

        self.addCleanup(undo)
        from oa_bus import roots

        roots._dbs.clear()
        self.addCleanup(roots._dbs.clear)

    def test_an_ended_row_is_gone_a_live_one_or_a_rotated_tip_is_not(self):
        from oa_bus.roots import hermes_session_exists

        self.fake_hermes(
            {"a": {"ended_at": 5.0}, "b": {"ended_at": None}, "c": {"ended_at": 9.0}, "d": {"ended_at": None}},
            lineage={"c": ["c", "d"]},
        )
        self.assertFalse(hermes_session_exists("a"))
        self.assertTrue(hermes_session_exists("b"))
        self.assertTrue(hermes_session_exists("c"))  # rotated: the tip d is live
        self.assertFalse(hermes_session_exists("missing"))

    def test_restore_drops_an_ended_session(self):
        e = Env()
        e.turn()
        n = Restore().restarted(e)
        n.exists = False  # ended
        n.bus.restore()
        self.assertEqual(n.opened, [])
        self.assertEqual(n.store.recent(), [])

    def test_a_wake_for_a_session_that_ended_since_is_not_sent_and_the_root_is_dropped(self):
        e = Env()
        e.turn()
        n = Restore().restarted(e)
        n.bus.restore()
        n.exists = False  # reset by Hermes later, no finalize
        link = support.FakeLink(ref="r1", replies={"self": {"type": "agent", "agent": {"name": "a", "global": False}}})
        n.bus.deliver(support.deliver_frame(M1), link)
        self.assertEqual(n.ctx.injected, [])
        self.assertEqual(link.acks, [])
        self.assertEqual(n.store.recent(), [])
        self.assertIsNone(n.bus.state("r1").session_key)
        self.assertEqual(len(n.bus.state("r1").queue), 1)


class RefusedWakeBacksOff(unittest.TestCase):
    def test_after_a_refusal_the_root_is_not_tried_for_ten_minutes(self):
        e = Env()
        e.ctx.inject_result = False
        clock = [0.0]
        e.bus._clock = lambda: clock[0]
        e.turn()
        link = support.FakeLink(ref="r1", replies={"self": {"type": "agent", "agent": {"name": "a", "global": False}}})
        e.bus.deliver(support.deliver_frame(M1), link)
        e.bus.deliver(support.deliver_frame("mmmmmmmmmmmmmmm2"), link)
        self.assertEqual(len(e.ctx.injected), 1)  # the second was not tried
        self.assertEqual(len(e.bus.state("r1").queue), 2)  # both ride the next turn
        clock[0] = 601.0
        e.bus.deliver(support.deliver_frame("mmmmmmmmmmmmmmm3"), link)
        self.assertEqual(len(e.ctx.injected), 2)
