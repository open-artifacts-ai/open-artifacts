import unittest

import support
from oa_bus import frames


class GoldenFrames(unittest.TestCase):
    def test_every_valid_daemon_frame_parses(self):
        for s in support.fixture("daemon-frames.json")["valid"]:
            with self.subTest(s["name"]):
                self.assertEqual(frames.parse_daemon_frame(s["frame"]), s["frame"])

    def test_every_invalid_daemon_frame_is_refused(self):
        for s in support.fixture("daemon-frames.json")["invalid"]:
            with self.subTest(s["name"]):
                with self.assertRaises(frames.FrameError):
                    frames.parse_daemon_frame(s["frame"])

    def test_every_valid_adapter_frame_is_accepted(self):
        for s in support.fixture("adapter-frames.json")["valid"]:
            with self.subTest(s["name"]):
                frames.check_adapter_frame(s["frame"])

    def test_every_invalid_adapter_frame_is_refused(self):
        for s in support.fixture("adapter-frames.json")["invalid"]:
            with self.subTest(s["name"]):
                with self.assertRaises(frames.FrameError):
                    frames.check_adapter_frame(s["frame"])


class Codec(unittest.TestCase):
    def test_encode_is_one_json_line_with_v_first(self):
        line = frames.encode({"type": "list", "id": "7"})
        self.assertEqual(line, b'{"v":1,"type":"list","id":"7"}\n')

    def test_encode_keeps_unicode_as_utf8(self):
        line = frames.encode({"type": "send", "id": "1", "to": "bob", "body": "héllo ✓"})
        self.assertIn("héllo ✓".encode("utf-8"), line)

    def test_encode_refuses_a_frame_the_daemon_would_refuse(self):
        with self.assertRaises(frames.FrameError):
            frames.encode({"type": "send", "id": "1", "to": "bob", "body": ""})

    def test_decode_round_trips_a_fixture(self):
        import json

        for s in support.fixture("daemon-frames.json")["valid"]:
            self.assertEqual(frames.decode(json.dumps(s["frame"]).encode()), s["frame"])

    def test_decode_refuses_garbage(self):
        for line in (b"not json", b"[]", b'{"v":1}', b"\xff\xfe"):
            with self.subTest(line):
                with self.assertRaises(frames.FrameError):
                    frames.decode(line)


if __name__ == "__main__":
    unittest.main()
