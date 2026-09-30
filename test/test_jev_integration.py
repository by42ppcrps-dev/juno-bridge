"""Local TLS + Unix-socket integration; no real API, key, relay, or Chrome."""

from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import stat
import subprocess
import tempfile
import threading
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
KEY = "typesafe-local-integration-fake-owner-key-one"
ROTATED_KEY = "typesafe-local-integration-fake-owner-key-two"
PSK = "relay-local-integration-fake-passphrase"
SNAPSHOT_ID = "snap_" + "a" * 32


def snapshot(identifier=SNAPSHOT_ID):
    return {
        "snapshot": identifier,
        "title": "Invoices",
        "url": "https://example.com/invoices",
        "elements": [{
            "ref": "e1", "tag": "a", "text": "Download invoice",
            "href": "https://example.com/invoices/download", "inView": True,
            "x": 50, "y": 30, "w": 100, "h": 20,
        }],
    }


class FakeRelayClient:
    """Return browser fixtures only after a real operator RPC reaches the relay."""

    def __init__(self):
        self.calls = []
        self.closed = False

    def request(self, method, url, headers, body, timeout):
        if method != "POST" or url != "https://relay.invalid/admin/run":
            raise AssertionError("unexpected relay request")
        command = json.loads(body)
        self.calls.append({"headers": list(headers), "command": command})
        if command["action"] == "snapshot":
            result = {"ok": True, "data": snapshot()}
        elif command["action"] == "workflow":
            result = {"ok": True, "data": {
                "status": "completed", "dispatched": True,
                "observation": snapshot("snap_" + "b" * 32),
            }}
        else:
            raise AssertionError("unexpected browser action")
        response = {
            "ok": True, "id": "cmd_" + "1" * 16,
            "pending": False, "result": result,
        }
        return 200, json.dumps(response).encode("utf-8")

    def close(self):
        self.closed = True


class LocalProvider(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), ProviderHandler)
        self.connections = 0
        self.requests = []
        self.fail_next = False

    def get_request(self):
        conn, address = super().get_request()
        self.connections += 1
        return conn, address


class ProviderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        authorization = self.headers.get("Authorization")
        self.server.requests.append({
            "path": self.path, "authorization": authorization, "body": body,
        })
        if self.server.fail_next:
            self.server.fail_next = False
            status = 500
            payload = {"error": "provider error echoed " + authorization}
        else:
            status = 200
            choices = {
                "target": "e1", "page": "other",
                "step": "proceed_with_selected_target",
            }
            answers = {}
            for name, question in body["questions"].items():
                choice = choices[name]
                if choice not in question["criteria"]:
                    raise AssertionError("fixture choice was not offered")
                answers[name] = {
                    "type": "choice", "choice": choice, "confidence": 0.95,
                    "probabilities": {choice: 0.95},
                }
            payload = {
                "model": "jev-local-test-stub", "answers": answers,
                "usage": {"input_tokens": 10, "output_tokens": 1},
                # The real client must scrub provider echoes before its Unix reply.
                "diagnostic": "provider echo " + authorization,
            }
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)
        self.wfile.flush()

    def log_message(self, _format, *_args):
        return


