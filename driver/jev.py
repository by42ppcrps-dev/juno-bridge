"""Optional TypeSafe Jev decisions for the operator.

Off by default. The user's local toggle or JUNO_JEV=1 opts in; JUNO_JEV=0
forces it off. An enabled call bills the user's own TypeSafe API key.
This module does not talk to the relay and does not click.
The CLI supplies one observation, asks Jev once, and with --click submits
that snapshot's ref. The extension resolves the node. A step that says to
stop does not act.

Jev sees text. The action names a snapshot id and a ref, not a coordinate.
"""
import http.client
import importlib.util
import base64
import json
import math
import os
from pathlib import Path
import re
import select
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

JEV_ENV = "JUNO_JEV"
KEY_ENV = "TYPESAFE_API_KEY"
# Optional compatibility override for embedders/tests. Normal operation uses
# jev_config.key_path() dynamically, including custom configuration dirs.
KEY_FILE = None
CONFIDENCE_ENV = "JUNO_JEV_MIN_CONFIDENCE"
DEFAULT_MIN_CONFIDENCE = 0.8
MODEL_ENV = "TYPESAFE_DEFAULT_MODEL"
BASE_URL_ENV = "TYPESAFE_BASE_URL"
DEFAULT_MODEL = "jev-latest"
DEFAULT_BASE_URL = "https://api.typesafe.ai"
MAX_RESPONSE_BYTES = 1024 * 1024
# Published Jev 1.13 input price: $42 per billion tokens, $0.042 per million.
# Output tokens are free. Confirm the current figure before relying on it.
PUBLISHED_INPUT_USD_PER_MILLION = 0.042
PRICE_SOURCE = (
    "Published Jev 1.13 input price ($0.042 per million tokens; output tokens "
    "are free). This is an estimate, not an invoice. jev-latest is an alias "
    "and the price can change: https://docs.typesafe.ai/models"
)
# Choice allows 255 options. One is reserved for "none".
MAX_CANDIDATES = 254
GOAL_MAX = 500
KINDS = ("target", "page", "step")

OFF_MESSAGE = """\
Jev is off. Configure your own TypeSafe API key, then run `jb.py jev on` or set JUNO_JEV=1. JUNO_JEV=0 forces it off. Each enabled call bills your TypeSafe account.

This command did not contact the relay or TypeSafe.

An enabled `jb.py jev` request sends the page title, URL, and snapshot text to https://api.typesafe.ai and charges TYPESAFE_API_KEY. The published Jev 1.13 price is $0.042 per million input tokens ($42 per billion). Output tokens are free. `jev-latest` is an alias and the price can change: https://docs.typesafe.ai/models

The bill is whatever TypeSafe charges that key. `jb.py send` never calls Jev. The extension and the relay do not see the TypeSafe key. A Jev choice is not permission to act, and it does not bypass pause, the command timeout, or the site allowlist.
"""

USAGE = (
    "usage: jb.py jev target|page|step ... --tab <id> --goal <text> "
    "[--device name] [--observation <file>] [--after-ready <json>] [--click]"
)
SNAPSHOT_ID_RE = re.compile(r"^snap_[0-9a-f]{32}$")
REF_RE = re.compile(r"^e[1-9][0-9]{0,2}$")
READY_TYPES = ("text", "element_visible", "element_enabled")
BLOCKING_PAGES = ("login_required", "validation_error", "unexpected")


class JevError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would resend the bearer token. Refuse it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise JevError(f"TypeSafe HTTP {code}: redirect refused")


def scrub(text, secret):
    text = str(text)
    if secret:
        text = text.replace(secret, "[redacted]")
    return text


def scrub_value(value, secret):
    """Redact decoded JSON recursively, including names and escaped tokens."""
    if isinstance(value, str):
        return scrub(value, secret)
    if isinstance(value, list):
        return [scrub_value(item, secret) for item in value]
    if isinstance(value, dict):
        return {scrub(name, secret): scrub_value(item, secret) for name, item in value.items()}
    return value


