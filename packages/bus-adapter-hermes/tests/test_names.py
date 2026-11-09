"""The bus name is the session title as the user typed it (#1704), the directory name otherwise."""

import unittest

import support  # noqa: F401  (puts the plugin on the path)
from oa_bus.bus import Bus, name_of
from oa_bus.roots import Roots, hermes_session_title


class NameOf(unittest.TestCase):
    def test_keeps_case_and_spaces(self):
        self.assertEqual(name_of("OA Agent Experience", "fb"), "OA Agent Experience")

    def test_strips_control_characters_and_trims(self):
        self.assertEqual(name_of("  My\x07 Proj\x1b \x7f", "fb"), "My Proj")

    def test_folds_accents_and_joins_punctuation_runs(self):
        self.assertEqual(name_of("Café (v2)!", "fb"), "Cafe v2")
        self.assertEqual(name_of("docs/readme", "fb"), "docs-readme")

    def test_collapses_space_runs(self):
        self.assertEqual(name_of("a    b", "fb"), "a b")

    def test_fits_64_characters_without_a_trailing_space_or_dot(self):
        out = name_of("ab " * 30 + "tail", "fb")
        self.assertEqual(len(out), 64)
        self.assertTrue(out[-1] not in " .")

    def test_an_emoji_at_the_cut_is_dropped_not_split(self):
        self.assertEqual(name_of("a" * 63 + "\U0001F600", "fb"), "a" * 63)

    def test_falls_back_when_empty_whitespace_or_nothing_valid(self):
        for t in (None, "", "   ", "\x01\x7f", "!!!", "\U0001F600"):
            self.assertEqual(name_of(t, "fb"), "fb", repr(t))

    def test_default_fallback_is_hermes(self):
        self.assertEqual(name_of(""), "hermes")

    def test_never_starts_or_ends_with_a_forbidden_character(self):
        for t in ("..a..", "- - -", "x.", " .b", "_a_"):
            out = name_of(t, "fb")
            self.assertRegex(out, r"^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9_-])?$", out)


class Connect(unittest.TestCase):
    def proposed(self, title, cwd="/work/My Proj"):
        seen = {}

        def fake_link(ref, cwd_, name, *a, **k):
            seen["name"] = name

            class L:
                def open(self_):
                    return self_

            return L()

        import oa_bus.bus as busmod

        old = busmod.Link
        busmod.Link = fake_link
        self.addCleanup(setattr, busmod, "Link", old)
        bus = Bus(Roots(lambda s: s), start="t", cwd=cwd, title_of=lambda ref: title)
        bus._real_connect(bus.state("root-1"), None, None, None)
        return seen["name"]

    def test_user_title_goes_as_typed(self):
        self.assertEqual(self.proposed("OA Hermes Lead"), "OA Hermes Lead")

    def test_no_title_keeps_the_directory_name(self):
        self.assertEqual(self.proposed(None), "hermes-my-proj")

    def test_unusable_title_keeps_the_directory_name(self):
        self.assertEqual(self.proposed("!!!"), "hermes-my-proj")

    def test_no_directory_and_no_title_is_the_kind(self):
        self.assertEqual(self.proposed(None, cwd="/"), "hermes")


class SessionTitle(unittest.TestCase):
    def fake_db(self, title, source):
        class DB:
            def get_session_title(self_, sid):
                return title

            def get_session_title_source(self_, sid):
                return source

        return DB()

    def test_only_a_user_set_title_counts(self):
        self.assertEqual(hermes_session_title("r", db=self.fake_db("Mine", "user")), "Mine")
        self.assertIsNone(hermes_session_title("r", db=self.fake_db("Auto", "llm")))
        self.assertIsNone(hermes_session_title("r", db=self.fake_db("Auto", "derived")))
        self.assertIsNone(hermes_session_title("r", db=self.fake_db(None, None)))

    def test_a_failing_lookup_is_no_title(self):
        class Boom:
            def get_session_title(self_, sid):
                raise RuntimeError("locked")

        self.assertIsNone(hermes_session_title("r", db=Boom()))


if __name__ == "__main__":
    unittest.main()
