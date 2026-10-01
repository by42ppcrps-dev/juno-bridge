"""User-scoped operator process for Juno Bridge.

The CLI talks to this process over a private Unix socket. The process owns
the relay HTTP client, a separate TypeSafe client, and the admin passphrase.
The passphrase and the TypeSafe key are not sent on the socket. Certificate
verification stays on, and redirects are not followed, so a bearer token is
not sent to another host. One client disconnecting does not stop the process.
Ping and stop are answered while a relay or TypeSafe request is still running.
Those requests stay on one worker so a libcurl handle is not shared across
threads.

Set JUNO_OPERATOR=0 or JUNO_BRIDGE_HTTP=curl to skip this process and use
one curl subprocess per request instead.
"""

import ctypes
import ctypes.util
import errno
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import queue
import re
import select
import socket
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

FRAME_MAX = 20 * 1024 * 1024
CONNECT_TIMEOUT = 10
# An idle client cannot sit on the accept path. Tests shorten this.
READ_DEADLINE_S = 5
WORK_QUEUE_MAX = 16
SOCKET_RESPONSE_GRACE_S = CONNECT_TIMEOUT + 5
SOCKET_REPLY_RESERVE_S = 0.5
TYPESAFE_CONTEXT_ERROR = (
    "TypeSafe configuration changed; run jb.py operator stop and retry. "
    "No API call was made."
)
RUN_PROTOCOL = "juno-run-v1"
NEGOTIATION_TTL_S = 30
NEGOTIATION_MAX = 32


def _negotiate_explicit(msg, client, cache):
    device = msg.get("device")
    if not isinstance(device, str) or re.fullmatch(r"[0-9a-f]{8,64}", device) is None:
        return {"ok": False, "error": "explicit canonical device required"}
    base = relay_base()
    if msg.get("relay_context") != base:
        cache.clear()
        return {"ok": False, "error": "relay configuration changed; no request was made"}
    # Read normal supported authentication afresh even on a cache hit. The
    # digest is private cache identity, never returned, persisted, or logged.
    auth = hashlib.sha256(admin_psk().encode("utf-8")).digest()
    identity = (base, auth)
    if cache.get("identity") != identity:
        cache.clear()
        cache["identity"] = identity
    entries = cache.setdefault("entries", {})
    now = time.monotonic()
    for key, deadline in list(entries.items()):
        if deadline <= now:
            del entries[key]
    if device in entries:
        return {"ok": True, "status": 200, "payload": {
            "capabilities": ["idempotency"], "run_protocol": RUN_PROTOCOL,
            "negotiation_cache_hit": True}}
    result = handle_message({"op": "relay_request_v1", "method": "GET", "route": "/admin/devices",
                             "relay_context": base}, client)
    payload = result.get("payload")
    if (result.get("ok") is True and result.get("status") == 200
            and isinstance(payload, dict) and payload.get("run_protocol") == RUN_PROTOCOL
            and isinstance(payload.get("capabilities"), list) and "idempotency" in payload["capabilities"]):
        if len(entries) >= NEGOTIATION_MAX:
            del entries[next(iter(entries))]
        entries[device] = time.monotonic() + NEGOTIATION_TTL_S
    # Legacy metadata is returned for this call but is never cached.
    return result

# libcurl option numbers. VERIFYHOST 2 and VERIFYPEER 1 stay set on purpose.
CURLOPT_TIMEOUT = 13
CURLOPT_POST = 47
CURLOPT_FOLLOWLOCATION = 52
CURLOPT_POSTFIELDSIZE = 60
CURLOPT_SSL_VERIFYPEER = 64
CURLOPT_FORBID_REUSE = 75
CURLOPT_CONNECTTIMEOUT = 78
CURLOPT_HTTPGET = 80
CURLOPT_SSL_VERIFYHOST = 81
CURLOPT_HTTP_VERSION = 84
CURLOPT_NOSIGNAL = 99
CURLOPT_WRITEDATA = 10001
CURLOPT_URL = 10002
CURLOPT_ERRORBUFFER = 10010
CURLOPT_POSTFIELDS = 10015
CURLOPT_HTTPHEADER = 10023
CURLOPT_CUSTOMREQUEST = 10036
CURLOPT_WRITEFUNCTION = 20011
CURLINFO_RESPONSE_CODE = 2097154
CURL_HTTP_VERSION_1_1 = 2
CURLE_OPERATION_TIMEDOUT = 28
CURL_GLOBAL_DEFAULT = 3

