"""Jev checks. They do not contact TypeSafe or a relay."""

import importlib.util
import io
import json
import os
import tempfile
import unittest
import urllib.error
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "juno_jb_jev_tests", ROOT / "driver" / "jb.py"
)
jb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(jb)

ENV_KEYS = (
    "JUNO_JEV",
    "TYPESAFE_API_KEY",
    "JUNO_JEV_MIN_CONFIDENCE",
    "TYPESAFE_DEFAULT_MODEL",
    "TYPESAFE_BASE_URL",
    "JUNO_BRIDGE_PSK",
)
SECRET = "ts-test-key-9f3a-not-a-real-secret"


class ResponseBody:
    def __init__(self, payload):
        self.raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")

    def read(self):
        return self.raw

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class JevTests(unittest.TestCase):
    def setUp(self):
        self.saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        self._operator_env = os.environ.get("JUNO_OPERATOR")
        os.environ["JUNO_OPERATOR"] = "0"
        self.jev = jb.jev_mod()
        self.old_key_file = self.jev.KEY_FILE
        self.key_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.key_dir.cleanup)
        self.jev.KEY_FILE = os.path.join(self.key_dir.name, "missing-key")
        self.posts = []
        self.actions = []

        def refuse_network(*_args, **_kwargs):
            raise AssertionError("network call")

        for target, name in (
            (self.jev.urllib.request, "urlopen"),
            (self.jev.urllib.request, "build_opener"),
            (jb.subprocess, "run"),
        ):
            patcher = mock.patch.object(target, name, side_effect=refuse_network)
            self.addCleanup(patcher.stop)
            patcher.start()

    def tearDown(self):
        self.jev.KEY_FILE = self.old_key_file
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        if self._operator_env is None:
            os.environ.pop("JUNO_OPERATOR", None)
        else:
            os.environ["JUNO_OPERATOR"] = self._operator_env

    def enable(self, key=SECRET):
        os.environ["JUNO_JEV"] = "1"
        if key is not None:
            os.environ["TYPESAFE_API_KEY"] = key

    def element(self, ref, text, **extra):
        item = {
            "ref": ref,
            "tag": "a",
            "text": text,
            "x": 987654,
            "y": 123456,
            "w": 30,
            "h": 12,
            "inView": True,
            "href": "https://example.com/invoices",
        }
        item.update(extra)
        return item

    def snapshot(self, elements, url="https://example.com/invoices", title="Invoices"):
        return {"ok": True, "data": {"title": title, "url": url, "elements": elements}}

    def answer(self, questions, tokens=1000):
        answers = {}
        for name, choice in questions.items():
            confidence = 0.91
            if isinstance(choice, tuple):
                choice, confidence = choice
            answers[name] = {
                "type": "choice",
                "choice": choice,
                "confidence": confidence,
                "probabilities": {choice: confidence},
            }
        return {
            "model": "jev-1.13.0",
            "usage": {"input_tokens": tokens, "output_tokens": 4},
            "answers": answers,
        }

    def patch_actions(self, responses):
        queue = list(responses)

        def run_action(action, params, device="default"):
            self.actions.append((action, params, device))
            if not queue:
                raise AssertionError("unexpected action " + action)
            return queue.pop(0)

        patcher = mock.patch.object(jb, "run_action", side_effect=run_action)
        self.addCleanup(patcher.stop)
        patcher.start()

    def patch_post(self, response):
        def post(body, key, timeout=30, opener=None):
            self.posts.append((body, key))
            if isinstance(response, Exception):
                raise response
            return response

        patcher = mock.patch.object(self.jev, "post_systemone", side_effect=post)
        self.addCleanup(patcher.stop)
        patcher.start()

    def run_jev(self, *args):
        out = io.StringIO()
        err = io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            code = jb.main(["jb.py", "jev", *args])
        return code, out.getvalue(), err.getvalue()

    def http_error(self, code, body, headers=None):
        hdrs = EmailMessage()
        for name, value in (headers or {}).items():
            hdrs[name] = value
        return urllib.error.HTTPError(
            "https://api.typesafe.ai/v1/systemone",
            code,
            "error",
            hdrs,
            io.BytesIO(body.encode("utf-8")),
        )

    def test_jev_is_off_unless_explicitly_enabled(self):
        for value in (None, "", "0", "true", "yes"):
            if value is None:
                os.environ.pop("JUNO_JEV", None)
            else:
                os.environ["JUNO_JEV"] = value
            code, out, err = self.run_jev(
                "target", "--click", "--tab", "1", "--goal", "Find the invoice"
            )
            self.assertEqual(code, 2, value)
            self.assertEqual(out, "")
            self.assertIn("JUNO_JEV=1", err)
            self.assertIn("0.042", err)
            self.assertIn("did not contact", err)
            self.assertEqual(self.actions, [])
            self.assertEqual(self.posts, [])

    def test_decision_sends_no_coordinates_and_prints_the_estimate(self):
        self.enable()
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        echoed = self.answer({"target": "e1"})
        echoed["model"] = "model-" + SECRET
        self.patch_post(echoed)
        code, out, err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice download page"
        )
        self.assertEqual(code, 0)
        self.assertNotIn(SECRET, out)
        self.assertNotIn(SECRET, err)
        self.assertIn("[redacted]", out)
        report = json.loads(out)
        self.assertTrue(report["billed"])
        self.assertIsNone(report["click"])
        self.assertFalse(report["price"]["invoice"])
        self.assertEqual(report["estimated_usd"], self.jev._estimate(echoed["usage"]))
        self.assertEqual(report["decisions"]["target"]["choice"], "e1")
        self.assertEqual(report["decisions"]["target"]["element"]["x"], 987654)
        body = self.posts[0][0]
        raw = json.dumps(body)
        self.assertNotIn("987654", raw)
        self.assertNotIn("123456", raw)
        self.assertNotIn("x", body["state"]["elements"][0])
        self.assertEqual(body["questions"]["target"]["criteria"]["e1"].count("Invoices"), 1)
        self.assertIn("none", body["questions"]["target"]["criteria"])
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0][1], SECRET)
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])

    def test_named_questions_share_one_request(self):
        self.enable()
        os.environ["TYPESAFE_DEFAULT_MODEL"] = "jev-1.13.0"
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        self.patch_post(self.answer({"target": "e1", "page": "search_results"}))
        code, out, _err = self.run_jev(
            "page", "target", "target", "--tab", "9", "--goal", "Look", "--device", "box"
        )
        self.assertEqual(code, 0)
        body = self.posts[0][0]
        self.assertEqual(set(body["questions"]), {"target", "page"})
        self.assertEqual(body["model"], "jev-1.13.0")
        self.assertEqual(self.actions[0][2], "box")
        self.assertEqual(len(self.posts), 1)
        report = json.loads(out)
        self.assertEqual(report["decisions"]["page"]["choice"], "search_results")
        self.assertNotIn("element", report["decisions"]["page"])

    def test_empty_target_does_not_bill_or_require_a_key(self):
        os.environ["JUNO_JEV"] = "1"
        self.patch_actions([self.snapshot([])])
        code, out, _err = self.run_jev("target", "--tab", "3", "--goal", "Find it")
        self.assertEqual(code, 0)
        report = json.loads(out)
        self.assertFalse(report["billed"])
        self.assertEqual(report["decisions"]["target"]["choice"], "none")
        self.assertIsNone(report["click"])
        self.assertEqual(self.posts, [])

    def test_empty_target_with_click_issues_nothing(self):
        os.environ["JUNO_JEV"] = "1"
        self.patch_actions([self.snapshot([])])
        code, out, _err = self.run_jev(
            "target", "--tab", "3", "--goal", "Find it", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertFalse(report["billed"])
        self.assertFalse(report["click"]["issued"])
        self.assertEqual(self.posts, [])
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])

    def test_page_question_on_an_empty_snapshot_is_billed(self):
        self.enable()
        self.patch_actions([self.snapshot([])])
        self.patch_post(self.answer({"page": "unexpected", "target": "none"}))
        code, _out, _err = self.run_jev(
            "target", "page", "--tab", "3", "--goal", "Find it"
        )
        self.assertEqual(code, 0)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(list(self.posts[0][0]["questions"]["target"]["criteria"]), ["none"])

    def test_step_recover_does_not_run_a_recovery(self):
        self.enable()
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        self.patch_post(self.answer({"step": "recover"}))
        code, out, _err = self.run_jev("step", "--tab", "1", "--goal", "Continue")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["decisions"]["step"]["choice"], "recover")
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])

    def test_click_is_refused_without_a_second_snapshot(self):
        cases = {
            "none": ("none", 0.99),
            "low": ("e1", 0.799),
            "missing": ("e1", None),
            "disabled": ("e1", 0.91),
            "hidden": ("e1", 0.91),
        }
        for name, (choice, confidence) in cases.items():
            with self.subTest(name=name):
                self.posts.clear()
                self.actions.clear()
                self.enable()
                extra = {}
                if name == "disabled":
                    extra["disabled"] = True
                if name == "hidden":
                    extra["inView"] = False
                self.patch_actions([self.snapshot([self.element("e1", "Invoices", **extra)])])
                self.patch_post(self.answer({"target": (choice, confidence)}))
                code, out, err = self.run_jev(
                    "target", "--tab", "7", "--goal", "Find the invoice", "--click"
                )
                self.assertEqual(code, 1)
                self.assertNotIn(SECRET, out + err)
                report = json.loads(out)
                self.assertTrue(report["billed"])
                self.assertFalse(report["click"]["issued"])
                self.assertEqual([item[0] for item in self.actions], ["snapshot"])

    def test_click_uses_fresh_coordinates_after_a_matching_snapshot(self):
        self.enable()
        fresh = self.element("e7", "Invoices", x=400, y=50)
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")]),
            self.snapshot([fresh]),
            {"ok": True, "data": {"clicked": True}},
        ])
        self.patch_post(self.answer({"target": ("e1", 0.8)}))
        code, out, err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice download page", "--click"
        )
        self.assertEqual(code, 0)
        self.assertNotIn(SECRET, out + err)
        report = json.loads(out)
        self.assertTrue(report["click"]["issued"])
        self.assertEqual(report["click"]["ref"], "e7")
        self.assertEqual(self.actions[2][0], "click")
        self.assertEqual(self.actions[2][1], {"tabId": 7, "x": 400, "y": 50})
        self.assertEqual(len(self.posts), 1)

    def test_click_stops_when_the_fresh_page_does_not_match(self):
        self.enable()
        original = self.element("e1", "Invoices")
        moved = self.snapshot(
            [self.element("e4", "Invoices", x=8, y=9)],
            url="https://example.com/other",
        )
        twin = self.snapshot([
            self.element("e4", "Invoices", x=8, y=9),
            self.element("e5", "Invoices", x=10, y=11),
        ])
        outside = self.snapshot([
            self.element("e4", "Invoices", x=8, y=9, inView=False),
        ])
        for fresh in (moved, twin, outside):
            with self.subTest(url=fresh["data"]["url"], count=len(fresh["data"]["elements"])):
                self.posts.clear()
                self.actions.clear()
                self.patch_actions([
                    self.snapshot([original]),
                    fresh,
                ])
                self.patch_post(self.answer({"target": "e1"}))
                code, out, _err = self.run_jev(
                    "target", "--tab", "7", "--goal", "Find the invoice", "--click"
                )
                self.assertEqual(code, 1)
                report = json.loads(out)
                self.assertTrue(report["billed"])
                self.assertFalse(report["click"]["issued"])
                self.assertEqual([item[0] for item in self.actions], ["snapshot", "snapshot"])

    def test_a_failed_click_stays_a_failure_after_it_was_issued(self):
        self.enable()
        fresh = self.element("e7", "Invoices", x=400, y=50)
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")]),
            self.snapshot([fresh]),
            {"ok": False, "error": "cancelled: extension paused"},
        ])
        self.patch_post(self.answer({"target": "e1"}))
        code, out, _err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertTrue(report["click"]["issued"])
        self.assertFalse(report["ok"])
        self.assertEqual(self.actions[2][0], "click")

    def test_a_failed_fresh_snapshot_does_not_click(self):
        self.enable()
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")]),
            {"ok": False, "error": "cancelled: extension paused"},
        ])
        self.patch_post(self.answer({"target": "e1"}))
        code, out, _err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertTrue(report["billed"])
        self.assertEqual(report["click"]["reason"], "fresh snapshot failed")
        self.assertEqual([item[0] for item in self.actions], ["snapshot", "snapshot"])

    def test_snapshot_failure_does_not_call_typesafe(self):
        self.enable()
        self.patch_actions([{"ok": False, "error": "snapshot: tabId required"}])
        code, out, _err = self.run_jev("target", "--tab", "1", "--goal", "Find it")
        self.assertEqual(code, 1)
        self.assertIn("tabId required", out)
        self.assertEqual(self.posts, [])

    def test_missing_key_exits_after_the_snapshot_and_does_not_post(self):
        os.environ["JUNO_JEV"] = "1"
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            with self.assertRaises(SystemExit) as caught:
                jb.main(["jb.py", "jev", "target", "--tab", "1", "--goal", "Find it"])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("TYPESAFE_API_KEY", err.getvalue())
        self.assertNotIn(SECRET, err.getvalue())
        self.assertEqual(self.posts, [])
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])

    def test_bad_usage_does_not_snapshot(self):
        self.enable()
        cases = (
            ["target", "--tab", "1", "--goal", "x" * 501],
            ["page", "--tab", "1", "--goal", "hi", "--click"],
            ["target", "--tab", "nope", "--goal", "hi"],
            ["target", "--tab", "1", "--goal", "   "],
        )
        for args in cases:
            with self.subTest(args=args):
                self.actions.clear()
                with self.assertRaises(SystemExit) as caught:
                    jb.main(["jb.py", "jev", *args])
                self.assertEqual(caught.exception.code, 2)
                self.assertEqual(self.actions, [])
                self.assertEqual(self.posts, [])

    def test_bad_confidence_gate_is_checked_only_for_click(self):
        self.enable()
        os.environ["JUNO_JEV_MIN_CONFIDENCE"] = "nope"
        with self.assertRaises(SystemExit) as caught:
            jb.main([
                "jb.py", "jev", "target", "--tab", "1", "--goal", "Find it", "--click",
            ])
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(self.actions, [])
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        self.patch_post(self.answer({"target": "none"}))
        code, out, _err = self.run_jev("target", "--tab", "1", "--goal", "Find it")
        self.assertEqual(code, 0)
        self.assertIsNone(json.loads(out)["click"])

    def test_unknown_choice_is_an_error_and_hides_the_key(self):
        self.enable()
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        self.patch_post(self.answer({"target": "e999"}))
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            with self.assertRaises(SystemExit) as caught:
                jb.main(["jb.py", "jev", "target", "--tab", "1", "--goal", "Find it"])
        self.assertEqual(caught.exception.code, 1)
        self.assertNotIn(SECRET, err.getvalue())
        self.assertIn("e999", err.getvalue())

    def test_candidate_list_keeps_in_view_elements_and_reserves_none(self):
        elements = [self.element("o%d" % i, "out%d" % i, inView=False) for i in range(100)]
        elements.extend(self.element("v%d" % i, "in%d" % i, inView=True) for i in range(200))
        prepared = self.jev.prepare(
            {"title": "T", "url": "https://example.com/a", "elements": elements},
            ["target"],
            "pick",
        )
        public = prepared["body"]["state"]["elements"]
        self.assertEqual(len(public), 254)
        self.assertEqual(prepared["omitted"], 46)
        self.assertEqual(public[0]["ref"], "v0")
        self.assertEqual(public[199]["ref"], "v199")
        self.assertEqual(public[200]["ref"], "o0")
        criteria = prepared["body"]["questions"]["target"]["criteria"]
        self.assertEqual(len(criteria), 255)
        self.assertIn("none", criteria)
        self.assertNotIn("o54", criteria)
        self.assertNotIn("x", public[0])

    def test_http_error_hides_the_key_and_does_not_retry(self):
        calls = []

        def opener(req, timeout=30):
            calls.append(req.full_url)
            self.assertEqual(req.get_header("Authorization"), "Bearer " + SECRET)
            raise self.http_error(401, "invalid " + SECRET)

        with self.assertRaises(self.jev.JevError) as caught:
            self.jev.post_systemone({"model": "jev-latest"}, SECRET, opener=opener)
        self.assertEqual(calls, ["https://api.typesafe.ai/v1/systemone"])
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertIn("[redacted]", str(caught.exception))

    def test_rate_limit_retries_once_and_caps_the_wait(self):
        calls = []

        def opener(req, timeout=30):
            calls.append(req.get_header("Authorization"))
            if len(calls) == 1:
                raise self.http_error(429, "slow " + SECRET, {"Retry-After": "9"})
            return ResponseBody({
                "model": "jev-1.13.0",
                "answers": {},
                "usage": {"input_tokens": 1, "output_tokens": 0},
            })

        with mock.patch.object(self.jev.time, "sleep") as sleep:
            parsed = self.jev.post_systemone({"model": "jev-latest"}, SECRET, opener=opener)
        self.assertEqual(len(calls), 2)
        sleep.assert_called_once_with(2)
        self.assertEqual(parsed["model"], "jev-1.13.0")
        self.assertNotIn(SECRET, json.dumps(parsed))

    def test_overloaded_response_retries_once(self):
        calls = []

        def opener(_req, timeout=30):
            calls.append(1)
            if len(calls) == 1:
                raise self.http_error(529, "busy")
            return ResponseBody({"answers": {}, "usage": {}})

        with mock.patch.object(self.jev.time, "sleep") as sleep:
            parsed = self.jev.post_systemone({}, SECRET, opener=opener)
        self.assertEqual(calls, [1, 1])
        sleep.assert_called_once()
        self.assertIsInstance(parsed, dict)

    def test_redirect_is_refused_without_the_target(self):
        with self.assertRaises(self.jev.JevError) as caught:
            self.jev._NoRedirect().redirect_request(
                None, None, 302, "Found", {}, "https://evil.example/steal"
            )
        self.assertNotIn("evil.example", str(caught.exception))
        self.assertIn("302", str(caught.exception))

    def test_non_json_success_is_not_retried(self):
        calls = []

        def opener(_req, timeout=30):
            calls.append(1)
            return ResponseBody(b"nope " + SECRET.encode("utf-8"))

        with self.assertRaises(self.jev.JevError) as caught:
            self.jev.post_systemone({}, SECRET, opener=opener)
        self.assertEqual(calls, [1])
        self.assertNotIn(SECRET, str(caught.exception))

    def test_base_url_is_the_documented_default_and_can_be_overridden(self):
        seen = {}

        def opener(req, timeout=30):
            seen["url"] = req.full_url
            return ResponseBody({"answers": {}, "usage": {}})

        self.jev.post_systemone({}, SECRET, opener=opener)
        self.assertEqual(seen["url"], "https://api.typesafe.ai/v1/systemone")
        os.environ["TYPESAFE_BASE_URL"] = "https://example.test/root/"
        self.jev.post_systemone({}, SECRET, opener=opener)
        self.assertEqual(seen["url"], "https://example.test/root/v1/systemone")

    def test_key_file_must_be_private_and_is_not_in_the_error(self):
        path = os.path.join(self.key_dir.name, "typesafe-key")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(SECRET + "\n")
        os.chmod(path, 0o644)
        self.jev.KEY_FILE = path
        with self.assertRaises(ValueError) as caught:
            self.jev.api_key()
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertIn("chmod 600", str(caught.exception))
        os.chmod(path, 0o600)
        self.assertEqual(self.jev.api_key(), SECRET)

    def test_confidence_must_be_a_real_number(self):
        element = self.element("e1", "Invoices")
        for confidence in (float("nan"), True, False, "0.9"):
            reason = self.jev.click_refusal(
                {"choice": "e1", "confidence": confidence, "element": element},
                0.8,
            )
            self.assertIsNotNone(reason, confidence)

    def test_send_does_not_call_jev_when_it_is_enabled(self):
        self.enable()
        os.environ["JUNO_BRIDGE_PSK"] = "correct-horse-battery"
        config = os.path.join(self.key_dir.name, "config.json")
        jb.CONFIG_DIR = self.key_dir.name
        jb.CONFIG_FILE = config
        jb.PSK_FILE = os.path.join(self.key_dir.name, "no-psk")
        with open(config, "w", encoding="utf-8") as handle:
            json.dump({"relay_url": "https://relay.example"}, handle)
        result = {"ok": True, "data": {"version": "1.3.0"}}

        def run(_args, **_kwargs):
            proc = mock.Mock()
            proc.returncode = 0
            proc.stdout = json.dumps({
                "ok": True,
                "pending": False,
                "id": "cmd_" + "ab" * 8,
                "result": result,
            }) + "\nHTTPSTATUS:200"
            proc.stderr = ""
            return proc

        self.patch_post(self.answer({"target": "e1"}))
        with mock.patch.object(jb.subprocess, "run", side_effect=run):
            out = io.StringIO()
            with mock.patch("sys.stdout", out):
                code = jb.main(["jb.py", "send", "ping", "{}"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue()), result)
        self.assertEqual(self.posts, [])
