"""Driver checks. They do not contact a relay."""

import hashlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
import stat
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("jb", ROOT / "driver" / "jb.py")
jb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(jb)


class DriverTests(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.get("JUNO_BRIDGE_PSK")
        self.psk = "correct-horse-battery"
        os.environ["JUNO_BRIDGE_PSK"] = self.psk
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._operator_env = os.environ.get("JUNO_OPERATOR")
        os.environ["JUNO_OPERATOR"] = "0"
        self.curl_configs = []
        self.curl_bodies = []
        cfg = os.path.join(self.tmp.name, "config.json")
        jb.CONFIG_DIR = self.tmp.name
        jb.CONFIG_FILE = cfg
        jb.PSK_FILE = os.path.join(self.tmp.name, "no-psk")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"relay_url": "https://relay.example"}, f)

    def tearDown(self):
        if self._env is None:
            os.environ.pop("JUNO_BRIDGE_PSK", None)
        else:
            os.environ["JUNO_BRIDGE_PSK"] = self._env
        if self._operator_env is None:
            os.environ.pop("JUNO_OPERATOR", None)
        else:
            os.environ["JUNO_OPERATOR"] = self._operator_env

    def respond(self, responses):
        queue = list(responses)

        def run(args, **_kwargs):
            cfg_path = args[args.index("--config") + 1]
            with open(cfg_path, encoding="utf-8") as f:
                text = f.read()
            self.curl_configs.append(text)
            body = None
            for line in text.splitlines():
                if line.startswith("data-binary"):
                    data_path = line.split("@", 1)[1].strip().strip('"')
                    with open(data_path, encoding="utf-8") as bf:
                        body = json.load(bf)
            self.curl_bodies.append(body)
            if not queue:
                raise AssertionError("unexpected curl call")
            status, payload = queue.pop(0)
            proc = mock.Mock()
            proc.returncode = 0
            proc.stdout = json.dumps(payload) + "\nHTTPSTATUS:%d" % status
            proc.stderr = ""
            return proc

        patcher = mock.patch.object(jb.subprocess, "run", side_effect=run)
        self.addCleanup(patcher.stop)
        patcher.start()

    def test_send_failure_exits_nonzero_and_prints_the_result(self):
        result = {"ok": False, "error": "click: tabId required"}
        self.respond([
            (200, {"ok": True, "pending": False, "id": "cmd_" + "ab" * 8, "result": result}),
        ])
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            code = jb.main(["jb.py", "send", "click", '{"tabId":7,"x":1,"y":2}'])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue()), result)
        self.assertIn("/admin/run", self.curl_configs[0])

    def test_send_success_exits_zero(self):
        result = {"ok": True, "data": {"version": "1.3.0"}}
        self.respond([
            (200, {"ok": True, "pending": False, "id": "cmd_" + "cd" * 8, "result": result}),
        ])
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            code = jb.main(["jb.py", "send", "ping", "{}"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue()), result)


    def test_polled_failure_exits_nonzero(self):
        result = {"ok": False, "error": "boom"}
        self.respond([
            (200, {"ok": True, "pending": True, "id": "cmd_" + "ef" * 8}),
            (200, {"pending": False, "result": result}),
        ])
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            code = jb.main(["jb.py", "send", "ping", "{}"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue()), result)
        self.assertEqual(len(self.curl_configs), 2)
        self.assertIn("/admin/result", self.curl_configs[1])

    def test_bootstrap_prints_the_hash_and_does_not_call_the_relay(self):
        def run(*_args, **_kwargs):
            raise AssertionError("bootstrap tried to use the network")

        with mock.patch.object(jb.subprocess, "run", side_effect=run):
            out = io.StringIO()
            with mock.patch("sys.stdout", out):
                code = jb.main(["jb.py", "bootstrap"])
        text = out.getvalue()
        digest = hashlib.sha256(self.psk.encode("utf-8")).hexdigest()
        self.assertEqual(code, 0)
        self.assertIn(digest, text)
        self.assertIn("ADMIN_PSK_SHA256", text)
        self.assertIn("npx wrangler secret put ADMIN_PSK_SHA256", text)
        self.assertNotIn("/admin/bootstrap", text)
        self.assertNotIn(self.psk, text)

    def test_short_passphrase_is_refused(self):
        os.environ["JUNO_BRIDGE_PSK"] = "0123456789abcde"  # 15
        with self.assertRaises(SystemExit) as cm:
            jb.main(["jb.py", "bootstrap"])
        self.assertEqual(cm.exception.code, 2)

    def test_sixteen_character_passphrase_is_accepted(self):
        os.environ["JUNO_BRIDGE_PSK"] = "0123456789abcdef"
        def run(*_args, **_kwargs):
            raise AssertionError("bootstrap tried to use the network")

        with mock.patch.object(jb.subprocess, "run", side_effect=run):
            out = io.StringIO()
            with mock.patch("sys.stdout", out):
                code = jb.main(["jb.py", "bootstrap"])
        self.assertEqual(code, 0)
        digest = hashlib.sha256(b"0123456789abcdef").hexdigest()
        self.assertIn(digest, out.getvalue())

    def test_request_id_is_reused_on_fallback_and_fresh_for_the_next_action(self):
        cmd_id = "cmd_" + "aa" * 8
        self.respond([
            (404, {"error": "not_found"}),
            (200, {"ok": True, "id": cmd_id}),
            (200, {"pending": False, "result": {"ok": True, "data": {"n": 1}}}),
            (200, {"ok": True, "pending": False, "id": "cmd_" + "bb" * 8, "result": {"ok": True, "data": {"n": 2}}}),
        ])
        self.assertEqual(jb.main(["jb.py", "send", "click", '{"tabId":7,"x":1,"y":2}']), 0)
        self.assertEqual(jb.main(["jb.py", "send", "click", '{"tabId":7,"x":3,"y":4}']), 0)
        posted = [body for body in self.curl_bodies if body is not None]
        self.assertEqual([body["request_id"] for body in posted[:2]], [posted[0]["request_id"], posted[0]["request_id"]])
        self.assertNotEqual(posted[0]["request_id"], posted[2]["request_id"])
        self.assertRegex(posted[0]["request_id"], r"^req_[0-9a-f]{16}$")
        self.assertRegex(posted[2]["request_id"], r"^req_[0-9a-f]{16}$")
        self.assertIn("/admin/run", self.curl_configs[0])
        self.assertIn("/admin/cmd", self.curl_configs[1])
        self.assertIn("/admin/result?id=" + cmd_id, self.curl_configs[2])
        self.assertIn("/admin/run", self.curl_configs[3])
        self.assertIsNone(self.curl_bodies[2])
        self.assertNotIn(self.psk, json.dumps(posted[0]))
        self.assertEqual(posted[0]["action"], "click")
        self.assertEqual(posted[1]["action"], "click")
        self.assertNotIn("wait", posted[1])