class JevLocalIntegrationTests(unittest.TestCase):
    def run_cli(self, jb, *args):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            try:
                code = jb.main(["jb.py", "jev", *args])
            except SystemExit as exc:
                code = exc.code
        for secret in (KEY, ROTATED_KEY, PSK):
            self.assertNotIn(secret, out.getvalue() + err.getvalue())
        return code, out.getvalue(), err.getvalue()

    def test_real_tls_operator_reuses_connection_honors_toggle_and_rotates_private_key(self):
        openssl = shutil.which("openssl")
        if openssl is None:
            self.skipTest("local HTTPS integration requires openssl to generate a test certificate")
        if not hasattr(socket, "AF_UNIX"):
            self.skipTest("local operator integration requires Unix sockets")

        # Keep the Unix socket path below the platform's length limit.
        with tempfile.TemporaryDirectory(prefix="juno-jev-int-", dir="/tmp") as temporary:
            directory = Path(temporary)
            certificate, private_key = directory / "cert.pem", directory / "tls-key.pem"
            certificate_config = directory / "tls.cnf"
            certificate_config.write_text(
                "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n"
                "[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n"
                "basicConstraints=critical,CA:TRUE\n", encoding="utf-8",
            )
            generated = subprocess.run([
                openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(private_key), "-out", str(certificate),
                "-days", "1", "-config", str(certificate_config),
            ], capture_output=True, text=True, timeout=20)
            self.assertEqual(generated.returncode, 0, "failed to generate local TLS fixture")

            provider = LocalProvider()
            server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server_context.load_cert_chain(certificate, private_key)
            provider.socket = server_context.wrap_socket(provider.socket, server_side=True)
            server_thread = threading.Thread(target=provider.serve_forever, daemon=True)
            server_thread.start()
            self.addCleanup(provider.server_close)
            self.addCleanup(provider.shutdown)

            env = {
                "JUNO_OPERATOR_DIR": temporary, "JUNO_JEV_CONFIG_DIR": temporary,
                "JUNO_OPERATOR_SOCK": str(directory / "operator.sock"),
                "JUNO_OPERATOR": "1", "JUNO_BRIDGE_PSK": PSK,
                "TYPESAFE_BASE_URL": "https://localhost:" + str(provider.server_port),
                "NO_PROXY": "*", "no_proxy": "*",
            }
            spec = importlib.util.spec_from_file_location(
                "jb_local_jev_integration", ROOT / "driver" / "jb.py",
            )
            jb = importlib.util.module_from_spec(spec)
            contexts, socket_requests, socket_responses = [], [], []
            real_context = ssl.create_default_context
            real_connect = socket.create_connection

            def trusted_context(*args, **kwargs):
                kwargs["cafile"] = str(certificate)
                context = real_context(*args, **kwargs)
                contexts.append(context)
                return context

            def local_connection(address, *args, **kwargs):
                self.assertEqual(address, ("localhost", provider.server_port),
                                 "integration test must never connect to a real API")
                return real_connect(address, *args, **kwargs)

            with ExitStack() as stack:
                stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
                stack.enter_context(mock.patch.object(ssl, "create_default_context", side_effect=trusted_context))
                stack.enter_context(mock.patch.object(socket, "create_connection", side_effect=local_connection))
                spec.loader.exec_module(jb)
                op = jb.operator_mod()
                relay = FakeRelayClient()
                (directory / "config.json").write_text(
                    json.dumps({"relay_url": "https://relay.invalid"}), encoding="utf-8",
                )
                real_transact = op.transact

                def recorded_transact(message, timeout=60):
                    socket_requests.append(json.dumps(message))
                    response = real_transact(message, timeout)
                    socket_responses.append(json.dumps(response))
                    return response

                stack.enter_context(mock.patch.object(op, "transact", side_effect=recorded_transact))
                stack.enter_context(mock.patch.object(jb.subprocess, "Popen", side_effect=AssertionError("unexpected operator spawn")))

                code, _, _ = self.run_cli(jb, "status")
                self.assertEqual(code, 0)
                decision = ("target", "page", "step", "--tab", "123456", "--goal", "Download the invoice")
                self.assertEqual(self.run_cli(jb, *decision)[0], 2)
                with mock.patch("sys.stdin", mock.Mock(isatty=mock.Mock(return_value=True))), \
                        mock.patch.object(jb.getpass, "getpass", return_value=KEY):
                    self.assertEqual(self.run_cli(jb, "configure")[0], 0)
                key_path = directory / "jev-api-key"
                self.assertEqual(stat.S_IMODE(key_path.stat().st_mode), 0o600)
                self.assertFalse(jb.jev_mod().enabled(), "configure must not enable paid calls")
                self.assertEqual(self.run_cli(jb, "on")[0], 0)
                code, output, _ = self.run_cli(jb, "status")
                self.assertEqual(code, 0)
                self.assertTrue(json.loads(output)["enabled"])
                self.assertEqual(provider.requests, [])

                ready, stop = threading.Event(), threading.Event()
                operator_thread = threading.Thread(
                    target=op.serve,
                    kwargs={"client": relay, "ready": ready, "stop": stop}, daemon=True,
                )
                operator_thread.start()
                try:
                    self.assertTrue(ready.wait(3), "operator did not start")
                    self.assertTrue(operator_thread.is_alive())
                    for _ in range(2):
                        code, output, _ = self.run_cli(jb, *decision)
                        self.assertEqual(code, 0)
                        report = json.loads(output)
                        self.assertEqual(report["decisions"]["target"]["choice"], "e1")
                        self.assertIsNone(report["click"], "decision-only must not mutate the browser")
                    self.assertEqual(len(provider.requests), 2)
                    self.assertEqual(provider.connections, 1)

                    self.assertEqual(self.run_cli(jb, "off")[0], 0)
                    self.assertEqual(self.run_cli(jb, *decision)[0], 2)
                    self.assertEqual(len(provider.requests), 2)
                    self.assertEqual(len(relay.calls), 2, "off must not request a browser snapshot")
                    prepared = jb.jev_mod().prepare(snapshot(), ["target"], "Download the invoice")
                    with self.assertRaisesRegex(op.OperatorError, "disabled"):
                        op.systemone(prepared["body"], timeout=3)
                    self.assertEqual(len(provider.requests), 2, "operator must also enforce the live toggle")

                    with mock.patch("sys.stdin", mock.Mock(isatty=mock.Mock(return_value=True))), \
                            mock.patch.object(jb.getpass, "getpass", return_value=ROTATED_KEY):
                        self.assertEqual(self.run_cli(jb, "configure")[0], 0)
                    self.assertEqual(self.run_cli(jb, "on")[0], 0)
                    observation = directory / "snapshot.json"
                    observation.write_text(json.dumps(snapshot()), encoding="utf-8")
                    ready_condition = {"type": "text", "text": "Invoice", "timeoutMs": 100}
                    code, output, _ = self.run_cli(
                        jb, *decision, "--observation", str(observation), "--click",
                        "--after-ready", json.dumps(ready_condition),
                    )
                    self.assertEqual(code, 0)
                    clicked = json.loads(output)["click"]
                    self.assertTrue(clicked["issued"])
                    self.assertEqual(clicked["observation"]["snapshot"], "snap_" + "b" * 32)
                    self.assertEqual(len(relay.calls), 3, "saved observation must not take another snapshot")
                    workflow = relay.calls[-1]["command"]
                    self.assertEqual(workflow["action"], "workflow")
                    self.assertEqual(workflow["params"]["snapshot"], SNAPSHOT_ID)
                    step = workflow["params"]["steps"][0]
                    self.assertEqual(step["ref"], "e1")
                    self.assertEqual(step["after"]["ready"], ready_condition)
                    self.assertEqual(provider.connections, 1, "key rotation must reuse the provider connection")

                    provider.fail_next = True
                    code, _, error = self.run_cli(jb, *decision, "--observation", str(observation))
                    self.assertEqual(code, 1)
                    self.assertIn("TypeSafe HTTP 500", error)
                    self.assertIn("[redacted]", error)
                    self.assertEqual(len(provider.requests), 4, "provider error must not be replayed")
                    self.assertEqual(provider.connections, 1)
                finally:
                    stop.set()
                    operator_thread.join(5)
                    self.assertFalse(operator_thread.is_alive(), "operator did not stop")

                self.assertTrue(relay.closed)
                self.assertTrue(contexts)
                for context in contexts:
                    self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                    self.assertTrue(context.check_hostname)
                self.assertEqual([record["authorization"] for record in provider.requests], [
                    "Bearer " + KEY, "Bearer " + KEY,
                    "Bearer " + ROTATED_KEY, "Bearer " + ROTATED_KEY,
                ])
                for record in provider.requests:
                    self.assertEqual(record["path"], "/v1/systemone")
                    self.assertEqual(set(record["body"]["questions"]), {"target", "page", "step"})
                    self.assertEqual(record["body"]["state"]["page"]["url"], snapshot()["url"])
                    self.assertNotIn("x", record["body"]["state"]["elements"][0])
                    self.assertNotIn("y", record["body"]["state"]["elements"][0])
                    self.assertNotIn(PSK, json.dumps(record))
                for call in relay.calls:
                    self.assertIn("Authorization: Bearer " + PSK, call["headers"])
                    self.assertNotIn(KEY, json.dumps(call))
                    self.assertNotIn(ROTATED_KEY, json.dumps(call))
                for serialized in socket_requests + socket_responses:
                    for secret in (KEY, ROTATED_KEY, PSK):
                        self.assertNotIn(secret, serialized)


if __name__ == "__main__":
    unittest.main()