WRITE_CB = ctypes.CFUNCTYPE(
    ctypes.c_size_t,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_size_t,
    ctypes.c_void_p,
)


class OperatorError(Exception):
    pass


def operator_dir():
    for name in ("JUNO_JEV_CONFIG_DIR", "JUNO_OPERATOR_DIR"):
        raw = os.environ.get(name, "").strip()
        if raw:
            return Path(raw).expanduser()
    return Path.home() / ".config" / "juno-bridge"


def sock_path():
    raw = os.environ.get("JUNO_OPERATOR_SOCK", "").strip()
    if raw:
        return Path(raw)
    return operator_dir() / "operator.sock"


def token_path():
    return operator_dir() / "operator.token"


def lock_path():
    return operator_dir() / "operator.lock"


def _private_fd(path, flags):
    """Open an owner-controlled regular file without following symlinks."""
    fd = os.open(str(path), flags | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise OperatorError(f"{path} must be a regular file owned by you")
        return fd
    except BaseException:
        os.close(fd)
        raise


def config_path():
    return operator_dir() / "config.json"


def psk_path():
    return operator_dir() / "psk"


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = _private_fd(path, os.O_WRONLY | os.O_CREAT)
    try:
        os.fchmod(fd, 0o600)
        os.ftruncate(fd, 0)
        with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as stream:
            stream.write(text)
    finally:
        os.close(fd)


def read_private(path):
    fd = _private_fd(path, os.O_RDONLY)
    try:
        mode = stat.S_IMODE(os.fstat(fd).st_mode)
        if mode & 0o077:
            raise OperatorError(f"{path} is too permissive (mode {oct(mode)})")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as stream:
            return stream.read().strip()
    finally:
        os.close(fd)


def _owner_lock():
    """Hold ownership before inspecting stale paths or rotating the socket token."""
    directory = operator_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise OperatorError("operator directory must be owned by you and not a symlink")
    os.chmod(directory, 0o700)
    fd = _private_fd(lock_path(), os.O_RDWR | os.O_CREAT)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(fd)
        if exc.errno in (errno.EAGAIN, errno.EACCES):
            return None
        raise
    except BaseException:
        os.close(fd)
        raise
    return fd


def admin_psk():
    psk = os.environ.get("JUNO_BRIDGE_PSK", "").strip()
    if psk:
        return psk
    path = psk_path()
    if path.exists():
        psk = read_private(path)
        if psk:
            return psk
    raise OperatorError("no admin passphrase")


def relay_base():
    path = config_path()
    if not path.exists():
        raise OperatorError("no relay configured")
    data = json.loads(path.read_text(encoding="utf-8"))
    url = str(data.get("relay_url", "")).rstrip("/")
    if not url.startswith("https://"):
        raise OperatorError("relay URL must be https")
    return url


def curl_library_path():
    found = ctypes.util.find_library("curl")
    if found:
        return found
    for candidate in ("/usr/lib/libcurl.dylib", "/usr/lib/libcurl.so.4"):
        if os.path.exists(candidate):
            return candidate
    return None


class LibcurlSession:
    """One easy handle, reused so the connection pool survives across calls."""

    def __init__(self, library=None):
        path = library or curl_library_path()
        if not path:
            raise OperatorError("libcurl was not found")
        self.lib = ctypes.CDLL(path)
        self.longs = {}
        self._chunks = []
        self._body = None
        self._slist = None
        self._errbuf = ctypes.create_string_buffer(256)
        self._setup()
        if self.lib.curl_global_init(CURL_GLOBAL_DEFAULT) != 0:
            raise OperatorError("curl_global_init failed")
        self.easy = self.lib.curl_easy_init()
        if not self.easy:
            raise OperatorError("curl_easy_init failed")
        self._cb = WRITE_CB(self._write)
        self._setopt(CURLOPT_WRITEFUNCTION, self._cb, ctypes.c_void_p)
        self._setopt(CURLOPT_ERRORBUFFER, self._errbuf, ctypes.c_char_p)
        self._setopt(CURLOPT_NOSIGNAL, 1, ctypes.c_long)
        self._setopt(CURLOPT_FOLLOWLOCATION, 0, ctypes.c_long)
        self._setopt(CURLOPT_SSL_VERIFYPEER, 1, ctypes.c_long)
        self._setopt(CURLOPT_SSL_VERIFYHOST, 2, ctypes.c_long)
        self._setopt(CURLOPT_FORBID_REUSE, 0, ctypes.c_long)
        self._setopt(CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1, ctypes.c_long)
        self._setopt(CURLOPT_CONNECTTIMEOUT, CONNECT_TIMEOUT, ctypes.c_long)

    def _setup(self):
        lib = self.lib
        lib.curl_global_init.argtypes = [ctypes.c_long]
        lib.curl_global_init.restype = ctypes.c_int
        lib.curl_easy_init.argtypes = []
        lib.curl_easy_init.restype = ctypes.c_void_p
        lib.curl_easy_cleanup.argtypes = [ctypes.c_void_p]
        lib.curl_easy_cleanup.restype = None
        lib.curl_easy_perform.argtypes = [ctypes.c_void_p]
        lib.curl_easy_perform.restype = ctypes.c_int
        lib.curl_easy_getinfo.restype = ctypes.c_int
        lib.curl_slist_append.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lib.curl_slist_append.restype = ctypes.c_void_p
        lib.curl_slist_free_all.argtypes = [ctypes.c_void_p]
        lib.curl_slist_free_all.restype = None

    def _setopt(self, option, value, kind):
        # curl_easy_setopt is variadic. Declaring the value parameter in
        # argtypes makes ctypes pass a null pointer on this platform, so
        # only the two fixed parameters are declared. A bare Python int is
        # then narrowed to 32 bits, which truncates a pointer returned as
        # c_void_p, so those addresses are packed into a ctypes pointer.
        self.lib.curl_easy_setopt.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.curl_easy_setopt.restype = ctypes.c_int
        if kind is ctypes.c_long:
            self.longs[option] = int(value)
            value = ctypes.c_long(self.longs[option])
        elif value is None:
            value = ctypes.c_void_p(None)
        elif isinstance(value, int):
            value = ctypes.c_void_p(value)
        code = self.lib.curl_easy_setopt(self.easy, int(option), value)
        if code != 0:
            raise OperatorError(f"curl option {option} failed ({code})")

    def _write(self, contents, size, nmemb, _userdata):
        nbytes = size * nmemb
        if nbytes:
            self._chunks.append(ctypes.string_at(contents, nbytes))
        return nbytes

    def request(self, method, url, headers, body, timeout):
        self._chunks = []
        self._errbuf.value = b""
        self._url = url.encode("utf-8")
        self._setopt(CURLOPT_URL, self._url, ctypes.c_char_p)
        self._setopt(CURLOPT_TIMEOUT, max(1, int(timeout)), ctypes.c_long)
        self._setopt(CURLOPT_FOLLOWLOCATION, 0, ctypes.c_long)
        self._setopt(CURLOPT_SSL_VERIFYPEER, 1, ctypes.c_long)
        self._setopt(CURLOPT_SSL_VERIFYHOST, 2, ctypes.c_long)
        method = method.upper()
        # A reused easy handle keeps CURLOPT_CUSTOMREQUEST. Clear it before
        # choosing this request's method, or a GET after a POST stays a POST.
        self._setopt(CURLOPT_CUSTOMREQUEST, None, ctypes.c_char_p)
        if method == "GET":
            self._setopt(CURLOPT_HTTPGET, 1, ctypes.c_long)
        else:
            payload = body or b""
            self._body = ctypes.create_string_buffer(payload)
            self._method = method.encode("ascii")
            self._setopt(CURLOPT_POST, 1, ctypes.c_long)
            self._setopt(CURLOPT_POSTFIELDS, self._body, ctypes.c_char_p)
            self._setopt(CURLOPT_POSTFIELDSIZE, len(payload), ctypes.c_long)
            self._setopt(CURLOPT_CUSTOMREQUEST, self._method, ctypes.c_char_p)
        slist = None
        for header in headers:
            slist = self.lib.curl_slist_append(slist, header.encode("utf-8"))
        if self._slist:
            self.lib.curl_slist_free_all(self._slist)
        self._slist = slist
        self._setopt(CURLOPT_HTTPHEADER, slist or 0, ctypes.c_void_p)
        code = self.lib.curl_easy_perform(self.easy)
        if code == CURLE_OPERATION_TIMEDOUT:
            raise TimeoutError(self._error_text() or "timed out")
        if code != 0:
            raise OSError(self._error_text() or f"curl error {code}")
        status = ctypes.c_long()
        # Same variadic constraint as curl_easy_setopt: the out pointer is
        # an extra argument, not part of argtypes.
        self.lib.curl_easy_getinfo.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.curl_easy_getinfo.restype = ctypes.c_int
        if self.lib.curl_easy_getinfo(self.easy, CURLINFO_RESPONSE_CODE, ctypes.byref(status)) != 0:
            raise OSError("curl_easy_getinfo failed")
        return int(status.value), b"".join(self._chunks)

    def _error_text(self):
        raw = self._errbuf.value
        return raw.decode("utf-8", "replace")[:300] if raw else ""

    def close(self):
        if self._slist:
            self.lib.curl_slist_free_all(self._slist)
            self._slist = None
        if self.easy:
            self.lib.curl_easy_cleanup(self.easy)
            self.easy = None


def request_with_retry(client, method, url, headers, body, timeout, retry=False):
    """Retry only calls whose protocol can recover from an uncertain response."""
    deadline = time.monotonic() + timeout
    # /admin/run holds a response for at most 25s in the CLI. Leave budget
    # for one same-id retry even if the first transport waits to its limit.
    first_timeout = min(timeout, 30) if retry else timeout
    try:
        return client.request(method, url, headers, body, first_timeout)
    except TimeoutError:
        remaining = deadline - time.monotonic()
        if not retry or remaining < 1:
            raise
        return client.request(method, url, headers, body, remaining)


_jev = None


def jev_mod():
    """Load the decision helper. A separate module name avoids the CLI's copy."""
    global _jev
    if _jev is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev.py")
        spec = importlib.util.spec_from_file_location("juno_jev_operator", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _jev = mod
    return _jev


def _scrub_provider_response(value, key):
    """Keep credentials out of socket replies, even if a provider client echoes them."""
    if isinstance(value, str):
        return value.replace(key, "[redacted]") if key else value
    if isinstance(value, list):
        return [_scrub_provider_response(item, key) for item in value]
    if isinstance(value, dict):
        return {
            _scrub_provider_response(name, key): _scrub_provider_response(item, key)
            for name, item in value.items()
        }
    return value


def _typesafe_context_url(jev, value):
    """Canonicalize the validated API origin and base path, without credentials."""
    host, port, path, _origin = jev._typesafe_target(value)
    authority = "[" + host + "]" if ":" in host else host
    return f"https://{authority}:{port}" + path[:-len("/v1/systemone")]


def _handle_systemone(msg, typesafe_getter, admission=None):
    """One System One call. The key is read here, never accepted from the socket."""
    if any(name in msg for name in ("key", "authorization", "api_key")):
        return {"ok": False, "error": "the TypeSafe key stays in the operator"}
    if typesafe_getter is None:
        return {"ok": False, "error": "TypeSafe client is not available"}
    body = msg.get("body")
    if not isinstance(body, dict):
        return {"ok": False, "error": "TypeSafe body must be an object"}
    try:
        timeout = int(msg.get("timeout") or 30)
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad timeout"}
    key = ""
    try:
        if admission is not None and not admission():
            return {"ok": False, "error": "Jev caller disconnected or timed out; no API call was made"}
        jev = jev_mod()
        if "jev_enabled" in msg and not isinstance(msg["jev_enabled"], bool):
            return {"ok": False, "error": "jev_enabled must be a boolean"}
        enabled = msg["jev_enabled"] if "jev_enabled" in msg else jev.enabled()
        if not enabled:
            return {"ok": False, "error": "Jev is disabled; enable it before requesting a decision"}
        required = msg.get("op") in ("systemone_byok_v1", "systemone_byok_v2")
        if required and any(name not in msg for name in ("key_fingerprint", "typesafe_base_url")):
            return {"ok": False, "error": "TypeSafe caller configuration metadata is required; no API call was made"}
        fingerprint = msg.get("key_fingerprint")
        if "key_fingerprint" in msg and (
                not isinstance(fingerprint, str) or len(fingerprint) != 64
                or any(char not in "0123456789abcdefABCDEF" for char in fingerprint)):
            return {"ok": False, "error": "invalid TypeSafe key fingerprint; no API call was made"}
        if "typesafe_base_url" in msg:
            if not isinstance(msg["typesafe_base_url"], str):
                return {"ok": False, "error": "invalid TypeSafe API URL metadata; no API call was made"}
            try:
                expected_url = _typesafe_context_url(jev, msg["typesafe_base_url"])
                owner_url = _typesafe_context_url(jev, jev._typesafe_base())
            except (ValueError, jev.JevError):
                return {"ok": False, "error": "invalid TypeSafe API URL metadata; no API call was made"}
            if expected_url != owner_url:
                return {"ok": False, "error": TYPESAFE_CONTEXT_ERROR}
        key = jev.api_key()
        if fingerprint is not None and not hmac.compare_digest(
                fingerprint.lower(), hashlib.sha256(key.encode("utf-8")).hexdigest()):
            return {"ok": False, "error": TYPESAFE_CONTEXT_ERROR}
        if admission is not None and not admission():
            return {"ok": False, "error": "Jev caller disconnected or timed out; no API call was made"}
        typesafe = typesafe_getter()
        budget = admission() if admission is not None else None
        if admission is not None and not budget:
            return {"ok": False, "error": "Jev caller disconnected or timed out; no API call was made"}
        # A paid request is sent once. An uncertain transport outcome is not retried.
        response = typesafe.post(body, key, min(timeout, budget) if budget is not None else timeout)
    except ValueError as exc:
        return {"ok": False, "error": jev_mod().scrub(str(exc), key)[:300]}
    except Exception as exc:
        return {"ok": False, "error": jev_mod().scrub(str(exc), key)[:300]}
    if not isinstance(response, dict):
        return {"ok": False, "error": "TypeSafe returned a response that was not a JSON object"}
    return {"ok": True, "response": _scrub_provider_response(response, key)}


def handle_message(msg, client, typesafe_getter=None, admission=None, negotiation_cache=None):
    if not isinstance(msg, dict):
        return {"ok": False, "error": "bad message"}
    if msg.get("op") == "stop":
        return {"ok": True, "stop": True}
    if msg.get("op") == "ping":
        return {"ok": True, "pong": True}
    if msg.get("op") in ("systemone", "systemone_byok_v1", "systemone_byok_v2"):
        return _handle_systemone(msg, typesafe_getter, admission)
    if msg.get("op") == "negotiate_relay_v1":
        return _negotiate_explicit(msg, client, negotiation_cache if negotiation_cache is not None else {})
    relay_v2 = msg.get("op") == "relay_request_v2"
    relay_rpc = msg.get("op") in ("relay_request_v1", "relay_request_v2")
    path = msg.get("route") if relay_rpc else msg.get("path")
    if not isinstance(path, str) or not path.startswith("/") or "://" in path or "\n" in path:
        return {"ok": False, "error": "bad path"}
    if relay_v2 and path.split("?", 1)[0] != "/admin/run/v1":
        return {"ok": False, "error": "bad path"}
    method = msg.get("method") if isinstance(msg.get("method"), str) else "GET"
    try:
        base = relay_base()
        route = path.split("?", 1)[0]
        if (route == "/admin/run/v1" or "relay_context" in msg) and msg.get("relay_context") != base:
            if negotiation_cache is not None:
                negotiation_cache.clear()
            return {"ok": False, "error": "relay configuration changed; no request was made"}
        url = base + path
        headers = [f"Authorization: Bearer {admin_psk()}"]
        body = None
        if msg.get("data") is not None:
            body = json.dumps(msg["data"]).encode("utf-8")
            headers.append("Content-Type: application/json")
        timeout = int(msg.get("timeout") or 30)
        route = path.split("?", 1)[0]
        retry = (method.upper() == "GET" and route != "/admin/result") or (
            relay_rpc and msg.get("retry_safe") is True
            and method.upper() == "POST" and route in ("/admin/run", "/admin/run/v1")
            and isinstance(msg.get("data"), dict)
            and isinstance(msg["data"].get("request_id"), str)
        )
        status, raw = request_with_retry(client, method, url, headers, body, timeout, retry=retry)
    except TimeoutError:
        if negotiation_cache is not None: negotiation_cache.clear()
        return {"ok": False, "error": "request failed: timed out"}
    except OperatorError as exc:
        if negotiation_cache is not None: negotiation_cache.clear()
        return {"ok": False, "error": str(exc)[:300]}
    except OSError as exc:
        if negotiation_cache is not None: negotiation_cache.clear()
        return {"ok": False, "error": "request failed: " + str(exc)[:300]}
    text = raw.decode("utf-8", "replace") if raw else ""
    try:
        payload = json.loads(text) if text.strip() else {}
    except json.JSONDecodeError:
        payload = {"_raw": text.strip()[-300:]}
    if not isinstance(payload, dict):
        payload = {"_raw": payload}
    if not 200 <= status < 300 and negotiation_cache is not None:
        negotiation_cache.clear()
    return {"ok": True, "status": status, "payload": payload}


def _recv_line(conn, deadline=None):
    """Read one JSON line. deadline is seconds from now; None keeps the socket timeout."""
    buf = bytearray()
    started = time.monotonic()
    while b"\n" not in buf:
        if deadline is not None:
            remaining = deadline - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError("read deadline")
            conn.settimeout(remaining)
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > FRAME_MAX:
            raise OperatorError("message too large")
    if not buf:
        return None
    line, _, _rest = bytes(buf).partition(b"\n")
    return line


def _safe_send(conn, payload):
    """Write one frame. A closed client is that client's problem."""
    try:
        if isinstance(payload, (bytes, bytearray)):
            encoded = bytes(payload)
        else:
            encoded = json.dumps(payload).encode("utf-8")
        if len(encoded) > FRAME_MAX:
            encoded = b'{"ok":false,"error":"response too large"}'
        if not encoded.endswith(b"\n"):
            encoded += b"\n"
        conn.sendall(encoded)
    except OSError:
        return False
    return True


class _ServeGate:
    """Serializes the decision to queue work with the decision to shut down."""

    def __init__(self):
        self.lock = threading.Lock()
        self.closing = False


def _enqueue(work, gate, conn, msg):
    with gate.lock:
        if gate.closing:
            return "closing"
        try:
            deadline = None
            if msg.get("op") in ("systemone", "systemone_byok_v1", "systemone_byok_v2"):
                try:
                    timeout = int(msg.get("timeout") or 30)
                except (TypeError, ValueError):
                    timeout = 0
                deadline = time.monotonic() + max(0, timeout) + SOCKET_RESPONSE_GRACE_S
            work.put_nowait((conn, msg, deadline))
        except queue.Full:
            return "full"
    return "queued"


def _caller_budget(conn, deadline):
    """Return seconds left for queued Jev, without reading its socket frame."""
    remaining = deadline - time.monotonic() - SOCKET_REPLY_RESERVE_S
    if remaining <= 0:
        return 0
    try:
        readable, _, _ = select.select([conn], [], [], 0)
        return remaining if not readable or conn.recv(1, socket.MSG_PEEK) != b"" else 0
    except (OSError, ValueError):
        return 0


def _worker_loop(work, client, typesafe_getter, gate):
    """One thread owns the relay client and the TypeSafe client."""
    negotiation_cache = {}
    while True:
        item = work.get()
        if item is None:
            return
        conn, msg, deadline = item
        try:
            with gate.lock:
                closing = gate.closing
            if closing:
                _safe_send(conn, {"ok": False, "error": "operator is stopping"})
            else:
                try:
                    admission = (lambda: _caller_budget(conn, deadline)) if deadline is not None else None
                    result = handle_message(msg, client, typesafe_getter, admission, negotiation_cache)
                except Exception:
                    result = {"ok": False, "error": "request failed"}
                _safe_send(conn, result)
        except Exception:
            pass
        finally:
            _close_quietly(conn)


def _read_conn(conn, token, work, gate, stop, on_stop=None, on_stop_sent=None):
    """Read one request. Ping and stop do not wait behind upstream work."""
    handed = False
    try:
        try:
            line = _recv_line(conn, deadline=READ_DEADLINE_S)
        except OperatorError:
            _safe_send(conn, {"ok": False, "error": "bad message"})
            return
        except OSError:
            return
        if not line:
            return
        try:
            msg = json.loads(line.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeError):
            _safe_send(conn, {"ok": False, "error": "bad message"})
            return
        if not isinstance(msg, dict):
            _safe_send(conn, {"ok": False, "error": "bad message"})
            return
        supplied = msg.get("token")
        if not isinstance(supplied, str) or not hmac.compare_digest(supplied, token):
            _safe_send(conn, {"ok": False, "error": "unauthorized"})
            return
        op = msg.get("op")
        if op in ("ping", "stop"):
            result = handle_message(msg, None)
            # Drop the listening socket before the reply, so a health check
            # that arrives as this response is read cannot attach again.
            # The send is still finished before the process leaves serve().
            stopping = bool(result.get("stop"))
            if stopping and on_stop is not None:
                on_stop()
            try:
                _safe_send(conn, result)
            finally:
                if stopping and on_stop_sent is not None:
                    on_stop_sent()
            return
        status = _enqueue(work, gate, conn, msg)
        if status == "queued":
            handed = True
            return
        if status == "full":
            _safe_send(conn, {"ok": False, "error": "operator is busy"})
        else:
            _safe_send(conn, {"ok": False, "error": "operator is stopping"})
    except OSError:
        return
    finally:
        if not handed:
            _close_quietly(conn)


def socket_alive(path):
    if not path.exists():
        return False
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.2)
    try:
        probe.connect(str(path))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def _close_quietly(obj):
    if obj is not None and hasattr(obj, "close"):
        try:
            obj.close()
        except OSError:
            pass


def serve(client=None, ready=None, stop=None, typesafe=None):
    owner = _owner_lock()
    if owner is None:
        if ready:
            ready.set()
        return 0
    try:
        return _serve_owned(client=client, ready=ready, stop=stop, typesafe=typesafe)
    finally:
        os.close(owner)


def _serve_owned(client=None, ready=None, stop=None, typesafe=None):
    path = sock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        info = path.lstat()
    except FileNotFoundError:
        info = None
    if info is not None and (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid()):
        raise OperatorError("operator socket must be an owned socket, not a symlink or another file")
    if socket_alive(path):
        if ready:
            ready.set()
        return 0
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass
    token = os.urandom(32).hex()
    write_private(token_path(), token)
    if client is None:
        client = LibcurlSession()
    typesafe_box = [typesafe]

    def typesafe_getter():
        if typesafe_box[0] is None:
            typesafe_box[0] = jev_mod().TypeSafeSession()
        return typesafe_box[0]

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        srv.bind(str(path))
    except OSError:
        _close_quietly(client)
        _close_quietly(typesafe_box[0])
        srv.close()
        if ready:
            ready.set()
        return 0
    os.chmod(path, 0o600)
    srv.listen(8)
    srv.settimeout(0.2)
    if stop is None:
        stop = threading.Event()
    work = queue.Queue(maxsize=WORK_QUEUE_MAX)
    gate = _ServeGate()
    worker = threading.Thread(
        target=_worker_loop,
        args=(work, client, typesafe_getter, gate),
        name="juno-operator-worker",
        daemon=True,
    )
    worker.start()
    removed = False
    # Set until a stop reply is in progress, so shutdown does not wait
    # when the listener closed for another reason.
    stop_sent = threading.Event()
    stop_sent.set()

    def request_stop():
        nonlocal removed
        stop.set()
        with gate.lock:
            if not removed:
                removed = True
                try:
                    path.unlink()
                except OSError:
                    pass
        try:
            srv.close()
        except OSError:
            pass

    def begin_stop():
        stop_sent.clear()
        request_stop()

    if ready:
        ready.set()
    try:
        while not stop.is_set():
            try:
                conn, _addr = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(
                target=_read_conn,
                args=(conn, token, work, gate, stop, begin_stop, stop_sent.set),
                name="juno-operator-conn",
                daemon=True,
            ).start()
    finally:
        request_stop()
        # The socket is already gone. Stay until the stop reply is written
        # so the process does not exit underneath that client.
        stop_sent.wait(2)
        with gate.lock:
            gate.closing = True
        while True:
            try:
                work.put(None, timeout=0.2)
                break
            except queue.Full:
                continue
        worker.join()
        _close_quietly(client)
        _close_quietly(typesafe_box[0])
    return 0


def transact(message, timeout=60):
    payload = json.dumps(message).encode("utf-8") + b"\n"
    if len(payload) > FRAME_MAX:
        raise OperatorError("message too large")
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(timeout)
    try:
        conn.connect(str(sock_path()))
        conn.sendall(payload)
        line = _recv_line(conn)
    except TimeoutError as exc:
        raise OperatorError("operator socket timed out; request outcome is uncertain") from exc
    finally:
        conn.close()
    if not line:
        raise OperatorError("operator closed the connection")
    try:
        return json.loads(line.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise OperatorError("operator returned bad JSON") from exc


def ping_ok():
    path = token_path()
    if not path.exists() or not sock_path().exists():
        return False
    try:
        token = read_private(path)
        res = transact({"token": token, "op": "ping"}, timeout=2)
    except (OSError, OperatorError):
        return False
    return bool(res.get("ok") and res.get("pong"))


def ensure():
    if ping_ok():
        return
    if os.environ.get("JUNO_OPERATOR_CHILD") == "1":
        raise OperatorError("operator is not running")
    env = os.environ.copy()
    env["JUNO_OPERATOR_CHILD"] = "1"
    # Per-call opt-in is carried as a nonsecret boolean, never frozen in this daemon.
    env.pop("JUNO_JEV", None)
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jb.py")
    subprocess.Popen(
        [sys.executable, here, "operator"],
        start_new_session=True,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        if ping_ok():
            return
        time.sleep(0.05)
    raise OperatorError("operator did not start")


def call(method, path, data, timeout, retry_safe=False):
    ensure()
    token = read_private(token_path())
    # An older daemon sees no `path` and rejects this versioned RPC before
    # sending any relay request with its former unconditional retry policy.
    versioned_run = path.split("?", 1)[0] == "/admin/run/v1"
    # Old daemons understand v1 but ignore its new context field. A distinct
    # path-less RPC makes them reject the versioned route before any HTTP call.
    message = {"token": token, "op": "relay_request_v2" if versioned_run else "relay_request_v1", "method": method,
               "route": path, "timeout": int(timeout), "retry_safe": retry_safe}
    if versioned_run:
        message["relay_context"] = relay_base()
    if data is not None:
        message["data"] = data
    res = transact(message, timeout=int(timeout) + SOCKET_RESPONSE_GRACE_S)
    if not res.get("ok"):
        if res.get("error") == "bad path":
            raise OperatorError("operator is outdated; run jb.py operator stop and retry. No relay request was made")
        raise OperatorError(res.get("error") or "request failed")
    return res.get("status"), res.get("payload") if isinstance(res.get("payload"), dict) else {}


def negotiate_explicit_device(relay, device):
    ensure()
    res = transact({"token": read_private(token_path()), "op": "negotiate_relay_v1",
                    "relay_context": relay, "device": device}, timeout=30 + SOCKET_RESPONSE_GRACE_S)
    if not res.get("ok"):
        # Old daemons reject this path-less operation locally before any relay
        # request. The caller uses the ordinary fresh listing compatibility path.
        if res.get("error") == "bad path": return None
        raise OperatorError(res.get("error") or "negotiation failed")
    payload = res.get("payload")
    if not isinstance(payload, dict): raise OperatorError("invalid negotiation response")
    status = res.get("status")
    if status == 404: return dict(payload, _status=404)
    if status != 200: raise OperatorError("negotiation failed: HTTP " + str(status))
    return payload


def systemone(body, timeout=30):
    """Send one System One request through the operator's TypeSafe client.

    The operator reads its own API key. Nonsecret key and API-origin metadata
    prevent a running daemon from using a different configuration silently.
    """
    jev = jev_mod()
    key_fingerprint = hashlib.sha256(jev.api_key().encode("utf-8")).hexdigest()
    try:
        base_url = _typesafe_context_url(jev, jev._typesafe_base())
    except (ValueError, jev.JevError) as exc:
        raise OperatorError("invalid TypeSafe API URL configuration; no API call was made") from exc
    ensure()
    token = read_private(token_path())
    message = {
        "token": token,
        # Older daemons reject this operation before a paid call rather than
        # ignoring the configuration checks added by this protocol version.
        "op": "systemone_byok_v2",
        "body": body,
        "timeout": int(timeout),
        "key_fingerprint": key_fingerprint,
        "typesafe_base_url": base_url,
    }
    if "JUNO_JEV" in os.environ:
        message["jev_enabled"] = os.environ["JUNO_JEV"].strip() == "1"
    res = transact(message, timeout=int(timeout) + SOCKET_RESPONSE_GRACE_S)
    if not res.get("ok"):
        error = res.get("error") or "TypeSafe request failed"
        if error in ("bad path", "bad_path", "bad op", "bad_op"):
            error = "operator is outdated; run jb.py operator stop and retry. No API call was made"
        raise OperatorError(error)
    response = res.get("response")
    if not isinstance(response, dict):
        raise OperatorError("TypeSafe returned a response that was not a JSON object")
    return response


def stop():
    if not token_path().exists() or not sock_path().exists():
        raise OperatorError("operator is not running")
    token = read_private(token_path())
    try:
        res = transact({"token": token, "op": "stop"}, timeout=5)
    except OSError as exc:
        raise OperatorError("operator is not running") from exc
    if not res.get("ok"):
        raise OperatorError(res.get("error") or "stop failed")
