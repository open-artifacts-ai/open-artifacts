"""The plugin against a fake daemon on a real unix socket."""

import collections
import json
import os
import shutil
import socket
import tempfile
import threading
import unittest

import support
from oa_bus import frames
from oa_bus.bus import Bus
from oa_bus.link import Link, LinkError
from oa_bus.roots import Roots
from oa_bus.sockpath import daemon_socket_path


class FakeDaemon:
    def __init__(self, home, refuse=False):
        self.refuse = refuse
        self.hellos = []
        self.conns = {}
        self.got = {}
        self.acked = collections.defaultdict(threading.Event)
        self.ready = threading.Event()
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
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        buf = b""
        ref = None
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
                    ref = f["agent_ref"]
                    if self.refuse:
                        self.write(conn, {"id": "hello", "type": "error", "code": "bad_frame", "message": "no"})
                        conn.close()
                        return
                    self.conns[ref] = conn
                    self.write(conn, {"id": "hello", "type": "welcome", "agent_ref": ref,
                                      "bus_name": f"name-{ref}", "namespace": "ns", "global": False})
                    self.ready.set()
                elif f["type"] == "ack":
                    self.acked[ref].set()
                    self.got.setdefault(ref, []).append(f["msg_id"])
                elif f["type"] == "self":
                    self.write(conn, {"id": f["id"], "type": "agent", "agent": None})
                elif f["type"] == "list":
                    self.write(conn, {"id": f["id"], "type": "roster", "agents": []})

    @staticmethod
    def write(conn, f):
        conn.sendall((json.dumps({"v": 1, **f}) + "\n").encode())

    def push(self, ref, f):
        self.write(self.conns[ref], f)

    def drop(self, ref):
        # shutdown, not close: another thread is blocked reading this socket.
        self.conns[ref].shutdown(socket.SHUT_RDWR)

    def close(self):
        self.server.close()


class OverASocket(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="oab-")
        self.addCleanup(shutil.rmtree, self.home, True)
        self.old = os.environ.get("OA_BUS_HOME")
        os.environ["OA_BUS_HOME"] = self.home
        self.addCleanup(self._restore)

    def _restore(self):
        if self.old is None:
            os.environ.pop("OA_BUS_HOME", None)
        else:
            os.environ["OA_BUS_HOME"] = self.old

    def link(self, ref, on_deliver=lambda *a: None):
        return Link(ref, "/tmp", "hermes-x", "Fri Nov  6 21:00:00 2026", os.getpid(),
                    on_deliver, lambda *a: None, lambda *a: None, home=self.home).open()

    def test_hello_says_hermes_with_the_start_time_and_the_root(self):
        d = FakeDaemon(self.home)
        self.addCleanup(d.close)
        link = self.link("root-1")
        self.addCleanup(link.close)
        h = d.hellos[0]
        self.assertEqual((h["kind"], h["agent_ref"], h["pid"]), ("hermes", "root-1", os.getpid()))
        self.assertEqual(h["attest"], {"proc_start": "Fri Nov  6 21:00:00 2026"})
        frames.check_adapter_frame(h)
        self.assertEqual(link.welcome["bus_name"], "name-root-1")

    def test_two_roots_from_one_process_each_get_their_own_deliveries(self):
        d = FakeDaemon(self.home)
        self.addCleanup(d.close)
        roots = Roots(lambda sid: sid)
        bus = Bus(roots, start="Fri Nov  6 21:00:00 2026")
        a, b = bus.ensure("root-1"), bus.ensure("root-2")
        self.addCleanup(bus.close_all)
        self.assertIsNot(a, b)
        self.assertEqual({h["agent_ref"] for h in d.hellos}, {"root-1", "root-2"})
        self.assertEqual({h["pid"] for h in d.hellos}, {os.getpid()})
        d.push("root-1", support.deliver_frame("mmmmmmmmmmmmmmm1", body="one"))
        d.push("root-2", support.deliver_frame("mmmmmmmmmmmmmmm2", body="two"))
        self.assertTrue(d.acked["root-1"].wait(5))
        self.assertTrue(d.acked["root-2"].wait(5))
        self.assertEqual(d.got, {"root-1": ["mmmmmmmmmmmmmmm1"], "root-2": ["mmmmmmmmmmmmmmm2"]})
        self.assertIn("one", bus.turn_start("root-1", "telegram")["context"])
        self.assertIn("two", bus.turn_start("root-2", "telegram")["context"])

    def test_requests_are_answered_by_id(self):
        d = FakeDaemon(self.home)
        self.addCleanup(d.close)
        link = self.link("root-1")
        self.addCleanup(link.close)
        self.assertEqual(link.request({"type": "list"})["agents"], [])

    def test_a_refused_hello_says_so(self):
        d = FakeDaemon(self.home, refuse=True)
        self.addCleanup(d.close)
        with self.assertRaises(LinkError) as cm:
            self.link("root-1")
        self.assertTrue(cm.exception.refused)

    def test_a_daemon_that_is_down_is_an_error_not_a_hang(self):
        with self.assertRaises(LinkError):
            self.link("root-1")

    def test_a_link_that_drops_is_reported_lost(self):
        d = FakeDaemon(self.home)
        self.addCleanup(d.close)
        lost = threading.Event()
        link = Link("root-1", "/tmp", "x", None, os.getpid(), lambda *a: None, lambda *a: None,
                    lambda l: lost.set(), home=self.home).open()
        d.drop("root-1")
        self.assertTrue(lost.wait(5))
        self.assertTrue(link.closed)
        with self.assertRaises(LinkError):
            link.request({"type": "list"})


if __name__ == "__main__":
    unittest.main()
