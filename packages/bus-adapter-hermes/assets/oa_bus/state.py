"""The gateway roots this plugin has linked, kept across a gateway restart.

A messaging chat's session survives a restart with the same session id and key, but its first
turn is the only thing that opens a link. So each root's (session id, key, platform, last turn)
is kept in a small owner-only file next to the plugin, and the roots active in the last 7 days
are linked again when the plugin loads in a gateway process.
"""

import json
import os
import tempfile
import threading
import time

STORE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gateway_roots.json")
MAX_ROOTS = 20
MAX_AGE_S = 7 * 24 * 3600


class RootStore:
    def __init__(self, path=None, clock=time.time):
        self.path = path or STORE_FILE
        self._clock = clock
        self._lock = threading.Lock()

    def _read(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {
            k: v for k, v in data.items()
            if isinstance(k, str) and isinstance(v, dict)
            and all(isinstance(v.get(f), str) and v[f] for f in ("session_id", "key", "platform"))
            and isinstance(v.get("last_turn"), (int, float))
        }

    def _write(self, data):
        d = os.path.dirname(self.path)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".roots-")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def upsert(self, root, session_id, key, platform):
        """Never raises: a store that cannot be written only costs the restart restore."""
        try:
            with self._lock:
                data = self._read()
                data[root] = {"session_id": session_id, "key": key, "platform": platform,
                              "last_turn": self._clock()}
                if len(data) > MAX_ROOTS:
                    for old in sorted(data, key=lambda r: data[r]["last_turn"])[: len(data) - MAX_ROOTS]:
                        del data[old]
                self._write(data)
        except Exception:
            pass

    def drop(self, root):
        try:
            with self._lock:
                data = self._read()
                if data.pop(root, None) is not None:
                    self._write(data)
        except Exception:
            pass

    def recent(self):
        """[(root, entry)] active in the last 7 days, newest first, at most MAX_ROOTS."""
        with self._lock:
            data = self._read()
        now = self._clock()
        live = [(r, e) for r, e in data.items() if 0 <= now - e["last_turn"] <= MAX_AGE_S]
        live.sort(key=lambda p: -p[1]["last_turn"])
        return live[:MAX_ROOTS]
