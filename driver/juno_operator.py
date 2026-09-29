"""User-scoped operator process for Juno Bridge.

The CLI talks to this process over a private Unix socket. The process owns
the relay HTTP client, a separate TypeSafe client, and the admin passphrase.
The passphrase and the TypeSafe key are not sent on the socket. Certificate
verification stays on, and redirects are not followed, so a bearer token is
not sent to another host.

Set JUNO_OPERATOR=0 or JUNO_BRIDGE_HTTP=curl to skip this process and use
one curl subprocess per request instead.
"""

import ctypes
import ctypes.util
import hmac
import importlib.util
import json
import os
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

FRAME_MAX = 20 * 1024 * 1024
CONNECT_TIMEOUT = 10

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
    raw = os.environ.get("JUNO_OPERATOR_DIR", "").strip()
    if raw:
        return Path(raw)
    return Path.home() / ".config" / "juno-bridge"


def sock_path():
    raw = os.environ.get("JUNO_OPERATOR_SOCK", "").strip()
    if raw:
        return Path(raw)
    return operator_dir() / "operator.sock"


def token_path():
    return operator_dir() / "operator.token"


def config_path():
    return operator_dir() / "config.json"


def psk_path():
    return operator_dir() / "psk"


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
    finally:
        os.close(fd)
    os.chmod(path, 0o600)


def read_private(path):
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        raise OperatorError(f"{path} is too permissive (mode {oct(mode)})")
    return Path(path).read_text(encoding="utf-8").strip()


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


def request_with_retry(client, method, url, headers, body, timeout):
    """One transport retry of the same bytes. Not a second browser command."""
    try:
        return client.request(method, url, headers, body, timeout)
    except TimeoutError:
        return client.request(method, url, headers, body, timeout)


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


def _handle_systemone(msg, typesafe_getter):
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
        typesafe = typesafe_getter()
        jev = jev_mod()
        key = jev.api_key()
        response = typesafe.post(body, key, timeout)
    except ValueError as exc:
        return {"ok": False, "error": jev_mod().scrub(str(exc), key)[:300]}
    except Exception as exc:
        return {"ok": False, "error": jev_mod().scrub(str(exc), key)[:300]}
    if not isinstance(response, dict):
        return {"ok": False, "error": "TypeSafe returned a response that was not a JSON object"}
    return {"ok": True, "response": response}


def handle_message(msg, client, typesafe_getter=None):
    if not isinstance(msg, dict):
        return {"ok": False, "error": "bad message"}
    if msg.get("op") == "stop":
        return {"ok": True, "stop": True}
    if msg.get("op") == "ping":
        return {"ok": True, "pong": True}
    if msg.get("op") == "systemone":
        return _handle_systemone(msg, typesafe_getter)
    path = msg.get("path")
    if not isinstance(path, str) or not path.startswith("/") or "://" in path or "\n" in path:
        return {"ok": False, "error": "bad path"}
    method = msg.get("method") if isinstance(msg.get("method"), str) else "GET"
    try:
        url = relay_base() + path
        headers = [f"Authorization: Bearer {admin_psk()}"]
        body = None
        if msg.get("data") is not None:
            body = json.dumps(msg["data"]).encode("utf-8")
            headers.append("Content-Type: application/json")
        timeout = int(msg.get("timeout") or 30)
        status, raw = request_with_retry(client, method, url, headers, body, timeout)
    except TimeoutError:
        return {"ok": False, "error": "request failed: timed out"}
    except OperatorError as exc:
        return {"ok": False, "error": str(exc)[:300]}
    except OSError as exc:
        return {"ok": False, "error": "request failed: " + str(exc)[:300]}
    text = raw.decode("utf-8", "replace") if raw else ""
    try:
        payload = json.loads(text) if text.strip() else {}
    except json.JSONDecodeError:
        payload = {"_raw": text.strip()[-300:]}
    if not isinstance(payload, dict):
        payload = {"_raw": payload}
    return {"ok": True, "status": status, "payload": payload}


def _recv_line(conn):
    buf = bytearray()
    while b"\n" not in buf:
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


def serve_conn(conn, token, client, typesafe_getter=None):
    try:
        line = _recv_line(conn)
        if line is None:
            return False
        msg = json.loads(line.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeError, OperatorError):
        conn.sendall(b'{"ok":false,"error":"bad message"}\n')
        return False
    supplied = msg.get("token") if isinstance(msg, dict) else None
    if not isinstance(supplied, str) or not hmac.compare_digest(supplied, token):
        conn.sendall(b'{"ok":false,"error":"unauthorized"}\n')
        return False
    result = handle_message(msg, client, typesafe_getter)
    encoded = json.dumps(result).encode("utf-8")
    if len(encoded) > FRAME_MAX:
        encoded = b'{"ok":false,"error":"response too large"}'
    conn.sendall(encoded + b"\n")
    return bool(result.get("stop"))


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
    path = sock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
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
        _close_quietly(typesafe_box[0])
        if ready:
            ready.set()
        return 0
    os.chmod(path, 0o600)
    srv.listen(8)
    srv.settimeout(0.2)
    if ready:
        ready.set()
    stopping = False
    try:
        while not stopping and not (stop and stop.is_set()):
            try:
                conn, _addr = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                stopping = serve_conn(conn, token, client, typesafe_getter)
            finally:
                conn.close()
    finally:
        srv.close()
        _close_quietly(client)
        _close_quietly(typesafe_box[0])
        try:
            path.unlink()
        except OSError:
            pass
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


def call(method, path, data, timeout):
    ensure()
    token = read_private(token_path())
    message = {"token": token, "method": method, "path": path, "timeout": int(timeout)}
    if data is not None:
        message["data"] = data
    res = transact(message, timeout=int(timeout) + CONNECT_TIMEOUT + 5)
    if not res.get("ok"):
        raise OperatorError(res.get("error") or "request failed")
    return res.get("status"), res.get("payload") if isinstance(res.get("payload"), dict) else {}


def systemone(body, timeout=30):
    """Send one System One request through the operator's TypeSafe client.

    The API key stays in this process. The socket message carries the body only.
    """
    ensure()
    token = read_private(token_path())
    message = {
        "token": token,
        "op": "systemone",
        "body": body,
        "timeout": int(timeout),
    }
    res = transact(message, timeout=int(timeout) + CONNECT_TIMEOUT + 5)
    if not res.get("ok"):
        raise OperatorError(res.get("error") or "TypeSafe request failed")
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
