"""#1856 (part of #1822): per-session proof for Hermes.

Each root makes a random proof when its link opens or reconnects and tells the
daemon its hash on that link. Our tool_execution middleware adds the proof, as
the reserved argument `_oa_agent_proof`, to calls to this instance's
open-artifacts MCP tools only. Any failure leaves the root unlinked with every
tool working. Waits are signals (events), never sleeps.
"""

import asyncio
import base64
import hashlib
import json
import os
import shutil
import socket
import tempfile
import threading
import unittest

import support
from oa_bus import frames, link as link_mod, register
from oa_bus.bus import Bus
from oa_bus.link import Link
from oa_bus import proof as proof_mod
from oa_bus.proof import ARG
from oa_bus.roots import Roots
from oa_bus.sockpath import daemon_socket_path


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


class FakeDaemon:
    """A daemon on a real unix socket that answers hello, and link_proof as scripted."""

    def __init__(self, home, caps=("link",), answer="bound"):
        self.caps = list(caps)
        self.answer = answer
        self.hellos = []
        self.proofs = []
        self.proofed = threading.Event()
        self.conns = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(daemon_socket_path(home))
        self.server.listen(8)
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            self.conns.append(conn)
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _write(self, conn, f):
        conn.sendall((json.dumps({"v": 1, **f}) + "\n").encode())

    def _serve(self, conn):
        buf = b""
        while True:
            try:
                chunk = conn.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                f = json.loads(line)
                if f["type"] == "hello":
                    self.hellos.append(f)
                    welcome = {"id": "hello", "type": "welcome", "agent_ref": f["agent_ref"],
                               "bus_name": "n", "namespace": "ns", "global": False}
                    if self.caps:
                        welcome["caps"] = self.caps
                    self._write(conn, welcome)
                elif f["type"] == "link_proof":
                    self.proofs.append((f["agent_ref"] if "agent_ref" in f else None, f))
                    self.proofed.set()
                    if self.answer == "bound":
                        self._write(conn, {"id": f["id"], "type": "link_proofed", "bound": True})
                    elif self.answer == "unbound":
                        self._write(conn, {"id": f["id"], "type": "link_proofed", "bound": False})
                    elif self.answer == "error":
                        self._write(conn, {"id": f["id"], "type": "error", "code": "bad_frame", "message": "no"})
                    # "silent": no answer

    def close(self):
        self.server.close()
        for c in self.conns:
            c.close()


