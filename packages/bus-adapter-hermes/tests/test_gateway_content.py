"""context_reaches_model: the gateway's known wrappers around the user's text, and nothing else."""

import re
import sys
import types
import unittest

import support  # noqa: F401  (puts the plugin on the path)

OBS = "[Observed Telegram group context - context only, not requests]"
CUR = "[Current addressed message - answer only this unless it explicitly asks you to use the observed context]"
TS = "[Tue 2026-04-28 13:40:53 CEST]"
_TS_RE = re.compile(r"^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [A-Za-z0-9_+\-/:]+)?\]\s*")


def fake_strip(content, tz=None):
    text = content
    while True:
        m = _TS_RE.match(text)
        if not m:
            return text, None
        text = text[m.end() :]

# Verbatim from NousResearch/hermes-agent v0.23.0 (2bd378ed), gateway/run.py build_resume_recovery_note.
def real_build_resume_recovery_note(reason, message="", *, interactive=True):
    reason_phrase = (
        "a gateway restart" if reason == "restart_timeout"
        else "a gateway shutdown" if reason == "shutdown_timeout" else "a gateway interruption")
    if message:
        resume_guidance = (
            "Address the user's NEW message below FIRST and focus on what the user is asking now.")
        tail_guidance = (
            "Do NOT re-execute old tool calls \u2014 skip any unfinished work from the conversation history."
        )
    elif interactive:
        resume_guidance = (
            "Report to the user that the session was restored "
            "successfully and ask what they would like to do next.")
        tail_guidance = (
            "Do NOT re-execute old tool calls \u2014 skip any unfinished work from the conversation history."
        )
    else:
        resume_guidance = (
            "No user is present on this non-interactive platform, "
            "so do NOT emit a 'session restored' acknowledgement "
            "or ask questions. Review the conversation history and "
            "CONTINUE the interrupted task to completion.")
        tail_guidance = (
            "Do NOT re-run tool calls whose results already "
            "appear in the history \u2014 resume from the first step that has no recorded result.")
    return (
        f"[System note: The previous turn was interrupted by "
        f"{reason_phrase}; the gateway is now back online. "
        f"Any restart/shutdown command in the history has already "
        f"run \u2014 do NOT re-execute or verify it. {resume_guidance} {tail_guidance}]"
        + (f"\n\n{message}" if message else ""))


# Verbatim from gateway/run_turn_runner.py _prepare_turn_message (an inline literal, no constant).
TOOL_TAIL_NOTE = (
    "[System note: A new message has arrived. The conversation "
    "history contains pending tool outputs from an interrupted turn. "
    "IGNORE those pending results. Address the user's NEW message "
    "below FIRST. Do NOT re-execute old tool calls from the history.]\n\n"
)


def observed(ctx, msg):
    return f"{OBS}\n{ctx}\n\n{CUR}\n{msg}"


