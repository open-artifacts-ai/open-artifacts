"""#1856 (part of #1822): per-session proof for Hermes.

Each root makes a random proof when its link opens or reconnects and tells the
daemon its hash on that link. Our tool_execution middleware adds the proof, as
the reserved argument `_oa_agent_proof`, to calls to this instance's
open-artifacts MCP tools only. Any failure leaves the root unlinked with every
tool working. Waits are signals (events), never sleeps.
"""

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
from oa_bus.proof import ARG, instance_tool
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


def middleware(servers, bus=None, names=("open-artifacts",)):
    """register() against a ctx that has register_middleware; returns (ctx, bus, callback)."""
    ctx = support.FakeCtx()
    roots = Roots(lambda sid: sid)
    real = Bus(roots, inject=ctx.inject_message, spawn=support.inline_spawn, start="t",
               habits_marker=support.habits_marker())
    bus = bus or FakeProofBus()
    real.proof_for = bus.proof_for
    register(ctx, roots=roots, bus=real, mcp_servers=servers_lookup(servers), proof_servers=names)
    return ctx, bus, ctx.middleware["tool_execution"][0]


def servers_lookup(table):
    return table.get


def run(cb, tool_name, args, session_id="root-1", **kw):
    """The callback as Hermes calls it; returns (what next_call got, result)."""
    seen = []

    def next_call(payload=None):
        seen.append(payload)
        return "result"

    out = cb(tool_name=tool_name, args=args, original_args=args, session_id=session_id,
             task_id="", tool_call_id="c", turn_id="", api_request_id="", next_call=next_call,
             middleware_schema_version="hermes.middleware.v1", telemetry_schema_version="x", **kw)
    return seen, out


TABLE = {
    "mcp__open_artifacts__publish_artifact": "open-artifacts",
    "mcp__open_artifacts__get_artifact": "open-artifacts",
    "mcp__open_artifacts__list_resources": "open-artifacts",
    "mcp__open_artifacts__subscribe_event": "open-artifacts",
    # Sanitizing is lossy: these produce the same prefix as the real server's.
    "mcp__open_artifacts__lookalike_underscore": "open_artifacts",
    "mcp__open_artifacts__lookalike_space": "open artifacts",
    "mcp__open_artifacts__lookalike_caps": "Open-Artifacts",
    "mcp__open_artifacts_2__get_artifact": "open-artifacts-2",
    "mcp__other__get_artifact": "other",
    "mcp__oa_staging__get_artifact": "oa-staging",
}


