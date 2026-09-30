"""Jev toggle/key configuration checks; no network and no real API keys."""

import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("juno_jev_config_tests", ROOT / "driver" / "jev_config.py")
config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(config)
KEY = "ts-unit-test-user-owned-key"


class JevConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = mock.patch.dict(os.environ, {"JUNO_JEV_CONFIG_DIR": self.temp.name}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_off_by_default_and_environment_overrides_saved_toggle(self):
        self.assertFalse(config.enabled())
        config.set_enabled(True)
        self.assertTrue(config.enabled())
        for value in ("0", "true", "", "yes"):
            os.environ["JUNO_JEV"] = value
            self.assertFalse(config.enabled())
        os.environ["JUNO_JEV"] = "1"
        config.set_enabled(False)
        self.assertTrue(config.enabled())
        os.environ.pop("JUNO_JEV")
        self.assertFalse(config.enabled())

    def test_directory_override_then_operator_directory_then_home(self):
        self.assertEqual(config.config_dir(), Path(self.temp.name))
        os.environ["JUNO_OPERATOR_DIR"] = self.temp.name + "/operator"
        self.assertEqual(config.config_dir(), Path(self.temp.name))
        os.environ.pop("JUNO_JEV_CONFIG_DIR")
        self.assertEqual(config.config_dir(), Path(self.temp.name) / "operator")
        os.environ.pop("JUNO_OPERATOR_DIR")
        with mock.patch.object(config.Path, "home", return_value=Path(self.temp.name)):
            self.assertEqual(config.config_dir(), Path(self.temp.name) / ".config" / "juno-bridge")

    def test_toggle_writes_private_config_and_preserves_relay_settings(self):
        config.config_path().write_text(json.dumps({"relay_url": "https://relay.example", "other": 3}))
        config.set_enabled(True)
        self.assertEqual(config.settings(), {"relay_url": "https://relay.example", "other": 3, "jev_enabled": True})
        self.assertEqual(stat.S_IMODE(config.config_path().stat().st_mode), 0o600)
        config.update_settings({"relay_url": "https://new-relay.example"})
        self.assertTrue(config.enabled())
        alternate = Path(self.temp.name) / "alternate.json"
        alternate.write_text('{"other":true}')
        config.update_settings({"relay_url": "https://relay.example"}, alternate)
        self.assertEqual(config.settings(alternate), {"other": True, "relay_url": "https://relay.example"})
        self.assertEqual(stat.S_IMODE(alternate.stat().st_mode), 0o600)

    def test_invalid_toggle_or_config_is_not_replaced(self):
        for text in ('{"jev_enabled":"true"}', "[]", "{"):
            config.config_path().write_text(text)
            with self.assertRaises(ValueError):
                config.set_enabled(True)
            self.assertEqual(config.config_path().read_text(), text)
        with self.assertRaises(ValueError):
            config.set_enabled(1)

    def test_key_file_is_0600_and_environment_key_takes_precedence(self):
        config.write_api_key(KEY)
        self.assertEqual(config.key_path().name, "jev-api-key")
        self.assertEqual(stat.S_IMODE(config.key_path().stat().st_mode), 0o600)
        self.assertEqual(config.api_key(), KEY)
        os.environ["TYPESAFE_API_KEY"] = "ts-unit-test-environment-key"
        self.assertEqual(config.api_key(), os.environ["TYPESAFE_API_KEY"])
        self.assertFalse(config.enabled(), "configuring a key never enables billed calls")
        self.assertFalse(config.config_path().exists(), "keys are never put in relay config")

    def test_permissive_symlink_and_invalid_key_are_refused_without_echoing_it(self):
        config.write_api_key(KEY)
        config.key_path().chmod(0o644)
        with self.assertRaisesRegex(ValueError, "too permissive"):
            config.api_key()
        config.key_path().unlink()
        target = Path(self.temp.name) / "real-key"
        target.write_text(KEY)
        target.chmod(0o600)
        config.key_path().symlink_to(target)
        with self.assertRaisesRegex(ValueError, "regular private file"):
            config.api_key()
        for value in (KEY + "\r\nAuthorization:evil", "two tokens", ""):
            with self.assertRaises(ValueError) as caught:
                config.write_api_key(value)
            self.assertNotIn(KEY, str(caught.exception))

    def test_status_reports_sources_but_never_includes_api_key(self):
        self.assertFalse(config.status()["key_present"])
        config.write_api_key(KEY)
        config.set_enabled(True)
        status = config.status()
        self.assertTrue(status["enabled"])
        self.assertTrue(status["key_present"])
        self.assertEqual(status["key_source"], "file")
        self.assertNotIn(KEY, json.dumps(status))
        os.environ["JUNO_JEV"] = "0"
        os.environ["TYPESAFE_API_KEY"] = KEY + "env"
        status = config.status()
        self.assertFalse(status["enabled"])
        self.assertTrue(status["persisted_enabled"])
        self.assertEqual(status["override"], "0")
        self.assertEqual(status["key_source"], "environment")
        self.assertNotIn(KEY, json.dumps(status))

    def test_key_replacement_is_atomic_and_cannot_overwrite_symlink_target(self):
        target = Path(self.temp.name) / "unrelated"
        target.write_text("preserve me")
        config.key_path().symlink_to(target)
        config.write_api_key(KEY)
        self.assertFalse(config.key_path().is_symlink())
        self.assertEqual(target.read_text(), "preserve me")
        self.assertEqual(config.api_key(), KEY)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "named pipes require POSIX")
    def test_named_pipe_key_is_refused_without_waiting_for_a_writer(self):
        os.mkfifo(config.key_path(), 0o600)
        with self.assertRaisesRegex(ValueError, "regular private file"):
            config.api_key()
