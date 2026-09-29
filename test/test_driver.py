"""Driver checks. They do not contact a relay."""

import hashlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
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
        self.curl_configs = []
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

    def respond(self, responses):
        queue = list(responses)

        def run(args, **_kwargs):
            cfg_path = args[args.index("--config") + 1]
            with open(cfg_path, encoding="utf-8") as f:
                self.curl_configs.append(f.read())
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


if __name__ == "__main__":
    unittest.main()
