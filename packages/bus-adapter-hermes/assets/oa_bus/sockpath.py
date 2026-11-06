"""Where the bus daemon listens, and this process's start time.

Port of the socket-path block in the Pi extension (a test holds the two to the
same answers). The Pi extension's `procStart` is `ps -o lstart=` in UTC.
"""

import hashlib
import os
import stat
import subprocess
import sys

# sun_path holds 104 bytes on macOS and 108 on Linux, NUL included.
MAX_SOCKET_PATH = 107 if sys.platform.startswith("linux") else 103


def canonical_home(p):
    """The deepest existing ancestor through realpath, the rest appended as is."""
    rest = []
    cur = p
    while True:
        try:
            real = os.path.realpath(cur, strict=True)
            return os.path.join(real, *rest) if rest else real
        except OSError:
            parent = os.path.dirname(cur)
            if parent == cur:
                return p
            rest.insert(0, os.path.basename(cur))
            cur = parent


def unsafe_socket_dir(d):
    """Why a socket folder must not be used, or None when it is safe."""
    try:
        st = os.lstat(d)
    except OSError:
        return None
    if st.st_uid != os.getuid():
        return "belongs to another user"
    if stat.S_ISLNK(st.st_mode):
        return "is a symlink"
    if not stat.S_ISDIR(st.st_mode):
        return "is not a folder"
    mode = stat.S_IMODE(st.st_mode)
    if mode != 0o700:
        return f"is open to other users (mode {mode:o})"
    return None


def socket_base(platform=None, run_dir=None):
    plat = sys.platform if platform is None else platform
    if not plat.startswith("linux"):
        return "/tmp"
    run = run_dir if run_dir is not None else f"/run/user/{os.getuid()}"
    try:
        if stat.S_ISDIR(os.lstat(run).st_mode) and not unsafe_socket_dir(run):
            return run
    except OSError:
        pass
    return "/tmp"


def short_socket_dir(home):
    digest = hashlib.sha256(canonical_home(home).encode("utf-8")).hexdigest()
    return os.path.join(socket_base(), f"oa-bus-{os.getuid()}-{digest[:8]}")


def _fits(p):
    return len(p.encode("utf-8")) <= MAX_SOCKET_PATH


def daemon_socket_path(home):
    plain = os.path.join(canonical_home(home), "daemon.sock")
    return plain if _fits(plain) else os.path.join(short_socket_dir(home), "daemon.sock")


def socket_dir_problem(home):
    """Why the daemon socket for `home` must not be dialed, or None."""
    d = short_socket_dir(home)
    if os.path.dirname(daemon_socket_path(home)) != d:
        return None
    why = unsafe_socket_dir(d)
    return f"{d} {why}" if why else None


def bus_home():
    env = os.environ.get("OA_BUS_HOME")
    return os.path.abspath(env or os.path.join(os.path.expanduser("~"), ".oa-bus"))


def proc_start(pid=None):
    """`TZ=UTC LC_ALL=C ps -o lstart=` for this process: the form the daemon re-reads to attest it."""
    env = {**os.environ, "TZ": "UTC", "LC_ALL": "C"}
    try:
        out = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(os.getpid() if pid is None else pid)],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
            check=False,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out or None