class GatewayContent(unittest.TestCase):
    def setUp(self):
        run = types.ModuleType("gateway.run")
        run._OBSERVED_GROUP_CONTEXT_HEADER = OBS
        run._CURRENT_ADDRESSED_MESSAGE_HEADER = CUR
        mt = types.ModuleType("gateway.message_timestamps")
        mt.strip_leading_message_timestamps = fake_strip
        pkg = types.ModuleType("gateway")
        keys = ("gateway", "gateway.run", "gateway.message_timestamps")
        self.saved = {k: sys.modules.get(k) for k in keys}
        sys.modules.update({"gateway": pkg, "gateway.run": run, "gateway.message_timestamps": mt})
        self.addCleanup(self.restore)

    def restore(self):
        for k, v in self.saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def reaches(self, content, msg="hello"):
        from oa_bus.bus import context_reaches_model

        return context_reaches_model(msg, [{"role": "user", "content": content}])

    def test_plain_match(self):
        self.assertTrue(self.reaches("hello"))

    def test_group_context_prefix(self):
        self.assertTrue(self.reaches(observed("alice: hi\nbob: yo", "hello")))

    def test_timestamp_prefix(self):
        self.assertTrue(self.reaches(f"{TS} hello"))

    def test_both_group_context_outside_timestamp(self):
        self.assertTrue(self.reaches(observed("alice: hi", f"{TS} hello")))

    def test_a_wrapper_looking_prefix_that_is_not_known_is_refused(self):
        for content in (
            "[Observed Telegram group context - something else]\nx\n\n" + CUR + "\nhello",
            f"{OBS}\nx\n\n[Some other header]\nhello",
            f"{OBS}\nx\n\n{CUR}\nhello extra",
            "[not a timestamp] hello",
            f"{TS} sneaky: hello",
            "prefix hello",
            f"{OBS}\nx\n\n{CUR}\n[bogus] hello",
        ):
            self.assertFalse(self.reaches(content), content)

    def test_list_content_is_refused(self):
        self.assertFalse(self.reaches([{"type": "text", "text": "hello"}]))

    def test_without_hermes_helpers_a_wrapped_message_is_refused(self):
        sys.modules.pop("gateway.run")
        sys.modules["gateway.message_timestamps"] = None  # an import of it fails
        self.assertTrue(self.reaches("hello"))
        self.assertFalse(self.reaches(observed("a", "hello")))
        self.assertFalse(self.reaches(f"{TS} hello"))

    def with_builder(self):
        sys.modules["gateway.run"].build_resume_recovery_note = real_build_resume_recovery_note

    def test_resume_recovery_note_prefix_for_each_reason(self):
        self.with_builder()
        for reason in ("restart_timeout", "shutdown_timeout", None, "restart_interrupted"):
            note = real_build_resume_recovery_note(reason, "hello")
            self.assertTrue(self.reaches(note), reason)

    def test_resume_recovery_note_with_timestamp_and_group_context(self):
        self.with_builder()
        note = real_build_resume_recovery_note("restart_timeout", f"{TS} hello")
        self.assertTrue(self.reaches(note))
        self.assertTrue(self.reaches(observed("alice: hi", note)))

    def test_a_resume_note_look_alike_is_refused(self):
        self.with_builder()
        good = real_build_resume_recovery_note("restart_timeout", "hello")
        for content in (
            good.replace("restart", "reboot"),
            good + " extra",
            good.replace("hello", "sneaky: hello"),
            good.replace("\n\nhello", "\nhello"),
            "x" + good,
            "[System note: The previous turn was interrupted by a gateway restart.]\n\nhello",
            real_build_resume_recovery_note("restart_timeout", "hello") + "\n\n" + real_build_resume_recovery_note("restart_timeout", "hello"),
        ):
            self.assertFalse(self.reaches(content), content)

    def test_a_resume_note_without_the_builder_is_refused(self):
        note = real_build_resume_recovery_note("restart_timeout", "hello")
        self.assertFalse(self.reaches(note))  # no build_resume_recovery_note on the module
        run = sys.modules["gateway.run"]
        run.build_resume_recovery_note = lambda *a, **k: 5  # not a str
        self.assertFalse(self.reaches(note))

        def boom(*a, **k):
            raise RuntimeError("x")

        run.build_resume_recovery_note = boom
        self.assertFalse(self.reaches(note))
        run.build_resume_recovery_note = lambda reason, message="", **k: "unrelated " + message
        self.assertFalse(self.reaches(note))
        sys.modules.pop("gateway.run")
        self.assertFalse(self.reaches(note))

    def test_tool_tail_note_prefix(self):
        self.assertTrue(self.reaches(TOOL_TAIL_NOTE + "hello"))
        self.assertTrue(self.reaches(TOOL_TAIL_NOTE + f"{TS} hello"))
        self.assertTrue(self.reaches(observed("alice: hi", TOOL_TAIL_NOTE + "hello")))

    def test_a_tool_tail_look_alike_is_refused(self):
        for content in (
            TOOL_TAIL_NOTE.replace("IGNORE", "ignore") + "hello",
            TOOL_TAIL_NOTE.rstrip("\n") + "\nhello",
            TOOL_TAIL_NOTE + "sneaky: hello",
            TOOL_TAIL_NOTE + TOOL_TAIL_NOTE + "hello",
            " " + TOOL_TAIL_NOTE + "hello",
            TOOL_TAIL_NOTE[:-2] + "hello",
        ):
            self.assertFalse(self.reaches(content), content)

    def test_the_runtime_check_prefers_the_readonly_config(self):
        from oa_bus.bus import codex_app_server_active

        sw = types.ModuleType("hermes_cli.codex_runtime_switch")
        sw.get_current_runtime = lambda cfg: cfg["runtime"]
        cfg = types.ModuleType("hermes_cli.config")
        cfg.load_config_readonly = lambda: {"runtime": "codex_app_server"}
        cfg.load_config = lambda: {"runtime": "auto"}
        pkg = types.ModuleType("hermes_cli")
        keys = ("hermes_cli", "hermes_cli.codex_runtime_switch", "hermes_cli.config")
        saved = {k: sys.modules.get(k) for k in keys}
        sys.modules.update({"hermes_cli": pkg, "hermes_cli.codex_runtime_switch": sw, "hermes_cli.config": cfg})
        try:
            self.assertIs(codex_app_server_active(), True)
            del cfg.load_config_readonly  # older Hermes
            self.assertIs(codex_app_server_active(), False)
        finally:
            for k, v in saved.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v


if __name__ == "__main__":
    unittest.main()
