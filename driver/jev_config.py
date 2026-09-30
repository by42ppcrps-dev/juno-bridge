"""Owner-local, optional Jev settings. No key is sent to the bridge relay."""

import json
import os
from pathlib import Path
import stat
import tempfile

JEV_ENV = "JUNO_JEV"
KEY_ENV = "TYPESAFE_API_KEY"


def config_dir():
    for name in ("JUNO_JEV_CONFIG_DIR", "JUNO_OPERATOR_DIR"):
        value = os.environ.get(name, "").strip()
        if value:
            return Path(value).expanduser()
    return Path.home() / ".config" / "juno-bridge"


def config_path():
    return config_dir() / "config.json"


def key_path():
    return config_dir() / "jev-api-key"


def settings(path=None):
    path = Path(path) if path is not None else config_path()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read Jev settings from {path}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Jev settings in {path} must be a JSON object")
    if "jev_enabled" in value and not isinstance(value["jev_enabled"], bool):
        raise ValueError("jev_enabled must be a boolean")
    return value


def enabled():
    # Explicit 0 always overrides an enabled saved setting. Other supplied
    # values fail closed, retaining the existing opt-in behavior of JUNO_JEV.
    if JEV_ENV in os.environ:
        return os.environ[JEV_ENV].strip() == "1"
    return settings().get("jev_enabled", False)


def _write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + "-", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def set_enabled(value):
    if not isinstance(value, bool):
        raise ValueError("Jev enabled setting must be a boolean")
    update_settings({"jev_enabled": value})


def update_settings(updates, path=None):
    if not isinstance(updates, dict):
        raise ValueError("Jev settings update must be an object")
    if "jev_enabled" in updates and not isinstance(updates["jev_enabled"], bool):
        raise ValueError("jev_enabled must be a boolean")
    path = Path(path) if path is not None else config_path()
    value_map = settings(path)
    value_map.update(updates)
    _write_private(path, json.dumps(value_map, indent=2) + "\n")


def _checked_key(value):
    if not isinstance(value, str):
        raise ValueError("TypeSafe API key must be text")
    value = value.strip()
    if not value or len(value) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in value):
        raise ValueError("TypeSafe API key must be a nonempty token without spaces or control characters")
    return value


def write_api_key(value):
    _write_private(key_path(), _checked_key(value) + "\n")


def _read_key_file(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(str(path), flags)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError(f"could not read TypeSafe API key from {path}; use a regular private file") from exc
    with os.fdopen(fd, "r", encoding="utf-8") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"{path} must be a regular private file")
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o077:
            raise ValueError(f"{path} is too permissive (mode {oct(mode)}); run: chmod 600 {path}")
        if hasattr(os, "getuid") and info.st_uid != os.getuid():
            raise ValueError(f"{path} must belong to the current user")
        try:
            value = handle.read(4097)
        except UnicodeError as exc:
            raise ValueError("TypeSafe API key file must contain a text token") from exc
        return _checked_key(value)


def api_key():
    value = os.environ.get(KEY_ENV, "").strip()
    if value:
        return _checked_key(value)
    value = _read_key_file(key_path())
    if value:
        return value
    raise ValueError(
        f"no TypeSafe API key — set {KEY_ENV} or configure {key_path()} (mode 600). "
        "Use your own key; it stays in the local operator process."
    )


def status():
    saved = settings().get("jev_enabled", False)
    override = os.environ.get(JEV_ENV)
    source = "environment" if os.environ.get(KEY_ENV, "").strip() else (
        "file" if key_path().exists() else "missing"
    )
    key_error = None
    try:
        api_key()
        present = True
    except ValueError as exc:
        present = False
        if source != "missing":
            key_error = str(exc)
    return {
        "enabled": enabled(),
        "persisted_enabled": saved,
        "override": override,
        "key_present": present,
        "key_source": source,
        "key_error": key_error,
        "key_path": str(key_path()),
        "config_dir": str(config_dir()),
    }
