import unittest

import support  # noqa: F401
from oa_bus import roots as R


class FakeDB:
    """Hermes's session history: compression children name their parent."""

    def __init__(self, parents):
        self.parents = parents  # session id -> parent session id, or None for a root
        self.calls = 0

    def lineage_root(self, sid):
        self.calls += 1
        if sid not in self.parents:
            return None
        while self.parents[sid] is not None:
            sid = self.parents[sid]
        return sid


class RootResolution(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB({"root": None, "rot1": "root", "rot2": "rot1", "other": None, "kid": None})
        self.roots = R.Roots(self.db.lineage_root)

    def test_a_root_is_its_own_root(self):
        self.assertEqual(self.roots.resolve("root"), "root")

    def test_compression_rotated_ids_map_to_the_root(self):
        self.assertEqual(self.roots.resolve("rot1"), "root")
        self.assertEqual(self.roots.resolve("rot2"), "root")

    def test_two_roots_stay_apart(self):
        self.assertNotEqual(self.roots.resolve("root"), self.roots.resolve("other"))

    def test_a_subagent_child_maps_to_its_delegators_root(self):
        self.roots.note_subagent("rot2", "kid")
        self.assertEqual(self.roots.root_of("kid"), "root")

    def test_a_subagent_is_refused(self):
        self.roots.note_subagent("root", "kid")
        with self.assertRaises(R.NotOnBus) as cm:
            self.roots.resolve("kid")
        self.assertEqual(str(cm.exception), R.SUBAGENT)

    def test_a_subagents_rotated_session_is_refused_too(self):
        self.db.parents["kid-rot"] = "kid"
        self.roots.note_subagent("root", "kid")
        with self.assertRaises(R.NotOnBus) as cm:
            self.roots.resolve("kid-rot")
        self.assertEqual(str(cm.exception), R.SUBAGENT)
        self.assertTrue(self.roots.is_subagent("kid-rot"))

    def test_a_session_hermes_does_not_know_is_refused_with_a_clear_message(self):
        with self.assertRaises(R.NotOnBus) as cm:
            self.roots.resolve("ghost")
        self.assertEqual(str(cm.exception), R.UNRESOLVED)

    def test_a_lookup_that_fails_is_refused_not_guessed(self):
        def boom(_sid):
            raise RuntimeError("database is locked")

        with self.assertRaises(R.NotOnBus) as cm:
            R.Roots(boom).resolve("root")
        self.assertEqual(str(cm.exception), R.UNRESOLVED)

    def test_no_session_id_is_refused(self):
        for sid in (None, ""):
            with self.assertRaises(R.NotOnBus) as cm:
                self.roots.resolve(sid)
            self.assertEqual(str(cm.exception), R.NO_SESSION)

    def test_a_resolved_id_is_looked_up_once(self):
        self.roots.resolve("rot2")
        self.roots.resolve("rot2")
        self.assertEqual(self.db.calls, 1)

    def test_a_failed_lookup_is_retried_next_time(self):
        with self.assertRaises(R.NotOnBus):
            self.roots.resolve("late")
        self.db.parents["late"] = None
        self.assertEqual(self.roots.resolve("late"), "late")


class HermesLineage(unittest.TestCase):
    """hermes_lineage_root against fake hermes_constants and hermes_state modules."""

    def setUp(self):
        import pathlib
        import sys
        import tempfile
        import types

        self.home = pathlib.Path(tempfile.mkdtemp(prefix="oab-h-"))
        self.addCleanup(__import__("shutil").rmtree, self.home, True)
        self.opened = []
        test = self

        class SessionDB:
            def __init__(self, db_path=None, read_only=False):
                test.opened.append((db_path, read_only))

            def get_compression_lineage(self, sid):
                return {"rot": ["root", "rot"], "root": ["root"]}.get(sid, [])

        const = types.ModuleType("hermes_constants")
        const.get_hermes_home = lambda: test.home
        state = types.ModuleType("hermes_state")
        state.SessionDB = SessionDB
        saved = {k: sys.modules.get(k) for k in ("hermes_constants", "hermes_state")}
        sys.modules.update(hermes_constants=const, hermes_state=state)
        R._dbs.clear()

        def restore():
            for k, v in saved.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v
            R._dbs.clear()

        self.addCleanup(restore)

    def test_opens_the_homes_state_db_read_only(self):
        (self.home / "state.db").write_bytes(b"")
        self.assertEqual(R.hermes_lineage_root("rot"), "root")
        self.assertEqual(self.opened, [(self.home / "state.db", True)])

    def test_the_handle_is_reused_for_the_same_path(self):
        (self.home / "state.db").write_bytes(b"")
        R.hermes_lineage_root("rot")
        R.hermes_lineage_root("root")
        self.assertEqual(len(self.opened), 1)

    def test_a_changed_home_is_followed(self):
        import pathlib
        import tempfile

        (self.home / "state.db").write_bytes(b"")
        R.hermes_lineage_root("rot")
        first = self.home
        other = pathlib.Path(tempfile.mkdtemp(prefix="oab-h2-"))
        self.addCleanup(__import__("shutil").rmtree, other, True)
        (other / "state.db").write_bytes(b"")
        self.home = other
        R.hermes_lineage_root("rot")
        self.assertEqual([p for p, _ in self.opened], [first / "state.db", other / "state.db"])

    def test_no_history_file_means_unresolved_and_nothing_is_opened(self):
        self.assertIsNone(R.hermes_lineage_root("rot"))
        self.assertEqual(self.opened, [])
        with self.assertRaises(R.NotOnBus):
            R.Roots().resolve("rot")

    def test_an_unknown_session_is_none(self):
        (self.home / "state.db").write_bytes(b"")
        self.assertIsNone(R.hermes_lineage_root("ghost"))


if __name__ == "__main__":
    unittest.main()