class OverASocket(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="oap-")
        self.addCleanup(shutil.rmtree, self.home, True)

    def link(self, ref="root-1", **kw):
        l = Link(ref, "/tmp", "hermes-x", "Fri Nov  6 21:00:00 2026", os.getpid(),
                 lambda *a: None, lambda *a: None, lambda *a: None, home=self.home, **kw).open()
        self.addCleanup(l.close)
        return l

    def daemon(self, **kw):
        d = FakeDaemon(self.home, **kw)
        self.addCleanup(d.close)
        return d

    def test_hello_lists_link(self):
        d = self.daemon()
        self.link()
        self.assertIn("link", d.hellos[0]["caps"])
        frames.check_adapter_frame(d.hellos[0])

    def test_proof_is_sent_on_open_as_a_hash_and_is_a_fresh_random_value(self):
        d = self.daemon()
        l = self.link()
        self.assertEqual(len(d.proofs), 1)
        frame = d.proofs[0][1]
        frames.check_adapter_frame(frame)
        self.assertEqual(set(frame), {"v", "id", "type", "hash"})  # no pid, no agent
        self.assertRegex(l.proof, r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(frame["hash"], sha(l.proof))
        self.assertNotIn(l.proof, json.dumps(frame))
        raw = base64.urlsafe_b64decode(l.proof + "=")
        self.assertEqual(len(raw), 32)

    def test_a_reconnect_makes_a_new_proof(self):
        d = self.daemon()
        a = self.link()
        a.close()
        b = self.link()
        self.assertEqual(len(d.proofs), 2)
        self.assertNotEqual(a.proof, b.proof)
        self.assertEqual(d.proofs[1][1]["hash"], sha(b.proof))

    def test_a_daemon_that_did_not_list_link_gets_no_frame(self):
        d = self.daemon(caps=())
        l = self.link()
        self.assertEqual(d.proofs, [])
        self.assertIsNone(l.proof)

    def test_a_daemon_that_says_not_bound_or_errors_leaves_the_link_unlinked_but_working(self):
        for answer in ("unbound", "error"):
            with self.subTest(answer):
                home = tempfile.mkdtemp(prefix="oap-")
                self.addCleanup(shutil.rmtree, home, True)
                d = FakeDaemon(home, answer=answer)
                self.addCleanup(d.close)
                l = Link("r", "/tmp", "x", None, os.getpid(), lambda *a: None, lambda *a: None,
                         lambda *a: None, home=home).open()
                self.addCleanup(l.close)
                self.assertIsNone(l.proof)
                self.assertFalse(l.closed)

    def test_a_daemon_that_never_answers_does_not_hold_the_link(self):
        old = link_mod.PROOF_TIMEOUT_S
        link_mod.PROOF_TIMEOUT_S = 0.05
        self.addCleanup(setattr, link_mod, "PROOF_TIMEOUT_S", old)
        d = self.daemon(answer="silent")
        l = self.link()
        self.assertTrue(d.proofed.is_set())
        self.assertIsNone(l.proof)
        self.assertFalse(l.closed)


class RetryOnLaterTurns(OverASocket):
    """A hub that was down when the link opened: the daemon said not bound. A later turn tries
    again with the same proof, at most once a minute per link."""

    def clock(self):
        t = [1000.0]
        old = link_mod._monotonic
        link_mod._monotonic = lambda: t[0]
        self.addCleanup(setattr, link_mod, "_monotonic", old)
        return t

    def test_retries_with_the_same_proof_once_a_minute_until_it_is_taken(self):
        t = self.clock()
        d = self.daemon(answer="unbound")
        l = self.link()
        self.assertIsNone(l.proof)
        first = d.proofs[0][1]["hash"]
        l.retry_proof()
        t[0] += 59
        l.retry_proof()
        self.assertEqual(len(d.proofs), 1)  # rate limited
        t[0] += 2
        d.answer = "unbound"
        l.retry_proof()
        self.assertEqual(len(d.proofs), 2)
        self.assertEqual(d.proofs[1][1]["hash"], first)
        self.assertIsNone(l.proof)
        t[0] += 61
        d.answer = "bound"
        l.retry_proof()
        self.assertEqual(len(d.proofs), 3)
        self.assertEqual(d.proofs[2][1]["hash"], first)
        self.assertEqual(sha(l.proof), first)
        # Taken: no more frames.
        t[0] += 1000
        l.retry_proof()
        self.assertEqual(len(d.proofs), 3)

    def test_no_retry_for_a_daemon_that_did_not_list_link(self):
        t = self.clock()
        d = self.daemon(caps=())
        l = self.link()
        t[0] += 1000
        l.retry_proof()
        self.assertEqual(d.proofs, [])
        self.assertIsNone(l.proof)

    def test_a_new_link_makes_a_new_proof_not_the_old_ones(self):
        self.clock()
        d = self.daemon(answer="unbound")
        a = self.link()
        a.close()
        b = self.link()
        self.assertNotEqual(d.proofs[0][1]["hash"], d.proofs[1][1]["hash"])

    def test_a_turn_asks_the_link_to_retry(self):
        roots = Roots(lambda s: s)
        bus = Bus(roots, spawn=support.inline_spawn, start="t", habits_marker=support.habits_marker(),
                  codex_runtime=lambda: False)
        link = support.FakeLink(ref="root-1")
        bus.state("root-1").link = link
        bus.turn_start("root-1", "cli")
        bus.turn_start("root-1", "cli")
        self.assertEqual(link.retries, 2)  # the link rate limits; the bus asks every turn


class FakeProofBus:
    """What the middleware asks of the Bus: the root's proof, or none."""

    def __init__(self, proof="p" * 43, raises=False):
        self.proof = proof
        self.raises = raises
        self.asked = []

    def proof_for(self, session_id):
        self.asked.append(session_id)
        if self.raises:
            raise RuntimeError("boom")
        return self.proof


class FakeHandlers:
    """tools.mcp_tool_handlers: the one function that puts arguments on the wire."""

    def __init__(self):
        self.wire = []

    async def _call_tool_racing_stdio_death(self, server, server_name, tool_name, args, progress_callback=None):
        self.wire.append((server_name, tool_name, args))
        return "result"


class FakeRegistry:
    """tools.registry.registry: dispatch hands the handler the same args object, as Hermes does.

    `served` maps a registry name to the raw (server, tool) the MCP handler would call."""

    def __init__(self, handlers, served):
        self.handlers = handlers
        self.served = served
        self.above = []  # what every layer above the wire saw
        self.kwargs = []

    def dispatch(self, name, args, **kwargs):
        self.kwargs.append(kwargs)
        self.above.append(json.dumps(args))
        if name not in self.served:
            return "not mcp"
        server_name, tool_name = self.served[name]
        return asyncio.run(self.handlers._call_tool_racing_stdio_death(None, server_name, tool_name, args))


SERVED = {
    "mcp__open_artifacts__get_artifact": ("open-artifacts", "get_artifact"),
    # Sanitizing is lossy: all of these make the real server's prefix.
    "mcp__open_artifacts__a": ("open_artifacts", "a"),
    "mcp__open_artifacts__b": ("open artifacts", "b"),
    "mcp__open_artifacts__c": ("Open-Artifacts", "c"),
    "mcp__open_artifacts__d": ("open-artifacts ", "d"),
    "mcp__open_artifacts_2__get_artifact": ("open-artifacts-2", "get_artifact"),
    "mcp__other__get_artifact": ("other", "get_artifact"),
}


def installed(bus=None, names=("open-artifacts",)):
    handlers = FakeHandlers()
    registry = FakeRegistry(handlers, SERVED)
    original = registry.dispatch
    bus = bus or FakeProofBus()
    ok = proof_mod.install(bus, names, registry=registry, handlers=handlers)
    return ok, registry, handlers, bus, original


class WireInjection(unittest.TestCase):
    """The argument is added at the last layer, below hooks, guardrails and approval prompts."""

    def test_the_instances_tool_gets_it_on_the_wire_and_nothing_above_sees_it(self):
        ok, registry, handlers, bus, _ = installed()
        args = {"id": "x"}
        out = registry.dispatch("mcp__open_artifacts__get_artifact", args, session_id="root-1", task_id="t")
        self.assertTrue(ok)
        self.assertEqual(out, "result")
        self.assertEqual(handlers.wire[0][2], {"id": "x", ARG: "p" * 43})
        self.assertEqual(handlers.wire[0][:2], ("open-artifacts", "get_artifact"))
        for seen in registry.above:
            self.assertNotIn(ARG, seen)
            self.assertNotIn("p" * 43, seen)
        self.assertEqual(args, {"id": "x"})
        self.assertEqual(bus.asked, ["root-1"])
        self.assertEqual(registry.kwargs[0], {"session_id": "root-1", "task_id": "t"})

    def test_the_models_own_value_for_the_argument_is_replaced_on_the_wire(self):
        _, registry, handlers, *_ = installed()
        registry.dispatch("mcp__open_artifacts__get_artifact", {ARG: "forged"}, session_id="root-1")
        self.assertEqual(handlers.wire[0][2], {ARG: "p" * 43})

    def test_never_a_look_alike_or_another_server(self):
        _, registry, handlers, *_ = installed()
        for name in SERVED:
            if SERVED[name][0] == "open-artifacts":
                continue
            with self.subTest(name):
                registry.dispatch(name, {"a": 1}, session_id="root-1")
                self.assertEqual(handlers.wire[-1][2], {"a": 1})

    def test_the_instances_own_server_name_only_when_given(self):
        _, registry, handlers, *_ = installed(names=("open-artifacts", "other"))
        registry.dispatch("mcp__other__get_artifact", {}, session_id="root-1")
        self.assertEqual(handlers.wire[-1][2], {ARG: "p" * 43})
        registry.dispatch("mcp__open_artifacts_2__get_artifact", {}, session_id="root-1")
        self.assertEqual(handlers.wire[-1][2], {})

    def test_a_tool_that_is_not_mcp_goes_through_untouched(self):
        _, registry, _, bus, _ = installed()
        args = {"a": 1}
        self.assertEqual(registry.dispatch("terminal", args, session_id="root-1"), "not mcp")
        self.assertEqual(bus.asked, [])

    def test_no_proof_means_the_call_goes_as_it_was(self):
        _, registry, handlers, *_ = installed(bus=FakeProofBus(proof=None))
        self.assertEqual(registry.dispatch("mcp__open_artifacts__get_artifact", {"a": 1}, session_id="r"), "result")
        self.assertEqual(handlers.wire[0][2], {"a": 1})

    def test_a_failure_finding_the_proof_still_runs_the_tool_once(self):
        _, registry, handlers, *_ = installed(bus=FakeProofBus(raises=True))
        self.assertEqual(registry.dispatch("mcp__open_artifacts__get_artifact", {"a": 1}, session_id="r"), "result")
        self.assertEqual(len(handlers.wire), 1)
        self.assertEqual(handlers.wire[0][2], {"a": 1})

    def test_a_call_that_did_not_come_through_dispatch_goes_as_it_was(self):
        _, _, handlers, *_ = installed()
        asyncio.run(handlers._call_tool_racing_stdio_death(None, "open-artifacts", "t", {"a": 1}))
        self.assertEqual(handlers.wire[0][2], {"a": 1})

    def test_the_wrapper_takes_whatever_signature_hermes_gives_it(self):
        _, _, handlers, *_ = installed()
        asyncio.run(handlers._call_tool_racing_stdio_death(None, "open-artifacts", "t", args={"a": 1}, progress_callback=None))
        self.assertEqual(handlers.wire[0][2], {"a": 1})

    def test_a_tool_error_is_not_swallowed_and_leaves_nothing_behind(self):
        _, registry, handlers, *_ = installed()

        async def boom(*a, **k):
            raise ValueError("the tool failed")

        handlers._call_tool_racing_stdio_death = boom
        # install wrapped the old function; wrap again over the failing one
        proof_mod.install(FakeProofBus(), ("open-artifacts",), registry=registry, handlers=handlers)
        with self.assertRaises(ValueError):
            registry.dispatch("mcp__open_artifacts__get_artifact", {}, session_id="root-1")
        self.assertEqual(proof_mod._CALLS, {})

    def test_two_sessions_at_once_each_send_their_own_proof(self):
        class Bus:
            def proof_for(self, sid):
                return {"A": "a" * 43, "B": "b" * 43}[sid]

        _, registry, handlers, *_ = installed(bus=Bus())
        barrier = threading.Barrier(2)
        orig = handlers._call_tool_racing_stdio_death

        async def meet(*a, **k):
            barrier.wait(5)
            return await orig(*a, **k)

        handlers._call_tool_racing_stdio_death = meet
        proof_mod.install(Bus(), ("open-artifacts",), registry=registry, handlers=handlers)
        same = {"id": "x"}
        ts = [threading.Thread(target=registry.dispatch, args=("mcp__open_artifacts__get_artifact", same),
                               kwargs={"session_id": sid}) for sid in ("A", "B")]
        [t.start() for t in ts]
        [t.join(10) for t in ts]
        self.assertEqual(sorted(w[2][ARG] for w in handlers.wire), ["a" * 43, "b" * 43])

    def test_installing_again_for_the_same_bus_does_not_stack(self):
        ok, registry, handlers, bus, _ = installed()
        self.assertTrue(proof_mod.install(bus, ("open-artifacts",), registry=registry, handlers=handlers))
        registry.dispatch("mcp__open_artifacts__get_artifact", {}, session_id="root-1")
        self.assertEqual(handlers.wire[0][2], {ARG: "p" * 43})
        self.assertEqual(len(registry.above), 1)
        self.assertEqual(bus.asked, ["root-1"])

    def test_a_second_bus_in_one_process_leaves_the_first_in_charge(self):
        # Another Hermes profile loaded in the same process: its install is a no-op against
        # the first's wrappers. The first keeps its proofs; the second stays unlinked.
        ok, registry, handlers, first, _ = installed()
        second = FakeProofBus(proof="n" * 43)
        self.assertFalse(proof_mod.install(second, ("open-artifacts",), registry=registry, handlers=handlers))
        registry.dispatch("mcp__open_artifacts__get_artifact", {}, session_id="root-1")
        self.assertEqual(handlers.wire[0][2], {ARG: "p" * 43})
        self.assertEqual(first.asked, ["root-1"])
        self.assertEqual(second.asked, [])

    def test_a_hermes_without_the_functions_stays_unlinked_and_untouched(self):
        registry = FakeRegistry(FakeHandlers(), SERVED)
        before = registry.dispatch.__func__
        self.assertFalse(proof_mod.install(FakeProofBus(), ("open-artifacts",), registry=registry, handlers=object()))
        self.assertIs(registry.dispatch.__func__, before)
        self.assertFalse(proof_mod.install(FakeProofBus(), ("open-artifacts",), registry=object(), handlers=FakeHandlers()))

    def test_no_schema_the_model_sees_carries_the_argument(self):
        ctx = support.FakeCtx()
        register(ctx, roots=Roots(lambda s: s), bus=Bus(Roots(lambda s: s), habits_marker=support.habits_marker()))
        for t in ctx.tools.values():
            self.assertNotIn(ARG, json.dumps(t["schema"]))
        self.assertEqual(ctx.middleware, {})  # nothing on the middleware layer, which hooks and guards see


class Plugin(unittest.TestCase):
    def test_the_first_turn_installs_the_wire_hook_once(self):
        calls = []
        ctx = support.FakeCtx()
        roots = Roots(lambda s: s)
        bus = Bus(roots, spawn=support.inline_spawn, start="t", habits_marker=support.habits_marker())
        bus.touch = lambda ref: None
        register(ctx, roots=roots, bus=bus, proof_servers=("open-artifacts",),
                 install=lambda b, names: calls.append((b, names)) or True)
        self.assertEqual(calls, [])  # registering touches nothing of Hermes's
        ctx.hooks["pre_llm_call"][0](session_id="s", platform="cli")
        ctx.hooks["pre_llm_call"][0](session_id="s", platform="cli")
        self.assertEqual(calls, [(bus, ("open-artifacts",))])

    def test_an_install_that_raises_never_breaks_the_turn(self):
        ctx = support.FakeCtx()
        roots = Roots(lambda s: s)
        bus = Bus(roots, spawn=support.inline_spawn, start="t", habits_marker=support.habits_marker())
        bus.touch = lambda ref: None

        def boom(b, n):
            raise RuntimeError("no")

        register(ctx, roots=roots, bus=bus, install=boom)
        ctx.hooks["pre_llm_call"][0](session_id="s", platform="cli")


class ProofForABus(unittest.TestCase):
    """Bus.proof_for: the proof of a main session's open link, and nothing else."""

    def setUp(self):
        self.roots = Roots({"root-1": "root-1", "kid": "kid-root", "rot": "root-1"}.get)
        self.roots.note_subagent("root-1", "kid")
        self.bus = Bus(self.roots, spawn=support.inline_spawn, start="t",
                       habits_marker=support.habits_marker(), codex_runtime=lambda: False)
        self.link = support.FakeLink(ref="root-1")
        self.link.proof = "q" * 43
        self.bus.state("root-1").link = self.link

    def test_the_open_links_proof(self):
        self.assertEqual(self.bus.proof_for("root-1"), "q" * 43)
        self.assertEqual(self.bus.proof_for("rot"), "q" * 43)  # a rotated session of the same root

    def test_none_for_a_subagent_an_unknown_session_or_no_session(self):
        for sid in ("kid", "nobody", "", None):
            with self.subTest(sid):
                self.assertIsNone(self.bus.proof_for(sid))

    def test_none_when_the_link_is_closed_and_nothing_is_opened(self):
        # The dispatch path is a read: it never opens a link, so a session whose root has no
        # open link (another profile's, a finalized one, a closed one) gets no proof.
        self.link.closed = True
        opened = []
        self.bus.ensure = lambda ref: opened.append(ref) or self.link
        self.bus.touch = lambda ref: opened.append(ref)
        self.assertIsNone(self.bus.proof_for("root-1"))
        self.assertEqual(opened, [])

    def test_a_root_this_bus_never_held_gets_no_proof_and_no_state(self):
        roots = Roots({"other": "other-root"}.get)
        bus = Bus(roots, spawn=support.inline_spawn, start="t", habits_marker=support.habits_marker(),
                  codex_runtime=lambda: False)
        self.assertIsNone(bus.proof_for("other"))
        self.assertEqual(bus._by_root, {})

    def test_none_under_the_codex_runtime_or_when_that_cannot_be_told(self):
        for state in (True, None):
            with self.subTest(state):
                self.bus._codex_runtime = lambda s=state: s
                self.assertIsNone(self.bus.proof_for("root-1"))

    def test_a_finalized_session_is_not_reopened(self):
        self.bus.close("root-1")
        opened = []
        self.bus.ensure = lambda ref: opened.append(ref) or self.link
        self.assertIsNone(self.bus.proof_for("root-1"))
        self.assertEqual(opened, [])

    def test_none_when_the_link_has_no_proof(self):
        self.link.proof = None
        self.assertIsNone(self.bus.proof_for("root-1"))


if __name__ == "__main__":
    unittest.main()