class JevSettingsTests(unittest.TestCase):
    """Exercise the user-facing toggle with isolated settings and no API calls."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"JUNO_JEV_CONFIG_DIR": self.tmp.name}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.mod = jb.jev_mod()
        self.config = self.mod.config_mod()
        for obj, name in ((jb, "run_action"), (self.mod, "post_systemone")):
            patcher = mock.patch.object(obj, name, side_effect=AssertionError("unexpected network/action"))
            patcher.start()
            self.addCleanup(patcher.stop)

    def invoke(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            result = jb.main(["jb.py", "jev", *args])
        return result, out.getvalue(), err.getvalue()

    def test_status_is_off_and_has_no_key_by_default(self):
        code, output, _ = self.invoke("status")
        report = json.loads(output)
        self.assertEqual(code, 0)
        self.assertFalse(report["enabled"])
        self.assertFalse(report["key_present"])

    def test_hidden_configure_then_on_and_off_preserve_the_users_settings(self):
        secret = "test-only-user-key-not-a-real-credential"
        self.config.update_settings({"relay_url": "https://relay.example", "custom": "keep"})
        with mock.patch.object(jb.sys.stdin, "isatty", return_value=True), \
                mock.patch.object(jb.getpass, "getpass", return_value=secret) as prompt:
            code, output, _ = self.invoke("configure")
        self.assertEqual(code, 0)
        prompt.assert_called_once()
        self.assertNotIn(secret, output)
        self.assertFalse(self.config.enabled())
        self.assertEqual(stat.S_IMODE(self.config.key_path().stat().st_mode), 0o600)
        self.assertNotIn(secret, self.config.config_path().read_text())
        code, output, _ = self.invoke("on")
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output)["enabled"])
        self.assertNotIn(secret, output)
        self.assertEqual(self.config.settings()["custom"], "keep")
        self.invoke("off")
        self.assertFalse(self.config.enabled())
        self.assertEqual(self.config.settings()["relay_url"], "https://relay.example")

    def test_on_without_own_key_fails_before_enabling(self):
        with self.assertRaises(SystemExit) as raised, mock.patch("sys.stderr", io.StringIO()):
            self.invoke("on")
        self.assertEqual(raised.exception.code, 2)
        self.assertFalse(self.config.enabled())

    def test_noninteractive_configure_cannot_echo_a_key(self):
        with mock.patch.object(jb.sys.stdin, "isatty", return_value=False), \
                mock.patch.object(jb.getpass, "getpass") as prompt, \
                self.assertRaises(SystemExit) as raised:
            self.invoke("configure")
        self.assertEqual(raised.exception.code, 2)
        prompt.assert_not_called()
        self.assertFalse(self.config.key_path().exists())

    def test_api_key_is_not_accepted_as_a_command_line_argument(self):
        secret = "test-only-key-not-for-argv"
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err), \
                self.assertRaises(SystemExit) as raised:
            jb.main(["jb.py", "jev", "configure", secret])
        self.assertEqual(raised.exception.code, 2)
        self.assertNotIn(secret, out.getvalue() + err.getvalue())
        self.assertFalse(self.config.key_path().exists())

    def test_jev_report_redacts_escaped_keys_before_json_serialization(self):
        secret = 'test-only-key-"-\\-not-real'
        report = {"ok": True, "goal": secret, "nested": [{secret: "echo " + secret}]}
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            self.assertEqual(jb.finish_jev(report, secret), 0)
        rendered = json.loads(out.getvalue())
        self.assertEqual(rendered["goal"], "[redacted]")
        self.assertEqual(rendered["nested"], [{"[redacted]": "echo [redacted]"}])
        self.assertNotIn(secret, str(rendered))

    def test_env_override_is_reported_when_the_saved_toggle_is_changed(self):
        self.config.write_api_key("test-only-own-key")
        os.environ["JUNO_JEV"] = "1"
        _, output, err = self.invoke("off")
        report = json.loads(output)
        self.assertFalse(report["persisted_enabled"])
        self.assertTrue(report["enabled"])
        self.assertIn("overrides the saved toggle", err)

    def test_relay_init_preserves_jev_preference_and_private_config_mode(self):
        path = self.config.config_path()
        self.config.update_settings({"jev_enabled": True, "custom": "keep"})
        with mock.patch.object(jb, "CONFIG_FILE", str(path)), mock.patch("sys.stdout", io.StringIO()):
            jb.main(["jb.py", "init", "https://another-relay.example"])
        saved = self.config.settings()
        self.assertTrue(saved["jev_enabled"])
        self.assertEqual(saved["custom"], "keep")
        self.assertEqual(saved["relay_url"], "https://another-relay.example")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)



if __name__ == "__main__":
    unittest.main()
