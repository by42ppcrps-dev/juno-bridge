"""Operator checks. They do not contact a deployed relay."""

import importlib.util
import json
import os
import stat
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("jb_operator_tests", ROOT / "driver" / "jb.py")
jb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(jb)

PSK = "correct-horse-battery"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _record(self):
        if hasattr(self.server, "ports"):
            self.server.ports.append(self.client_address[1])
        if hasattr(self.server, "methods"):
            self.server.methods.append(self.command)
        if hasattr(self.server, "paths"):
            self.server.paths.append(self.path)
        self.server.saw_header = self.headers.get("X-Juno-Test")

    def _reply(self):
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._record()
        self._reply()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self._record()
        self._reply()

    def log_message(self, _fmt, *_args):
        return


class FakeClient:
    def __init__(self, responder=None):
        self.calls = []
        self.closed = False
        self._responder = responder or (lambda *_args: (200, b'{"ok":true}'))

    def request(self, method, url, headers, body, timeout):
        self.calls.append((method, url, list(headers), body, timeout))
        return self._responder(method, url, headers, body, timeout)

    def close(self):
        self.closed = True


class OperatorTests(unittest.TestCase):
    def setUp(self):
        self.op = jb.operator_mod()
        self.tmp = Path(os.environ.get("TMPDIR") or "/tmp") / ("juno-op-" + os.urandom(4).hex())
        self.tmp.mkdir()
        self.sock = "/tmp/juno-op-%s.sock" % os.urandom(4).hex()
        self._saved = {
            "JUNO_OPERATOR_DIR": os.environ.get("JUNO_OPERATOR_DIR"),
            "JUNO_OPERATOR_SOCK": os.environ.get("JUNO_OPERATOR_SOCK"),
            "JUNO_OPERATOR": os.environ.get("JUNO_OPERATOR"),
            "JUNO_BRIDGE_HTTP": os.environ.get("JUNO_BRIDGE_HTTP"),
            "JUNO_BRIDGE_PSK": os.environ.get("JUNO_BRIDGE_PSK"),
            "JUNO_OPERATOR_CHILD": os.environ.get("JUNO_OPERATOR_CHILD"),
        }
        os.environ["JUNO_OPERATOR_DIR"] = str(self.tmp)
        os.environ["JUNO_OPERATOR_SOCK"] = self.sock
        os.environ["JUNO_OPERATOR"] = "1"
        os.environ.pop("JUNO_BRIDGE_HTTP", None)
        os.environ.pop("JUNO_OPERATOR_CHILD", None)
        os.environ["JUNO_BRIDGE_PSK"] = PSK
        (self.tmp / "config.json").write_text(
            json.dumps({"relay_url": "https://relay.example"}),
            encoding="utf-8",
        )
        self.thread = None
        self.stop_flag = None

    def tearDown(self):
        if self.stop_flag is not None:
            self.stop_flag.set()
        if self.thread is not None:
            self.thread.join(2)
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        if os.path.exists(self.sock):
            try:
                os.remove(self.sock)
            except OSError:
                pass
        for child in self.tmp.iterdir():
            child.unlink()
        self.tmp.rmdir()

    def start(self, client, typesafe=None):
        self.stop_flag = threading.Event()
        ready = threading.Event()
        kwargs = {"client": client, "ready": ready, "stop": self.stop_flag}
        if typesafe is not None:
            kwargs["typesafe"] = typesafe
        self.thread = threading.Thread(
            target=self.op.serve,
            kwargs=kwargs,
            daemon=True,
        )
        self.thread.start()
        self.assertTrue(ready.wait(2), "operator did not listen")
        self.assertTrue(self.thread.is_alive(), "operator exited before a request")
        return self.op.read_private(self.op.token_path())

    def test_reuses_one_client_and_keeps_the_passphrase_off_the_socket(self):
        client = FakeClient()
        token = self.start(client)
        mode = stat.S_IMODE(os.stat(self.sock).st_mode)
        self.assertEqual(mode & 0o077, 0)
        token_mode = stat.S_IMODE(os.stat(self.op.token_path()).st_mode)
        self.assertEqual(token_mode & 0o077, 0)
        message = {
            "token": token,
            "method": "POST",
            "path": "/admin/ping",
            "data": {"hello": "world"},
            "timeout": 5,
        }
        self.assertNotIn(PSK, json.dumps(message))
        with mock.patch.object(jb.subprocess, "run", side_effect=AssertionError("curl")):
            with mock.patch.object(jb.subprocess, "Popen", side_effect=AssertionError("spawned")):
                first = jb.relay_request("POST", "/admin/ping", {"hello": "world"}, timeout=5)
                second = self.op.transact(message)
        self.assertEqual(first, {"ok": True})
        self.assertTrue(second["ok"])
        self.assertEqual(len(client.calls), 2)
        self.assertIs(client.calls[0][3].__class__, bytes)
        for _method, url, headers, body, _timeout in client.calls:
            self.assertEqual(url, "https://relay.example/admin/ping")
            self.assertTrue(any(header == "Authorization: Bearer " + PSK for header in headers))
            self.assertNotIn(PSK.encode(), body or b"")
        stopped = self.op.transact({"token": token, "op": "stop"})
        self.assertTrue(stopped.get("ok"))
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())
        self.thread = None

    def test_a_bad_path_and_a_bad_token_do_not_call_the_relay(self):
        client = FakeClient()
        token = self.start(client)
        bad_path = self.op.transact({"token": token, "method": "GET", "path": "https://evil.example/admin/ping"})
        self.assertFalse(bad_path["ok"])
        self.assertIn("bad path", bad_path["error"])
        wrong = self.op.transact({"token": "f" * 64, "op": "ping"})
        self.assertFalse(wrong["ok"])
        self.assertEqual(client.calls, [])

    def test_a_transport_timeout_is_retried_once_with_the_same_body(self):
        bodies = []

        def respond(_method, _url, _headers, body, _timeout):
            bodies.append(body)
            if len(bodies) == 1:
                raise TimeoutError("timed out")
            return 200, b'{"ok":true,"n":1}'

        res = self.op.handle_message({
            "method": "POST",
            "path": "/admin/run",
            "data": {"request_id": "req_timeout1", "action": "click"},
            "timeout": 5,
        }, FakeClient(respond))
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["status"], 200)
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0], bodies[1])
        self.assertIn(b"req_timeout1", bodies[0])

    def test_http_and_socket_errors_are_not_retried(self):
        once = {"n": 0}

        def http_error(*_args):
            once["n"] += 1
            return 500, b'{"error":"no"}'

        res = self.op.handle_message({
            "method": "POST",
            "path": "/admin/run",
            "data": {"request_id": "req_http_500"},
            "timeout": 5,
        }, FakeClient(http_error))
        self.assertEqual(once["n"], 1)
        self.assertEqual(res["status"], 500)

        def broken(*_args):
            once["n"] += 1
            raise OSError("reset")

        failed = self.op.handle_message({
            "method": "GET",
            "path": "/admin/ping",
            "timeout": 5,
        }, FakeClient(broken))
        self.assertEqual(once["n"], 2)
        self.assertFalse(failed["ok"])
        self.assertIn("reset", failed["error"])

    def test_libcurl_reuses_the_connection_and_verifies_certificates(self):
        if not self.op.curl_library_path():
            self.skipTest("libcurl not installed")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.ports = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        session = None
        try:
            session = self.op.LibcurlSession()
            url = "http://127.0.0.1:%d/a" % server.server_address[1]
            first = session.request("GET", url, ["X-Juno-Test: 1"], None, 5)
            second = session.request("GET", url, ["X-Juno-Test: 1"], None, 5)
            self.assertEqual(first[0], 200)
            self.assertEqual(second[0], 200)
            self.assertIn(b'"ok":true', first[1])
            self.assertEqual(len(server.ports), 2)
            self.assertEqual(len(set(server.ports)), 1)
            self.assertEqual(server.saw_header, "1")
            self.assertEqual(session.longs[self.op.CURLOPT_SSL_VERIFYPEER], 1)
            self.assertEqual(session.longs[self.op.CURLOPT_SSL_VERIFYHOST], 2)
            self.assertEqual(session.longs[self.op.CURLOPT_FOLLOWLOCATION], 0)
        finally:
            if session is not None:
                session.close()
            server.shutdown()
            thread.join(2)
            server.server_close()

    def _libcurl_server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.ports = []
        server.methods = []
        server.paths = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    def test_libcurl_switches_methods_on_a_reused_handle(self):
        if not self.op.curl_library_path():
            self.skipTest("libcurl not installed")
        server, thread = self._libcurl_server()
        session = None
        try:
            session = self.op.LibcurlSession()
            base = "http://127.0.0.1:%d" % server.server_address[1]
            headers = ["X-Juno-Test: 1"]
            # The driver posts a command, then GETs the result while it is pending.
            sequence = [
                ("GET", "/admin/ping", None),
                ("POST", "/admin/run", b'{"action":"click","request_id":"req_method01"}'),
                ("GET", "/admin/result?id=cmd_" + ("ab" * 8), None),
                ("POST", "/admin/run", b'{"action":"click","request_id":"req_method02"}'),
                ("GET", "/admin/devices", None),
                ("POST", "/admin/cmd", b'{"action":"ping","request_id":"req_method03"}'),
            ]
            for method, path, body in sequence:
                status, _payload = session.request(method, base + path, headers, body, 5)
                self.assertEqual(status, 200, method + " " + path)
            self.assertEqual(
                server.methods,
                ["GET", "POST", "GET", "POST", "GET", "POST"],
            )
            self.assertEqual(
                [path.split("?")[0] for path in server.paths],
                ["/admin/ping", "/admin/run", "/admin/result", "/admin/run", "/admin/devices", "/admin/cmd"],
            )
            self.assertEqual(len(server.ports), 6)
            self.assertEqual(len(set(server.ports)), 1)
            self.assertEqual(session.longs[self.op.CURLOPT_SSL_VERIFYPEER], 1)
            self.assertEqual(session.longs[self.op.CURLOPT_SSL_VERIFYHOST], 2)
            self.assertEqual(session.longs[self.op.CURLOPT_FOLLOWLOCATION], 0)
        finally:
            if session is not None:
                session.close()
            server.shutdown()
            thread.join(2)
            server.server_close()

    def test_ensure_starts_one_process_and_stop_ends_it(self):
        if not self.op.curl_library_path():
            self.skipTest("libcurl not installed")
        spawned = []
        real_popen = self.op.subprocess.Popen

        def popen(args, **kwargs):
            spawned.append(args)
            return real_popen(args, **kwargs)

        try:
            with mock.patch.object(self.op.subprocess, "Popen", side_effect=popen):
                with mock.patch.object(jb.subprocess, "run", side_effect=AssertionError("curl")):
                    self.op.ensure()
                    self.assertTrue(self.op.ping_ok())
                    self.op.ensure()
            self.assertEqual(len(spawned), 1)
            self.assertIn("operator", spawned[0])
            self.op.stop()
            self.assertFalse(self.op.ping_ok())
        finally:
            try:
                self.op.stop()
            except self.op.OperatorError:
                pass

    def test_systemone_reuses_one_client_and_keeps_the_key_off_the_socket(self):
        secret = "typesafe-test-key-not-real"
        saved = os.environ.get("TYPESAFE_API_KEY")
        os.environ["TYPESAFE_API_KEY"] = secret

        class FakeTypeSafe:
            def __init__(self):
                self.posts = []
                self.closed = False

            def post(self, body, key, timeout=30):
                self.posts.append((body, key, timeout))
                return {"answers": {"target": {"choice": "none"}}}

            def close(self):
                self.closed = True

        session = FakeTypeSafe()
        client = FakeClient()
        try:
            token = self.start(client, typesafe=session)
            seen = []
            real = self.op.transact

            def wrapped(message, timeout=60):
                seen.append(json.dumps(message))
                return real(message, timeout)

            with mock.patch.object(jb.subprocess, "Popen", side_effect=AssertionError("spawned")):
                with mock.patch.object(self.op, "transact", side_effect=wrapped):
                    first = self.op.systemone({"questions": {"target": {}}})
                    second = self.op.systemone({"questions": {"page": {}}})
                    refused = real({"token": token, "op": "systemone", "key": secret, "body": {}})
            self.assertEqual(first, {"answers": {"target": {"choice": "none"}}})
            self.assertEqual(second, first)
            self.assertEqual(
                [item[0] for item in session.posts],
                [{"questions": {"target": {}}}, {"questions": {"page": {}}}],
            )
            self.assertEqual(session.posts[0][1], secret)
            self.assertEqual(session.posts[1][1], secret)
            self.assertEqual(client.calls, [])
            messages = [json.loads(item) for item in seen]
            systemone_msgs = [item for item in messages if item.get("op") == "systemone"]
            self.assertEqual(len(systemone_msgs), 2)
            for message in messages:
                self.assertNotIn(secret, json.dumps(message))
                self.assertNotIn("authorization", message)
                self.assertNotIn("api_key", message)
            self.assertFalse(refused["ok"])
            self.assertEqual(len(session.posts), 2)
            jev = self.op.jev_mod()
            old_key_file = jev.KEY_FILE

            def boom(body, key, timeout=30):
                raise jev.JevError("bad " + key)

            session.post = boom
            with mock.patch.object(jb.subprocess, "Popen", side_effect=AssertionError("spawned")):
                with self.assertRaises(self.op.OperatorError) as caught:
                    self.op.systemone({"questions": {"target": {}}})
            self.assertNotIn(secret, str(caught.exception))
            self.assertIn("[redacted]", str(caught.exception))
            jev.KEY_FILE = str(self.tmp / "missing-typesafe-key")
            os.environ.pop("TYPESAFE_API_KEY", None)
            missing = self.op.handle_message(
                {"op": "systemone", "body": {"model": "jev-latest"}},
                FakeClient(),
                lambda: session,
            )
            self.assertFalse(missing["ok"])
            self.assertIn("TYPESAFE_API_KEY", missing["error"])
            self.assertNotIn(secret, missing["error"])
            stopped = self.op.transact({"token": token, "op": "stop"})
            self.assertTrue(stopped.get("ok"))
            self.thread.join(2)
            self.thread = None
            self.assertTrue(session.closed)
            jev.KEY_FILE = old_key_file
        finally:
            if saved is None:
                os.environ.pop("TYPESAFE_API_KEY", None)
            else:
                os.environ["TYPESAFE_API_KEY"] = saved


if __name__ == "__main__":
    unittest.main()