def _finite_number(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def enabled():
    return config_mod().enabled()


_config_module = None


def config_mod():
    global _config_module
    if _config_module is None:
        spec = importlib.util.spec_from_file_location(
            "juno_jev_config", Path(__file__).with_name("jev_config.py")
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        _config_module = module
    return _config_module


def min_confidence():
    raw = os.environ.get(CONFIDENCE_ENV, str(DEFAULT_MIN_CONFIDENCE)).strip()
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{CONFIDENCE_ENV} must be a number from 0 to 1")
    if not 0 <= value <= 1:
        raise ValueError(f"{CONFIDENCE_ENV} must be a number from 0 to 1")
    return value


def api_key():
    config = config_mod()
    if KEY_FILE is not None and not os.environ.get(KEY_ENV, "").strip():
        key = config._read_key_file(Path(KEY_FILE))
        if key:
            return key
        raise ValueError(f"no TypeSafe API key — set {KEY_ENV} or configure your own API key")
    return config.api_key()


def parse_ready(raw):
    """One bounded condition for the click. It does not carry a snapshot id."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("--after-ready must be JSON") from exc
    if not isinstance(raw, dict) or isinstance(raw, list):
        raise ValueError("--after-ready must be a JSON object")
    if "snapshot" in raw:
        raise ValueError("--after-ready does not take a snapshot id")
    unknown = set(raw) - {"type", "text", "ref", "timeoutMs"}
    if unknown:
        raise ValueError("--after-ready has an unknown field")
    kind = raw.get("type")
    if kind not in READY_TYPES:
        raise ValueError("--after-ready type must be text, element_visible, or element_enabled")
    ready = {"type": kind}
    if "timeoutMs" in raw:
        timeout = raw["timeoutMs"]
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 0 or timeout > 15000:
            raise ValueError("--after-ready timeoutMs must be an integer from 0 to 15000")
        ready["timeoutMs"] = timeout
    if kind == "text":
        text = raw.get("text")
        if not isinstance(text, str) or not 1 <= len(text) <= 200:
            raise ValueError("--after-ready text must be 1 to 200 characters")
        if "ref" in raw:
            raise ValueError("--after-ready text does not take a ref")
        ready["text"] = text
    else:
        ref = raw.get("ref")
        if not isinstance(ref, str) or REF_RE.fullmatch(ref) is None:
            raise ValueError("--after-ready ref must be an element ref such as e1")
        if "text" in raw:
            raise ValueError("--after-ready element condition does not take text")
        ready["ref"] = ref
    return ready


def parse_args(args):
    kinds = []
    tab = None
    goal = None
    device = "default"
    click = False
    observation = None
    ready = None
    i = 0
    while i < len(args):
        token = args[i]
        if token in KINDS:
            if token not in kinds:
                kinds.append(token)
        elif token == "--click":
            click = True
        elif token in ("--tab", "--goal", "--device", "--observation", "--after-ready"):
            if i + 1 >= len(args):
                raise ValueError(USAGE)
            value = args[i + 1]
            i += 1
            if token == "--tab":
                if not value.isdigit():
                    raise ValueError("--tab must be an integer tab id")
                tab = int(value)
            elif token == "--goal":
                goal = value.strip()
            elif token == "--observation":
                observation = value
            elif token == "--after-ready":
                ready = parse_ready(value)
            else:
                device = value.strip() or "default"
        else:
            raise ValueError(USAGE)
        i += 1
    if not kinds or tab is None or not goal:
        raise ValueError(USAGE)
    if len(goal) > GOAL_MAX:
        raise ValueError(f"--goal must be at most {GOAL_MAX} characters")
    if click and "target" not in kinds:
        raise ValueError("--click requires the target decision")
    if ready is not None and not click:
        raise ValueError("--after-ready requires --click")
    if observation is not None and not observation.strip():
        raise ValueError(USAGE)
    return {
        "kinds": kinds,
        "tab": tab,
        "goal": goal,
        "device": device,
        "click": click,
        "observation": observation,
        "ready": ready,
    }


def usable_observation(data):
    if not isinstance(data, dict):
        return False
    snap = data.get("snapshot")
    if not isinstance(snap, str) or SNAPSHOT_ID_RE.fullmatch(snap) is None:
        return False
    if not isinstance(data.get("url"), str) or not data.get("url"):
        return False
    return isinstance(data.get("elements"), list)


def _nested_observation(value):
    """A snapshot object, or the observation inside a saved result."""
    if usable_observation(value):
        return value
    if not isinstance(value, dict):
        return None
    if usable_observation(value.get("observation")):
        return value["observation"]
    click = value.get("click")
    if isinstance(click, dict) and usable_observation(click.get("observation")):
        return click["observation"]
    return None


def read_observation(path):
    """Load a snapshot the caller already has. A bad file is not replaced.

    The file may be the observation itself, a snapshot result (`data`),
    a workflow result (`data.observation`), or a jev report (`click.observation`).
    """
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("observation could not be read") from exc
    found = _nested_observation(raw)
    if found is None and isinstance(raw, dict):
        found = _nested_observation(raw.get("data"))
    if found is None:
        raise ValueError("observation needs a snapshot id, a url, and elements")
    return found


def mutation_block(decisions):
    """A handoff that must not become a browser mutation. None means act.

    proceed_with_selected_target does not stop the click and does not
    authorize it. The target checks still have to pass.
    """
    decisions = decisions if isinstance(decisions, dict) else {}
    step = (decisions.get("step") or {}).get("choice")
    if step == "escalate":
        return "escalate", "step is escalate, so no action was issued"
    if step == "observe":
        return "observe", "step is observe, so no action was issued"
    if step == "recover":
        return "recover", "step is recover, so no recovery was run and no click was issued"
    page = (decisions.get("page") or {}).get("choice")
    if page in BLOCKING_PAGES:
        return page, f"page is {page}, so no action was issued"
    return None, None


def bound_click(tab_id, snapshot_id, element, ready=None):
    """One workflow step. The extension checks the saved node, then observes."""
    after = {"observe": "snapshot"}
    # The workflow's snapshot is the capture from before the click. A new
    # element is not in that capture, so element readiness cannot see it.
    if ready:
        after["ready"] = ready
    step = {
        "op": "click",
        "ref": element.get("ref"),
        "after": after,
    }
    expect = {}
    tag = element.get("tag")
    text = element.get("text")
    if isinstance(tag, str) and tag:
        expect["tag"] = tag
    if isinstance(text, str):
        expect["text"] = text
    if expect:
        step["expect"] = expect
    return {"tabId": tab_id, "snapshot": snapshot_id, "steps": [step]}


def _describe(el):
    bits = [el.get("tag") or "element"]
    if el.get("inputType"):
        bits.append(str(el["inputType"]))
    text = el.get("text") or ""
    if text:
        bits.append(text)
    href = el.get("href") or ""
    if href:
        bits.append(href)
    if el.get("disabled"):
        bits.append("disabled")
    if el.get("redacted"):
        bits.append("value withheld")
    if el.get("inView") is False:
        bits.append("outside the viewport")
    return " ".join(bits)[:300]


def _public_element(el):
    """What Jev is allowed to see. Coordinates are not included."""
    item = {
        "ref": el.get("ref"),
        "tag": el.get("tag") or "",
        "text": el.get("text") or "",
        "inView": bool(el.get("inView")),
    }
    if el.get("inputType"):
        item["inputType"] = el["inputType"]
    if el.get("href"):
        item["href"] = el["href"]
    if el.get("disabled"):
        item["disabled"] = True
    if el.get("redacted"):
        item["redacted"] = True
    return item


def _select_candidates(elements):
    ranked = sorted(
        enumerate(elements),
        key=lambda pair: (0 if pair[1].get("inView") else 1, pair[0]),
    )
    kept = []
    for _, el in ranked:
        if len(kept) >= MAX_CANDIDATES:
            break
        ref = el.get("ref")
        if not isinstance(ref, str) or not ref or ref == "none":
            continue
        kept.append(el)
    omitted = max(0, len(elements) - len(kept))
    return kept, omitted


def prepare(snapshot, kinds, goal):
    elements = snapshot.get("elements") if isinstance(snapshot.get("elements"), list) else []
    elements = [el for el in elements if isinstance(el, dict)]
    kept, omitted = _select_candidates(elements)
    by_ref = {el["ref"]: el for el in kept}
    public = [_public_element(el) for el in kept]
    questions = {}
    if "target" in kinds:
        criteria = {el["ref"]: _describe(el) for el in kept}
        criteria["none"] = "No listed element is the right target for the goal."
        questions["target"] = {
            "type": "choice",
            "instructions": (
                "Which listed element is the right target for `goal`? "
                "Each option name is that element's ref from `elements`. "
                "Choose none when no listed element is that target. "
                "Do not invent a ref or a coordinate."
            ),
            "criteria": criteria,
        }
    if "page" in kinds:
        questions["page"] = {
            "type": "choice",
            "instructions": (
                "What kind of page is this, given `goal`, `page`, and `elements`? "
                "Choose other when none of the specific labels fit."
            ),
            "criteria": {
                "search_results": "A list of search results or similar query hits.",
                "login_required": "A sign-in wall or a request for credentials.",
                "validation_error": "The page is showing a form or input error.",
                "unexpected": "The page is not a step the goal needs.",
                "other": "None of the other labels describe this page.",
            },
        }
    if "step" in kinds:
        questions["step"] = {
            "type": "choice",
            "instructions": (
                "Given `goal` and this page, what should happen next? "
                "proceed_with_selected_target means the selected target is the next action. "
                "This choice does not authorize an action."
            ),
            "criteria": {
                "proceed_with_selected_target": (
                    "Continue with the selected target. This answer does not grant permission to act."
                ),
                "observe": "Take another observation before acting.",
                "recover": (
                    "The situation matches a routine recovery the operator already "
                    "knows. This answer does not name or run that recovery."
                ),
                "escalate": "Hand the decision to a person or a larger model.",
            },
        }
    body = {
        "model": os.environ.get(MODEL_ENV, DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "state": {
            "goal": goal,
            "page": {
                "title": snapshot.get("title") or "",
                "url": snapshot.get("url") or "",
            },
            "elements": public,
        },
        "questions": questions,
    }
    target_only_empty = kinds == ["target"] and not kept
    return {
        "skip_model": target_only_empty,
        "body": body,
        "by_ref": by_ref,
        "omitted": omitted,
        "url": snapshot.get("url") or "",
    }


def local_none(prepared, goal):
    return {
        "ok": True,
        "billed": False,
        "goal": goal,
        "decisions": {
            "target": {
                "choice": "none",
                "confidence": None,
                "element": None,
                "reason": "the snapshot listed no elements, so Jev was not called",
            }
        },
        "omitted_elements": prepared["omitted"],
        "ref_scope": "this snapshot only",
        "click": None,
    }


def _estimate(usage):
    tokens = 0
    if isinstance(usage, dict):
        raw = usage.get("input_tokens")
        if _finite_number(raw) and raw >= 0:
            tokens = raw
    return round(tokens / 1_000_000 * PUBLISHED_INPUT_USD_PER_MILLION, 6)


def interpret(response, prepared, goal):
    answers = response.get("answers") if isinstance(response, dict) else None
    if not isinstance(answers, dict):
        raise JevError("TypeSafe returned no answers")
    decisions = {}
    offered = prepared["body"]["questions"]
    for name in offered:
        answer = answers.get(name)
        if not isinstance(answer, dict) or "choice" not in answer:
            raise JevError(f"TypeSafe returned no choice for {name}")
        choice = answer["choice"]
        allowed = offered[name]["criteria"]
        if not isinstance(choice, str) or choice not in allowed:
            raise JevError(f"Jev returned {choice!r} for {name}, which was not an offered option")
        item = {
            "choice": choice,
            "confidence": answer.get("confidence"),
            "probabilities": answer.get("probabilities"),
        }
        if name == "target":
            element = prepared["by_ref"].get(choice)
            item["element"] = dict(element) if element else None
        decisions[name] = item
    usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
    return {
        "ok": True,
        "billed": True,
        "goal": goal,
        "model": response.get("model"),
        "usage": usage,
        "estimated_usd": _estimate(usage),
        "price": {
            "usd_per_million_input_tokens": PUBLISHED_INPUT_USD_PER_MILLION,
            "output_tokens": "free",
            "source": PRICE_SOURCE,
            "invoice": False,
        },
        "decisions": decisions,
        "omitted_elements": prepared["omitted"],
        "ref_scope": "refs apply only to the snapshot they were taken from",
        "url": prepared["url"],
    }


def click_refusal(target, gate):
    if target.get("choice") == "none" or not target.get("element"):
        return "Jev did not select an element, so no click was issued"
    confidence = target.get("confidence")
    if not _finite_number(confidence) or not 0 <= confidence <= 1 or confidence < gate:
        return (
            f"confidence {confidence} is below {gate}, so no click was issued. "
            "Confidence is not proof the choice is correct."
        )
    element = target["element"]
    if element.get("disabled"):
        return "the chosen element is disabled, so no click was issued"
    if element.get("inView") is False:
        return "the chosen element is outside the viewport, so no click was issued"
    return None


def _retry_after(exc):
    raw = None
    if exc.headers is not None:
        raw = exc.headers.get("Retry-After")
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        seconds = 1
    if not math.isfinite(seconds):
        seconds = 1
    if seconds < 0:
        seconds = 0
    return min(seconds, 2)


def _typesafe_base():
    return os.environ.get(BASE_URL_ENV, DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL


def _typesafe_target(base):
    parsed = urllib.parse.urlparse(base.rstrip("/"))
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise JevError("TypeSafe URL must be https without credentials, a query, or a fragment")
    port = parsed.port or 443
    path = (parsed.path or "").rstrip("/") + "/v1/systemone"
    origin = f"https://{parsed.hostname}:{port}"
    return parsed.hostname, port, path, origin


def _proxy_for(host):
    if urllib.request.proxy_bypass(host):
        return None
    proxies = urllib.request.getproxies()
    value = proxies.get("https") or proxies.get("all")
    if not value:
        return None
    parsed = urllib.parse.urlparse(value if "://" in value else "http://" + value)
    # HTTPSConnection performs verified TLS to the target after a HTTP CONNECT.
    # HTTPS-to-proxy and SOCKS need different transports; refuse silently
    # bypassing a user-configured proxy rather than sending directly.
    if parsed.scheme != "http" or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise JevError("TypeSafe supports HTTP CONNECT proxies in HTTPS_PROXY or ALL_PROXY")
    try:
        port = parsed.port or 80
    except ValueError as exc:
        raise JevError("TypeSafe proxy has an invalid port") from exc
    headers = {}
    username = urllib.parse.unquote(parsed.username or "")
    password = urllib.parse.unquote(parsed.password or "")
    if parsed.username is not None:
        credential = base64.b64encode((username + ":" + password).encode("utf-8")).decode("ascii")
        headers["Proxy-Authorization"] = "Basic " + credential
    return {"host": parsed.hostname, "port": port, "headers": headers, "identity": value,
            "secrets": [value, username, password]}


def _parsed_json(raw, key):
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        parsed = json.loads(text)
    except (UnicodeError, json.JSONDecodeError):
        raise JevError("TypeSafe returned a response that was not JSON") from None
    if not isinstance(parsed, dict):
        raise JevError("TypeSafe returned a response that was not a JSON object")
    return scrub_value(parsed, key)


def _http_error(status, raw, key):
    message = f"TypeSafe HTTP {status}"
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        parsed = json.loads(text)
    except (UnicodeError, json.JSONDecodeError):
        # A plain/undecodable body may contain arbitrary escaped credentials.
        # Do not put that untrusted representation in errors or logs.
        return JevError(message + ": provider response detail omitted")
    detail = json.dumps(scrub_value(parsed, key), ensure_ascii=True)[:300]
    return JevError(message + ": " + detail)


def _transport_error(exc):
    # HTTP status lines and OS/proxy error strings can contain encoded keys.
    # Expose a useful exception category, never their arbitrary raw text.
    reason = getattr(exc, "reason", None)
    kind = type(reason).__name__ if isinstance(reason, BaseException) else type(exc).__name__
    diagnostic = kind + ("; timeout or overall deadline exceeded" if kind == "TimeoutError" else "")
    return JevError(
        f"TypeSafe request failed ({diagnostic}); not retried because the request may have been billed"
    )


def _remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError("overall TypeSafe request deadline exceeded")
    return value


def _read_response(res, deadline, conn=None):
    chunks = []
    size = 0
    reader = getattr(res, "read1", res.read)
    while True:
        remaining = _remaining(deadline)
        if conn is not None:
            conn.timeout = remaining
            sock = getattr(conn, "sock", None)
            if sock is not None:
                sock.settimeout(remaining)
        # read1 returns available bytes, so slow dribbles cannot reset an
        # inactivity timeout forever. One extra byte detects a too-large body.
        chunk = reader(min(64 * 1024, MAX_RESPONSE_BYTES + 1 - size))
        _remaining(deadline)
        if not chunk:
            return b"".join(chunks)
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise JevError("TypeSafe response exceeds the 1 MiB limit; not retried")
        chunks.append(chunk)


class TypeSafeSession:
    """One HTTPS connection for System One. This is not the relay client.

    The connection opens on the first post and stays up for the next one.
    Certificate verification stays on. A redirect is refused, so the bearer
    token is not sent to another host.
    """

    def __init__(self):
        self._conn = None
        self._origin = None
        self._last_used = None
        self._proxy_secrets = []

    def close(self):
        conn = self._conn
        self._conn = None
        self._origin = None
        self._last_used = None
        self._proxy_secrets = []
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass

    def _connection(self, host, port, origin, timeout):
        proxy = _proxy_for(host)
        identity = (origin, proxy["identity"] if proxy else None)
        if self._conn is not None and self._origin == identity:
            exposes_socket = hasattr(self._conn, "sock")
            sock = getattr(self._conn, "sock", None)
            stale = (exposes_socket and sock is None) or (
                self._last_used is not None and time.monotonic() - self._last_used > 50
            )
            if not stale and sock is not None:
                try:
                    # Readability after a complete response means EOF, pending
                    # TLS data, or an unsolicited response. Start clean BEFORE
                    # issuing a new potentially billed POST; never replay it.
                    stale = bool(select.select([sock], [], [], 0)[0])
                except (OSError, ValueError):
                    stale = True
            if not stale:
                self._conn.timeout = timeout
                if sock is not None:
                    sock.settimeout(timeout)
                return self._conn
        self.close()
        context = ssl.create_default_context()
        if proxy:
            conn = http.client.HTTPSConnection(proxy["host"], proxy["port"], timeout=timeout, context=context)
            conn.set_tunnel(host, port, headers=proxy["headers"])
            self._proxy_secrets = proxy["secrets"]
        else:
            conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=context)
        self._conn = conn
        self._origin = identity
        return conn

    def post(self, body, key, timeout=30):
        if not _finite_number(timeout) or timeout <= 0:
            raise ValueError("TypeSafe timeout must be a positive finite number")
        deadline = time.monotonic() + timeout
        host, port, path, origin = _typesafe_target(_typesafe_base())
        data = json.dumps(body).encode("utf-8")
        headers = {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Connection": "keep-alive",
        }
        active = [None]
        active_socket = [None]
        def interrupt():
            # Interrupt a socket read even if a peer slowly dribbles an HTTP
            # header or chunk header inside the standard library's parser.
            conn = active[0]
            sock = active_socket[0] or getattr(conn, "sock", None)
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        watchdog = threading.Timer(max(0, deadline - time.monotonic()), interrupt)
        watchdog.daemon = True
        watchdog.start()
        try:
            for attempt in (1, 2):
                conn = self._connection(host, port, origin, _remaining(deadline))
                active[0] = conn
                active_socket[0] = None
                # Complete connection setup before sending credentials. If
                # setup used the remaining budget, do not issue a billed POST.
                connect = getattr(conn, "connect", None)
                if callable(connect) and getattr(conn, "sock", None) is None:
                    connect()
                remaining = _remaining(deadline)
                conn.timeout = remaining
                sock = getattr(conn, "sock", None)
                active_socket[0] = sock
                if sock is not None:
                    sock.settimeout(remaining)
                conn.request("POST", path, body=data, headers=headers)
                _remaining(deadline)
                res = conn.getresponse()
                raw = _read_response(res, deadline, conn)
                self._last_used = time.monotonic()
                if 300 <= res.status < 400:
                    self.close()
                    raise JevError(f"TypeSafe HTTP {res.status}: redirect refused")
                if res.status in (429, 529) and attempt == 1:
                    delay = _retry_delay(res.headers)
                    if delay >= _remaining(deadline):
                        raise JevError(f"TypeSafe HTTP {res.status}: retry would exceed request deadline")
                    time.sleep(delay)
                    continue
                if res.status < 200 or res.status >= 300:
                    raise _http_error(res.status, raw, key)
                parsed = _parsed_json(raw, key)
                _remaining(deadline)
                return parsed
        except (http.client.HTTPException, OSError, TimeoutError) as exc:
            self.close()
            raise _transport_error(exc) from None
        except JevError:
            self.close()
            raise
        finally:
            watchdog.cancel()
            watchdog.join(timeout=0.1)


def _retry_delay(headers):
    raw = None
    if headers is not None:
        getter = getattr(headers, "get", None)
        if callable(getter):
            raw = getter("Retry-After")
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        seconds = 1
    if not math.isfinite(seconds):
        seconds = 1
    if seconds < 0:
        seconds = 0
    return min(seconds, 2)


def _open(req, timeout):
    opener = urllib.request.build_opener(_NoRedirect)
    return opener.open(req, timeout=timeout)


def _post_with_opener(body, key, timeout, opener):
    """Injected-opener path used by tests. One retry on 429 or 529."""
    if not _finite_number(timeout) or timeout <= 0:
        raise ValueError("TypeSafe timeout must be a positive finite number")
    deadline = time.monotonic() + timeout
    base = _typesafe_base().rstrip("/")
    _typesafe_target(base)
    url = base + "/v1/systemone"
    data = json.dumps(body).encode("utf-8")
    last = None
    for attempt in (1, 2):
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with opener(req, timeout=_remaining(deadline)) as res:
                raw = _read_response(res, deadline)
            return _parsed_json(raw, key)
        except urllib.error.HTTPError as exc:
            try:
                raw = _read_response(exc, deadline)
            except (OSError, TimeoutError, http.client.HTTPException) as body_error:
                raise _transport_error(body_error) from None
            last = _http_error(exc.code, raw, key)
            if exc.code in (429, 529) and attempt == 1:
                delay = _retry_after(exc)
                if delay >= _remaining(deadline):
                    raise JevError(f"TypeSafe HTTP {exc.code}: retry would exceed request deadline") from None
                time.sleep(delay)
                continue
            raise last from None
        except urllib.error.URLError as exc:
            raise _transport_error(exc) from None
        except (OSError, TimeoutError, http.client.HTTPException) as exc:
            raise _transport_error(exc) from None
    raise last or JevError("TypeSafe request failed")


def post_systemone(body, key, timeout=30, opener=None, session=None):
    """POST one System One request. Retry once on 429 or 529.

    A completed response is not sent again: a second success would bill twice.
    Redirects are refused so the bearer token stays on the TypeSafe host.
    Pass a session to reuse its connection. Without one, the call opens a
    connection and closes it. The operator holds the session instead.
    """
    if opener is not None:
        return _post_with_opener(body, key, timeout, opener)
    if session is not None:
        return session.post(body, key, timeout)
    owned = TypeSafeSession()
    try:
        return owned.post(body, key, timeout)
    finally:
        owned.close()