class Middleware(unittest.TestCase):
    def test_registers_a_tool_execution_middleware_only(self):
        ctx, *_ = middleware(TABLE)
        self.assertEqual(sorted(ctx.middleware), ["tool_execution"])
        self.assertEqual(len(ctx.middleware["tool_execution"]), 1)

    def test_adds_the_argument_to_this_instances_open_artifacts_tools(self):
        _, bus, cb = middleware(TABLE)
        args = {"id": "x"}
        seen, out = run(cb, "mcp__open_artifacts__get_artifact", args)
        self.assertEqual(out, "result")
        self.assertEqual(seen, [{"id": "x", ARG: "p" * 43}])
        self.assertEqual(bus.asked, ["root-1"])
        self.assertEqual(args, {"id": "x"})  # the model's own dict is not edited

    def test_the_models_own_value_for_the_argument_is_replaced(self):
        _, _, cb = middleware(TABLE)
        seen, _ = run(cb, "mcp__open_artifacts__get_artifact", {ARG: "forged"})
        self.assertEqual(seen, [{ARG: "p" * 43}])

    def test_never_a_look_alike_server_or_another_server(self):
        _, bus, cb = middleware(TABLE)
        for name in TABLE:
            if TABLE[name] == "open-artifacts":
                continue
            with self.subTest(name):
                args = {"a": 1}
                seen, out = run(cb, name, args)
                self.assertEqual(seen, [{"a": 1}])
                self.assertEqual(out, "result")
        self.assertEqual(bus.asked, [])

    def test_an_unknown_tool_name_or_no_provenance_is_untouched(self):
        _, bus, cb = middleware(TABLE)
        for name in ("terminal", "mcp__open_artifacts__never_registered", "oabus_send_message", "", None):
            with self.subTest(name):
                seen, _ = run(cb, name, {"a": 1})
                self.assertEqual(seen, [{"a": 1}])
        self.assertEqual(bus.asked, [])

    def test_hermes_own_utility_tools_of_the_server_are_untouched(self):
        _, _, cb = middleware(TABLE)
        for name in ("mcp__open_artifacts__list_resources", "mcp__open_artifacts__subscribe_event"):
            seen, _ = run(cb, name, {"a": 1})
            self.assertEqual(seen, [{"a": 1}])

    def test_the_instances_own_server_name_when_it_is_given(self):
        _, _, cb = middleware(TABLE, names=("open-artifacts", "oa-staging"))
        seen, _ = run(cb, "mcp__oa_staging__get_artifact", {})
        self.assertEqual(seen, [{ARG: "p" * 43}])
        seen, _ = run(cb, "mcp__other__get_artifact", {})
        self.assertEqual(seen, [{}])

    def test_no_proof_means_the_call_goes_as_it_was(self):
        _, _, cb = middleware(TABLE, bus=FakeProofBus(proof=None))
        seen, out = run(cb, "mcp__open_artifacts__get_artifact", {"a": 1})
        self.assertEqual((seen, out), ([{"a": 1}], "result"))

    def test_a_failure_finding_the_proof_still_runs_the_tool_once(self):
        _, _, cb = middleware(TABLE, bus=FakeProofBus(raises=True))
        seen, out = run(cb, "mcp__open_artifacts__get_artifact", {"a": 1})
        self.assertEqual((seen, out), ([{"a": 1}], "result"))

    def test_a_tool_error_is_not_swallowed(self):
        _, _, cb = middleware(TABLE)

        def next_call(payload=None):
            raise ValueError("the tool failed")

        with self.assertRaises(ValueError):
            cb(tool_name="mcp__open_artifacts__get_artifact", args={}, session_id="root-1",
               next_call=next_call)

    def test_no_schema_the_model_sees_carries_the_argument(self):
        ctx, *_ = middleware(TABLE)
        for t in ctx.tools.values():
            self.assertNotIn(ARG, json.dumps(t["schema"]))

    def test_an_older_hermes_without_register_middleware_registers_the_rest(self):
        ctx = support.FakeCtx()
        ctx.register_middleware = None  # Hermes before middleware existed has no such method
        register(ctx, roots=Roots(lambda s: s), bus=Bus(Roots(lambda s: s), habits_marker=support.habits_marker()))
        self.assertTrue(ctx.tools)
        self.assertFalse(getattr(ctx, "middleware", {}))


class InstanceTool(unittest.TestCase):
    def test_provenance_is_the_exact_raw_server_name(self):
        for raw, ok in (("open-artifacts", True), ("open_artifacts", False), ("open artifacts", False),
                        ("Open-Artifacts", False), ("open-artifacts ", False), ("open-artifacts-2", False)):
            with self.subTest(raw):
                self.assertEqual(
                    instance_tool("mcp__open_artifacts__x", {"mcp__open_artifacts__x": raw}.get,
                                  ("open-artifacts",)), ok)


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

    def test_none_when_the_link_is_closed_and_it_is_reopened_in_the_background(self):
        self.link.closed = True
        opened = []
        self.bus.ensure = lambda ref: opened.append(ref) or self.link
        self.assertIsNone(self.bus.proof_for("root-1"))
        self.assertEqual(opened, ["root-1"])

    def test_none_under_the_codex_runtime_or_when_that_cannot_be_told(self):
        for state in (True, None):
            with self.subTest(state):
                self.bus._codex_runtime = lambda s=state: s
                self.assertIsNone(self.bus.proof_for("root-1"))

    def test_none_when_the_link_has_no_proof(self):
        self.link.proof = None
        self.assertIsNone(self.bus.proof_for("root-1"))


if __name__ == "__main__":
    unittest.main()
