import json
import unittest

import support
from oa_bus import register
from oa_bus.bus import HABITS, Bus
from oa_bus.roots import NO_SESSION, SUBAGENT, UNRESOLVED, Roots

NAMES = [
    "oabus_list_agents",
    "oabus_send_message",
    "oabus_fetch",
    "oabus_self",
    "oabus_set_status",
    "oabus_follow",
    "oabus_unfollow",
    "oabus_following",
]
AGENT = {"name": "a", "namespace": "ns", "kind": "hermes", "live": True, "global": False}


def plugin(replies=None, known=None):
    known = known or {"root-1": "root-1", "rot": "root-1"}
    ctx = support.FakeCtx()
    roots = Roots(known.get)
    bus = Bus(roots, inject=ctx.inject_message, spawn=support.inline_spawn, start="t",
               habits_marker=support.habits_marker())
    link = support.FakeLink(ref="root-1", replies=replies or {})
    bus.ensure = lambda ref: link
    register(ctx, roots=roots, bus=bus)
    return ctx, roots, bus, link


def call(ctx, name, args=None, **kw):
    return ctx.tools[name]["handler"](args or {}, **kw)


class Registration(unittest.TestCase):
    def test_registers_the_bus_tools_under_pis_names(self):
        ctx, *_ = plugin()
        self.assertEqual(sorted(ctx.tools), sorted(NAMES))
        for name, t in ctx.tools.items():
            self.assertEqual(t["schema"]["name"], name)
            self.assertEqual(t["schema"]["parameters"]["type"], "object")

    def test_registers_the_hooks(self):
        ctx, *_ = plugin()
        self.assertEqual(
            sorted(ctx.hooks), ["on_session_end", "on_session_finalize", "pre_llm_call", "subagent_start"]
        )

    def test_hooks_take_unknown_keyword_arguments(self):
        ctx, *_ = plugin()
        ctx.hooks["pre_llm_call"][0](session_id="root-1", platform="cli", telemetry_schema_version=3, extra=1)
        ctx.hooks["on_session_end"][0](session_id="root-1", completed=True, new_thing=1)
        ctx.hooks["on_session_finalize"][0](session_id=None, platform="cli")
        ctx.hooks["subagent_start"][0](parent_session_id="root-1", child_session_id="kid", child_role="x")

    def test_pre_llm_call_passes_user_message_through(self):
        ctx, _, bus, link = plugin()
        bus.state("root-1").queue.append(("queued text", "mmmmmmmmmmmmmmm1"))
        bus.state("root-1").link = link
        hook = ctx.hooks["pre_llm_call"][0]
        bus._codex_runtime = lambda: False
        img = [{"role": "user", "content": [{"type": "image"}]}]
        self.assertIsNone(hook(session_id="root-1", platform="telegram", user_message="[image]", conversation_history=img))
        self.assertIsNone(hook(session_id="root-1", platform="telegram", user_message="hi"))  # no history
        self.assertEqual(link.acks, [])
        hist = [{"role": "user", "content": "hi"}]
        self.assertEqual(
            hook(session_id="root-1", platform="telegram", user_message="hi", conversation_history=hist),
            {"context": f"queued text\n\n{HABITS}"},
        )
        self.assertEqual(link.acks, ["mmmmmmmmmmmmmmm1"])

    def test_the_handler_takes_the_arguments_hermes_passes(self):
        ctx, *_ = plugin({"list": {"type": "roster", "agents": []}})
        out = call(ctx, "oabus_list_agents", {}, task_id="t", session_id="root-1", user_task="u", more=1)
        self.assertEqual(out, "No agents in your namespace and linked ones.")


class WhichSession(unittest.TestCase):
    def test_a_rotated_id_calls_as_the_root(self):
        ctx, *_ = plugin({"list": {"type": "roster", "agents": []}})
        self.assertNotIn("error", call(ctx, "oabus_list_agents", session_id="rot"))

    def test_a_subagent_is_refused(self):
        ctx, *_ = plugin()
        ctx.hooks["subagent_start"][0](parent_session_id="root-1", child_session_id="kid")
        out = json.loads(call(ctx, "oabus_self", session_id="kid"))
        self.assertEqual(out, {"error": SUBAGENT})

    def test_an_unknown_session_is_refused_not_guessed(self):
        ctx, _, _, link = plugin()
        out = json.loads(call(ctx, "oabus_self", session_id="ghost"))
        self.assertEqual(out, {"error": UNRESOLVED})
        self.assertEqual(link.requests, [])

    def test_a_call_with_no_session_id_is_refused(self):
        ctx, *_ = plugin()
        self.assertEqual(json.loads(call(ctx, "oabus_self")), {"error": NO_SESSION})


