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
            (self.jev.http.client, "HTTPSConnection"),
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

    def _force_operator(self):
        saved = {
            "JUNO_BRIDGE_HTTP": os.environ.get("JUNO_BRIDGE_HTTP"),
            "JUNO_OPERATOR_CHILD": os.environ.get("JUNO_OPERATOR_CHILD"),
        }

        def restore():
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.addCleanup(restore)
        os.environ.pop("JUNO_BRIDGE_HTTP", None)
        os.environ.pop("JUNO_OPERATOR_CHILD", None)
        os.environ["JUNO_OPERATOR"] = "1"

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

    def snapshot(self, elements, url="https://example.com/invoices", title="Invoices", snapshot=None):
        data = {"title": title, "url": url, "elements": elements}
        if snapshot is not None:
            data["snapshot"] = snapshot
        return {"ok": True, "data": data}

    def snap_id(self, digit="a"):
        return "snap_" + (digit * 32)

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

    def test_click_submits_the_same_snapshot_and_returns_its_observation(self):
        self.enable()
        snap = self.snap_id("a")
        observed = {
            "observe": "snapshot",
            "observed": True,
            "snapshot": self.snap_id("b"),
            "url": "https://example.com/invoices",
            "elements": [],
            "redaction": "heuristic",
        }
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")], snapshot=snap),
            {
                "ok": True,
                "data": {
                    "status": "completed",
                    "dispatched": True,
                    "observation": observed,
                    "steps": [{"op": "click", "status": "completed"}],
                },
            },
        ])
        self.patch_post(self.answer({"target": ("e1", 0.8)}))
        code, out, err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice download page", "--click"
        )
        self.assertEqual(code, 0)
        self.assertNotIn(SECRET, out + err)
        report = json.loads(out)
        self.assertTrue(report["click"]["issued"])
        self.assertEqual(report["click"]["ref"], "e1")
        self.assertEqual(report["click"]["snapshot"], snap)
        self.assertEqual(report["click"]["observation"], observed)
        self.assertEqual([item[0] for item in self.actions], ["snapshot", "workflow"])
        self.assertEqual(self.actions[1][1], {
            "tabId": 7,
            "snapshot": snap,
            "steps": [{
                "op": "click",
                "ref": "e1",
                "after": {"observe": "snapshot"},
                "expect": {"tag": "a", "text": "Invoices"},
            }],
        })
        self.assertNotIn("x", self.posts[0][0]["state"]["elements"][0])
        self.assertEqual(len(self.posts), 1)

    def test_a_stale_snapshot_is_refused_without_a_coordinate_click(self):
        self.enable()
        snap = self.snap_id("c")
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")], snapshot=snap),
            {
                "ok": False,
                "error": "workflow: snapshot is stale",
                "data": {
                    "status": "failed",
                    "dispatched": False,
                    "steps": [{"status": "unstarted"}],
                },
            },
        ])
        self.patch_post(self.answer({"target": "e1"}))
        code, out, _err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertTrue(report["billed"])
        self.assertFalse(report["click"]["issued"])
        self.assertTrue(report["click"]["submitted"])
        self.assertEqual(report["click"]["reason"], "workflow: snapshot is stale")
        self.assertEqual([item[0] for item in self.actions], ["snapshot", "workflow"])
        self.assertNotIn("click", [item[0] for item in self.actions])
        self.assertEqual(len(self.posts), 1)

    def test_a_failed_click_stays_a_failure_after_it_was_issued(self):
        self.enable()
        snap = self.snap_id("d")
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")], snapshot=snap),
            {
                "ok": False,
                "error": "cancelled: extension paused",
                "data": {"dispatched": True, "status": "interrupted", "steps": [{"status": "interrupted"}]},
            },
        ])
        self.patch_post(self.answer({"target": "e1"}))
        code, out, _err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertTrue(report["click"]["issued"])
        self.assertNotIn("reason", report["click"])
        self.assertFalse(report["ok"])
        self.assertEqual([item[0] for item in self.actions], ["snapshot", "workflow"])

    def test_a_snapshot_without_an_id_does_not_submit_a_workflow(self):
        self.enable()
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        self.patch_post(self.answer({"target": "e1"}))
        code, out, _err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertTrue(report["billed"])
        self.assertIn("snapshot id", report["click"]["reason"])
        self.assertFalse(report["click"]["issued"])
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])
        self.assertEqual(len(self.posts), 1)

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

    def test_a_stopping_step_does_not_submit_the_workflow(self):
        snap = self.snap_id("e")
        for label in ("escalate", "observe", "recover"):
            with self.subTest(label=label):
                self.posts.clear()
                self.actions.clear()
                self.enable()
                self.patch_actions([
                    self.snapshot([self.element("e1", "Invoices")], snapshot=snap),
                ])
                self.patch_post(self.answer({
                    "target": ("e1", 0.95),
                    "page": "search_results",
                    "step": label,
                }))
                code, out, _err = self.run_jev(
                    "target", "page", "step", "--tab", "7", "--goal", "Find the invoice", "--click"
                )
                self.assertEqual(code, 1)
                report = json.loads(out)
                self.assertEqual(report["click"]["handoff"], label)
                self.assertFalse(report["click"]["issued"])
                self.assertEqual([item[0] for item in self.actions], ["snapshot"])
                self.assertEqual(len(self.posts), 1)
                self.assertEqual(
                    set(self.posts[0][0]["questions"]),
                    {"target", "page", "step"},
                )
                if label == "recover":
                    self.assertIn("no recovery was run", report["click"]["reason"])

    def test_a_blocking_page_does_not_click_and_other_does(self):
        snap = self.snap_id("f")
        self.enable()
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")], snapshot=snap)])
        self.patch_post(self.answer({"target": ("e1", 0.95), "page": "login_required"}))
        code, out, _err = self.run_jev(
            "target", "page", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertEqual(report["click"]["handoff"], "login_required")
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])

        self.posts.clear()
        self.actions.clear()
        observed = {"observe": "snapshot", "snapshot": self.snap_id("1"), "url": "https://example.com/invoices"}
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")], snapshot=snap),
            {"ok": True, "data": {"dispatched": True, "observation": observed, "steps": [{"status": "completed"}]}},
        ])
        self.patch_post(self.answer({"target": ("e1", 0.95), "page": "other"}))
        code, out, _err = self.run_jev(
            "target", "page", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 0)
        report = json.loads(out)
        self.assertTrue(report["click"]["issued"])
        self.assertEqual(report["click"]["observation"], observed)
        self.assertEqual([item[0] for item in self.actions], ["snapshot", "workflow"])
        self.assertEqual(len(self.posts), 1)

    def write_observation(self, payload):
        path = os.path.join(self.key_dir.name, "observation.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        return path

    def test_an_observation_file_is_reused_for_one_decision_and_one_workflow(self):
        self.enable()
        snap = self.snap_id("2")
        data = {
            "title": "Invoices",
            "url": "https://example.com/invoices",
            "snapshot": snap,
            "elements": [self.element("e1", "Invoices")],
        }
        path = self.write_observation({"ok": True, "data": data})
        observed = {"observe": "snapshot", "snapshot": self.snap_id("3"), "elements": []}
        self.patch_actions([{
            "ok": True,
            "data": {"dispatched": True, "observation": observed, "steps": [{"status": "completed"}]},
        }])
        self.patch_post(self.answer({"target": ("e1", 0.91)}))
        code, out, err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice",
            "--observation", path, "--click",
        )
        self.assertEqual(code, 0)
        self.assertNotIn(SECRET, out + err)
        report = json.loads(out)
        self.assertEqual([item[0] for item in self.actions], ["workflow"])
        self.assertEqual(self.actions[0][1]["snapshot"], snap)
        self.assertEqual(self.actions[0][1]["steps"][0]["ref"], "e1")
        self.assertEqual(self.actions[0][1]["steps"][0]["after"], {"observe": "snapshot"})
        self.assertNotIn("x", self.actions[0][1]["steps"][0])
        self.assertEqual(report["click"]["observation"], observed)
        self.assertEqual(len(self.posts), 1)

    def test_a_bad_observation_is_refused_before_the_model_call(self):
        self.enable()
        self.patch_post(self.answer({"target": "e1"}))
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        bad = self.write_observation({
            "data": {
                "snapshot": "snap_00000001",
                "url": "https://example.com/invoices",
                "elements": [self.element("e1", "Invoices")],
            },
        })
        missing = os.path.join(self.key_dir.name, "missing-observation.json")
        for path in (bad, missing):
            with self.subTest(path=path):
                self.posts.clear()
                self.actions.clear()
                err = io.StringIO()
                with mock.patch("sys.stderr", err):
                    with self.assertRaises(SystemExit) as caught:
                        jb.main([
                            "jb.py", "jev", "target", "--tab", "7", "--goal", "Find the invoice",
                            "--observation", path, "--click",
                        ])
                self.assertEqual(caught.exception.code, 2)
                self.assertNotIn(SECRET, err.getvalue())
                self.assertEqual(self.posts, [])
                self.assertEqual(self.actions, [])

    def test_a_reused_empty_observation_does_not_call_the_model(self):
        os.environ["JUNO_JEV"] = "1"
        snap = self.snap_id("4")
        path = self.write_observation({
            "snapshot": snap,
            "url": "https://example.com/invoices",
            "elements": [],
        })
        self.patch_post(self.answer({"target": "e1"}))
        code, out, _err = self.run_jev(
            "target", "--tab", "3", "--goal", "Find it", "--observation", path, "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertFalse(report["billed"])
        self.assertFalse(report["click"]["issued"])
        self.assertEqual(self.posts, [])
        self.assertEqual(self.actions, [])

    def test_the_operator_client_is_used_when_the_operator_is_on(self):
        self.enable()
        self._force_operator()
        snap = self.snap_id("5")
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")], snapshot=snap)])
        self.patch_post(self.answer({"target": "e1"}))
        calls = []
        op = jb.operator_mod()

        def systemone(body, timeout=30):
            calls.append(json.dumps(body))
            return self.answer({"target": "e1"})

        with mock.patch.object(op, "systemone", side_effect=systemone):
            code, out, err = self.run_jev("target", "--tab", "1", "--goal", "Find it")
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertNotIn(SECRET, calls[0] + out + err)
        self.assertEqual(self.posts, [])
        self.assertIsNone(json.loads(out)["click"])

    def test_a_missing_operator_key_exits_before_a_click(self):
        os.environ["JUNO_JEV"] = "1"
        self._force_operator()
        snap = self.snap_id("6")
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")], snapshot=snap)])
        self.patch_post(self.answer({"target": "e1"}))
        op = jb.operator_mod()
        calls = []

        def systemone(body, timeout=30):
            calls.append(body)
            raise op.OperatorError("no TypeSafe API key — set TYPESAFE_API_KEY")

        with mock.patch.object(op, "systemone", side_effect=systemone):
            err = io.StringIO()
            with mock.patch("sys.stderr", err):
                with self.assertRaises(SystemExit) as caught:
                    jb.main([
                        "jb.py", "jev", "target", "--tab", "1", "--goal", "Find it", "--click",
                    ])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("TYPESAFE_API_KEY", err.getvalue())
        self.assertEqual(len(calls), 1)
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])
        self.assertEqual(self.posts, [])

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

    def test_the_typesafe_session_reuses_one_verified_connection(self):
        instances = []

        class FakeResponse:
            def __init__(self, status, body, headers=None):
                self.status = status
                self.headers = headers or {}
                self._body = body

            def read(self):
                return self._body

        class FakeConn:
            def __init__(self, host, port=None, timeout=None, context=None):
                instances.append(self)
                self.host = host
                self.port = port
                self.timeout = timeout
                self.context = context
                self.requests = []
                self.closed = False

            def request(self, method, path, body=None, headers=None):
                self.requests.append((method, path, headers))

            def getresponse(self):
                return FakeResponse(200, b'{"answers":{},"usage":{}}')

            def close(self):
                self.closed = True

        with mock.patch.object(self.jev.http.client, "HTTPSConnection", FakeConn):
            session = self.jev.TypeSafeSession()
            first = session.post({"n": 1}, SECRET)
            second = session.post({"n": 2}, SECRET)
            session.close()
        self.assertEqual(first["answers"], {})
        self.assertEqual(second["answers"], {})
        self.assertEqual(len(instances), 1)
        self.assertEqual(len(instances[0].requests), 2)
        self.assertEqual(instances[0].host, "api.typesafe.ai")
        self.assertTrue(instances[0].context.check_hostname)
        self.assertEqual(instances[0].context.verify_mode, self.jev.ssl.CERT_REQUIRED)
        self.assertTrue(instances[0].closed)
        for _method, path, headers in instances[0].requests:
            self.assertEqual(path, "/v1/systemone")
            self.assertEqual(headers["Authorization"], "Bearer " + SECRET)

    def test_the_typesafe_session_refuses_a_redirect_and_retries_429_once(self):
        class FakeResponse:
            def __init__(self, status, body, headers=None):
                self.status = status
                self.headers = headers or {}
                self._body = body

            def read(self):
                return self._body

        created = []

        class RedirectConn:
            def __init__(self, host, port=None, timeout=None, context=None):
                created.append(self)
                self.requests = 0

            def request(self, method, path, body=None, headers=None):
                self.requests += 1

            def getresponse(self):
                return FakeResponse(302, b"", {"Location": "https://evil.example/steal"})

            def close(self):
                return None

        with mock.patch.object(self.jev.http.client, "HTTPSConnection", RedirectConn):
            session = self.jev.TypeSafeSession()
            with self.assertRaises(self.jev.JevError) as caught:
                session.post({"n": 1}, SECRET)
            session.close()
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].requests, 1)
        self.assertNotIn("evil.example", str(caught.exception))
        self.assertIn("302", str(caught.exception))

        instances = []

        class RetryConn:
            def __init__(self, host, port=None, timeout=None, context=None):
                instances.append(self)
                self.n = 0

            def request(self, method, path, body=None, headers=None):
                self.n += 1

            def getresponse(self):
                if self.n == 1:
                    return FakeResponse(429, ("slow " + SECRET).encode("utf-8"), {"Retry-After": "9"})
                return FakeResponse(200, b'{"answers":{}}')

            def close(self):
                return None

        with mock.patch.object(self.jev.http.client, "HTTPSConnection", RetryConn):
            with mock.patch.object(self.jev.time, "sleep") as sleep:
                session = self.jev.TypeSafeSession()
                parsed = session.post({"n": 1}, SECRET)
                session.close()
        self.assertEqual(len(instances), 1)
        self.assertEqual(instances[0].n, 2)
        sleep.assert_called_once_with(2)
        self.assertEqual(parsed["answers"], {})
        self.assertNotIn(SECRET, json.dumps(parsed))

    def test_a_dropped_typesafe_connection_is_not_posted_again(self):
        created = []

        class ResetConn:
            def __init__(self, host, port=None, timeout=None, context=None):
                created.append(self)
                self.context = context
                self.n = 0

            def request(self, method, path, body=None, headers=None):
                self.n += 1
                raise OSError("reset " + SECRET)

            def getresponse(self):
                raise AssertionError("response after a dropped connection")

            def close(self):
                return None

        with mock.patch.object(self.jev.http.client, "HTTPSConnection", ResetConn):
            session = self.jev.TypeSafeSession()
            with self.assertRaises(self.jev.JevError) as caught:
                session.post({"n": 1}, SECRET)
            session.close()
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].n, 1)
        self.assertEqual(created[0].context.verify_mode, self.jev.ssl.CERT_REQUIRED)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertIn("[redacted]", str(caught.exception))

    def test_observation_wrappers_load_and_an_ephemeral_view_does_not(self):
        snap = {
            "snapshot": self.snap_id("b"),
            "url": "https://example.com/invoices",
            "title": "Invoices",
            "elements": [self.element("e2", "Download")],
            "redaction": "heuristic",
        }
        payloads = (
            snap,
            {"ok": True, "data": snap},
            {"ok": True, "data": {"observation": snap, "steps": [{"status": "completed"}]}},
            {"ok": True, "click": {"issued": True, "snapshot": self.snap_id("a"), "observation": snap}},
        )
        for payload in payloads:
            with self.subTest(payload=sorted(payload)):
                path = self.write_observation(payload)
                loaded = self.jev.read_observation(path)
                self.assertEqual(loaded["snapshot"], snap["snapshot"])
                self.assertEqual(loaded["elements"][0]["ref"], "e2")
        ephemeral = self.write_observation({
            "observe": "snapshot",
            "observed": True,
            "title": "Invoices",
            "url": "https://example.com/invoices",
            "elements": [self.element("e1", "Invoices")],
            "redaction": "heuristic",
        })
        with self.assertRaises(ValueError) as caught:
            self.jev.read_observation(ephemeral)
        self.assertIn("snapshot id", str(caught.exception))

    def test_the_returned_observation_drives_the_next_click_without_another_snapshot(self):
        self.enable()
        first = self.snap_id("a")
        second = self.snap_id("b")
        third = self.snap_id("c")
        returned = {
            "observe": "snapshot",
            "observed": True,
            "snapshot": second,
            "url": "https://example.com/invoices",
            "title": "Invoices",
            "elements": [self.element("e1", "Invoices"), self.element("e2", "Download")],
            "redaction": "heuristic",
        }
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")], snapshot=first),
            {"ok": True, "data": {"dispatched": True, "observation": returned, "steps": [{"status": "completed"}]}},
        ])
        self.patch_post(self.answer({"target": ("e1", 0.91)}))
        code, out, err = self.run_jev(
            "target", "--tab", "7", "--goal", "Open invoices", "--click"
        )
        self.assertEqual(code, 0, err)
        self.assertNotIn(SECRET, out + err)
        path = self.write_observation(json.loads(out))
        self.posts.clear()
        self.actions.clear()
        later = {
            "observe": "snapshot",
            "observed": True,
            "snapshot": third,
            "url": "https://example.com/invoices",
            "elements": [self.element("e1", "Done")],
            "redaction": "heuristic",
        }
        self.patch_actions([{
            "ok": True,
            "data": {"dispatched": True, "observation": later, "steps": [{"status": "completed"}]},
        }])
        self.patch_post(self.answer({"target": ("e2", 0.95)}))
        code, out, err = self.run_jev(
            "target", "--tab", "7", "--goal", "Download the invoice",
            "--observation", path, "--click",
        )
        self.assertEqual(code, 0, err)
        self.assertEqual([item[0] for item in self.actions], ["workflow"])
        self.assertEqual(self.actions[0][1]["snapshot"], second)
        self.assertEqual(self.actions[0][1]["steps"][0]["ref"], "e2")
        self.assertEqual(self.actions[0][1]["steps"][0]["after"], {"observe": "snapshot"})
        self.assertEqual(len(self.posts), 1)
        report = json.loads(out)
        self.assertEqual(report["click"]["observation"]["snapshot"], third)

    def test_after_ready_is_checked_before_a_browser_or_model_call(self):
        self.enable()
        self.patch_post(self.answer({"target": "e1"}))
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")])])
        cases = (
            "{",
            "[]",
            '{"type":"javascript"}',
            '{"type":"text","text":""}',
            '{"type":"element_visible","ref":"e1","snapshot":"%s"}' % self.snap_id("a"),
            '{"type":"element_visible","ref":"nope"}',
            '{"type":"text","text":"Ready","timeoutMs":15001}',
            '{"type":"text","text":"Ready","timeoutMs":true}',
        )
        for raw in cases:
            with self.subTest(raw=raw):
                self.posts.clear()
                self.actions.clear()
                with self.assertRaises(SystemExit) as caught:
                    jb.main([
                        "jb.py", "jev", "target", "--tab", "7", "--goal", "Find it",
                        "--click", "--after-ready", raw,
                    ])
                self.assertEqual(caught.exception.code, 2)
                self.assertEqual(self.actions, [])
                self.assertEqual(self.posts, [])
        with self.assertRaises(SystemExit) as caught:
            jb.main([
                "jb.py", "jev", "target", "--tab", "7", "--goal", "Find it",
                "--after-ready", '{"type":"text","text":"Ready"}',
            ])
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(self.actions, [])

    def test_after_ready_is_sent_only_when_the_click_asks_for_it(self):
        self.enable()
        snap = self.snap_id("d")
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")], snapshot=snap),
            {"ok": True, "data": {"dispatched": True, "steps": [{"status": "completed"}]}},
        ])
        self.patch_post(self.answer({"target": ("e1", 0.9)}))
        ready = '{"type":"text","text":"Download","timeoutMs":1000}'
        code, _out, err = self.run_jev(
            "target", "--tab", "7", "--goal", "Find the invoice", "--click",
            "--after-ready", ready,
        )
        self.assertEqual(code, 0, err)
        self.assertEqual(self.actions[1][1]["steps"][0]["after"], {
            "observe": "snapshot",
            "ready": {"type": "text", "text": "Download", "timeoutMs": 1000},
        })
        self.assertNotIn("snapshot", self.actions[1][1]["steps"][0]["after"]["ready"])
        self.assertEqual(len(self.posts), 1)

    def test_proceed_can_click_and_still_loses_to_the_other_checks(self):
        snap = self.snap_id("e")
        self.enable()
        self.patch_actions([
            self.snapshot([self.element("e1", "Invoices")], snapshot=snap),
            {"ok": True, "data": {"dispatched": True, "steps": [{"status": "completed"}]}},
        ])
        self.patch_post(self.answer({
            "target": ("e1", 0.95),
            "page": "search_results",
            "step": "proceed_with_selected_target",
        }))
        code, out, _err = self.run_jev(
            "target", "page", "step", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 0)
        report = json.loads(out)
        self.assertTrue(report["click"]["issued"])
        self.assertNotIn("handoff", report["click"])
        self.assertEqual([item[0] for item in self.actions], ["snapshot", "workflow"])
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(set(self.posts[0][0]["questions"]), {"target", "page", "step"})
        self.assertIn(
            "proceed_with_selected_target",
            self.posts[0][0]["questions"]["step"]["criteria"],
        )

        self.posts.clear()
        self.actions.clear()
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")], snapshot=snap)])
        self.patch_post(self.answer({
            "target": ("e1", 0.5),
            "page": "other",
            "step": "proceed_with_selected_target",
        }))
        code, out, _err = self.run_jev(
            "target", "page", "step", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertFalse(report["click"]["issued"])
        self.assertIn("confidence", report["click"]["reason"])
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])
        self.assertEqual(len(self.posts), 1)

        self.posts.clear()
        self.actions.clear()
        self.patch_actions([self.snapshot([self.element("e1", "Invoices")], snapshot=snap)])
        self.patch_post(self.answer({
            "target": ("e1", 0.95),
            "page": "login_required",
            "step": "proceed_with_selected_target",
        }))
        code, out, _err = self.run_jev(
            "target", "page", "step", "--tab", "7", "--goal", "Find the invoice", "--click"
        )
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertEqual(report["click"]["handoff"], "login_required")
        self.assertFalse(report["click"]["issued"])
        self.assertEqual([item[0] for item in self.actions], ["snapshot"])
        self.assertEqual(len(self.posts), 1)