class Tools(unittest.TestCase):
    def test_send_message_returns_the_delivered_receipt_and_sends_the_session_on_its_link(self):
        ctx, _, _, link = plugin({"send": {"type": "receipt", "msg_id": "m", "state": "delivered"}})
        out = call(ctx, "oabus_send_message", {"to": "bob", "text": "hi"}, session_id="root-1")
        self.assertEqual(out, "✓  Delivered to bob.")
        self.assertEqual(link.requests[0]["type"], "send")
        self.assertEqual((link.requests[0]["to"], link.requests[0]["body"]), ("bob", "hi"))

    def test_a_refusal_is_an_error_with_the_copy(self):
        ctx, *_ = plugin({"send": {"type": "receipt", "msg_id": "m", "state": "refused", "reason": "unknown_agent"}})
        out = json.loads(call(ctx, "oabus_send_message", {"to": "bob", "text": "hi"}, session_id="root-1"))
        self.assertIn("Refused (unknown_agent)", out["error"])
        self.assertIn("list_agents", out["error"])

    def test_late_notices_ride_after_the_result(self):
        ctx, *_ = plugin({"send": {"type": "receipt", "msg_id": "m", "state": "delivered", "late": ["Delivered earlier."]}})
        out = call(ctx, "oabus_send_message", {"to": "bob", "text": "hi"}, session_id="root-1")
        self.assertEqual(out, "✓  Delivered to bob.\n\nDelivered earlier.")

    def test_requests_ask_for_late_notices(self):
        ctx, _, _, link = plugin({"list": {"type": "roster", "agents": [AGENT]}})
        call(ctx, "oabus_list_agents", session_id="root-1")
        self.assertIs(link.requests[0]["late"], True)

    def test_list_agents_shows_a_roster_line(self):
        ctx, *_ = plugin({"list": {"type": "roster", "agents": [{**AGENT, "name": "bob", "kind": "pi"}]}})
        self.assertEqual(call(ctx, "oabus_list_agents", session_id="root-1"), "- bob (pi, ns)")

    def test_send_needs_to_and_text(self):
        ctx, *_ = plugin()
        out = json.loads(call(ctx, "oabus_send_message", {"to": "bob"}, session_id="root-1"))
        self.assertEqual(out, {"error": "oa-bus: to and text are required"})

    def test_set_status_checks_the_state_and_cleans_the_label(self):
        ctx, _, _, link = plugin({"set_status": {"type": "status_set"}})
        bad = json.loads(call(ctx, "oabus_set_status", {"state": "asleep"}, session_id="root-1"))
        self.assertIn("must be one of working, idle, blocked, waiting_on_owner", bad["error"])
        out = call(ctx, "oabus_set_status", {"state": "working", "label": " a \n b​ "}, session_id="root-1")
        self.assertEqual(out, 'Your status is now working: "a b". The user sees it as your own report.')
        self.assertEqual(link.requests[0]["label"], "a b")

    def test_follow_sends_the_artifact_only_and_says_what_the_agent_gets(self):
        entry = {"artifact_id": "abc", "url": "https://x.test/a/abc", "followed_at": "2026-11-09T10:00:00.000Z"}
        ctx, _, _, link = plugin({"follow": {"type": "followed", **entry}})
        out = call(ctx, "oabus_follow", {"artifact": " https://x.test/a/abc ", "name": "other"}, session_id="root-1")
        self.assertEqual(out, "Following https://x.test/a/abc. You get a notice here when it changes.")
        self.assertEqual(
            [{k: v for k, v in r.items() if k != "late"} for r in link.requests],
            [{"type": "follow", "artifact": "https://x.test/a/abc"}],
        )

    def test_unfollow_and_following(self):
        entry = {"artifact_id": "abc", "url": "https://x.test/a/abc", "followed_at": "2026-11-09T10:00:00.000Z"}
        ctx, *_ = plugin({"unfollow": {"type": "unfollowed", "removed": False}, "following": {"type": "follows", "follows": [entry]}})
        self.assertEqual(call(ctx, "oabus_unfollow", {"artifact": "abc"}, session_id="root-1"), "You were not following abc.")
        self.assertEqual(call(ctx, "oabus_following", session_id="root-1"), "https://x.test/a/abc (since 2026-11-09T10:00:00.000Z)")

    def test_follow_refusals(self):
        ctx, _, _, link = plugin({"follow": {"type": "error", "code": "not_found", "message": "Not found"}})
        self.assertEqual(json.loads(call(ctx, "oabus_follow", {"artifact": "abc"}, session_id="root-1")), {"error": "oa-bus: Not found"})
        empty = json.loads(call(ctx, "oabus_follow", {"artifact": " "}, session_id="root-1"))
        self.assertIn("artifact is required", empty["error"])
        self.assertEqual(len(link.requests), 1)
        old, *_ = plugin({"following": {"type": "error", "code": "bad_frame", "message": "Invalid input"}})
        out = json.loads(call(old, "oabus_following", session_id="root-1"))
        self.assertEqual(out, {"error": "This oa-bus daemon is too old to follow artifacts. Ask the user to update oa-bus."})

    def test_self_prints_the_agent_entry(self):
        ctx, *_ = plugin({"self": {"type": "agent", "agent": AGENT}})
        self.assertEqual(json.loads(call(ctx, "oabus_self", session_id="root-1")), AGENT)

    def test_fetch_strips_terminal_controls(self):
        ctx, *_ = plugin({"fetch": {"type": "body", "msg_id": "m", "body": "x\x1b[31my"}})
        self.assertEqual(call(ctx, "oabus_fetch", {"msg_id": "m"}, session_id="root-1"), "xy")

    def test_a_daemon_that_is_down_is_an_error_the_agent_can_read(self):
        from oa_bus.link import LinkError

        ctx, _, bus, _ = plugin()

        def down(_ref):
            raise LinkError("the daemon is not reachable")

        bus.ensure = down
        out = json.loads(call(ctx, "oabus_self", session_id="root-1"))
        self.assertEqual(out, {"error": "oa-bus: the daemon is not reachable"})


if __name__ == "__main__":
    unittest.main()
