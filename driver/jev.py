"""Optional TypeSafe Jev decisions for the operator.

Off unless JUNO_JEV=1. An enabled call bills the TypeSafe account that owns
TYPESAFE_API_KEY. This module does not talk to the relay and does not click.
The CLI supplies one observation, asks Jev once, and with --click submits
that snapshot's ref. The extension resolves the node. A step that says to
stop does not act.

Jev sees text. The action names a snapshot id and a ref, not a coordinate.
"""
import http.client
import json
import math
import os
import re
import ssl
import stat
import time
import urllib.error
import urllib.parse
import urllib.request

JEV_ENV = "JUNO_JEV"
KEY_ENV = "TYPESAFE_API_KEY"
KEY_FILE = os.path.expanduser("~/.config/juno-bridge/typesafe-key")
CONFIDENCE_ENV = "JUNO_JEV_MIN_CONFIDENCE"
DEFAULT_MIN_CONFIDENCE = 0.8
MODEL_ENV = "TYPESAFE_DEFAULT_MODEL"
BASE_URL_ENV = "TYPESAFE_BASE_URL"
DEFAULT_MODEL = "jev-latest"
DEFAULT_BASE_URL = "https://api.typesafe.ai"
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
Jev is off. Set JUNO_JEV=1 to enable it. It stays off because each call bills your TypeSafe account.

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


def _finite_number(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def enabled():
    return os.environ.get(JEV_ENV, "").strip() == "1"


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
    key = os.environ.get(KEY_ENV, "").strip()
    if key:
        return key
    if os.path.exists(KEY_FILE):
        mode = stat.S_IMODE(os.stat(KEY_FILE).st_mode)
        if mode & 0o077:
            raise ValueError(
                f"{KEY_FILE} is too permissive (mode {oct(mode)}); run: chmod 600 {KEY_FILE}"
            )
        with open(KEY_FILE) as f:
            key = f.read().strip()
        if key:
            return key
    raise ValueError(
        f"no TypeSafe API key — set {KEY_ENV} or write it to {KEY_FILE} (chmod 600). "
        "The key stays in the operator process. Do not put it in the extension or the relay."
    )


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
        if choice not in allowed:
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
    if not _finite_number(confidence) or confidence < gate:
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
    if seconds < 0:
        seconds = 0
    return min(seconds, 2)


def _typesafe_base():
    return os.environ.get(BASE_URL_ENV, DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL


def _typesafe_target(base):
    parsed = urllib.parse.urlparse(base.rstrip("/"))
    if parsed.scheme != "https" or not parsed.hostname:
        raise JevError("TypeSafe URL must be https")
    port = parsed.port or 443
    path = (parsed.path or "").rstrip("/") + "/v1/systemone"
    origin = f"https://{parsed.hostname}:{port}"
    return parsed.hostname, port, path, origin


def _parsed_json(raw, key):
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        parsed = json.loads(text)
    except (UnicodeError, json.JSONDecodeError):
        raise JevError("TypeSafe returned a response that was not JSON")
    if not isinstance(parsed, dict):
        raise JevError("TypeSafe returned a response that was not a JSON object")
    if key and key in json.dumps(parsed):
        try:
            return json.loads(scrub(json.dumps(parsed), key))
        except json.JSONDecodeError:
            raise JevError("TypeSafe returned a response that was not JSON")
    return parsed


class TypeSafeSession:
    """One HTTPS connection for System One. This is not the relay client.

    The connection opens on the first post and stays up for the next one.
    Certificate verification stays on. A redirect is refused, so the bearer
    token is not sent to another host.
    """

    def __init__(self):
        self._conn = None
        self._origin = None

    def close(self):
        conn = self._conn
        self._conn = None
        self._origin = None
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass

    def _connection(self, host, port, origin, timeout):
        if self._conn is not None and self._origin == origin:
            return self._conn
        self.close()
        context = ssl.create_default_context()
        conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=context)
        self._conn = conn
        self._origin = origin
        return conn

    def post(self, body, key, timeout=30):
        host, port, path, origin = _typesafe_target(_typesafe_base())
        data = json.dumps(body).encode("utf-8")
        headers = {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Connection": "keep-alive",
        }
        last = None
        for attempt in (1, 2):
            conn = self._connection(host, port, origin, timeout)
            try:
                conn.request("POST", path, body=data, headers=headers)
                res = conn.getresponse()
                raw = res.read()
            except (http.client.HTTPException, OSError, TimeoutError) as exc:
                self.close()
                raise JevError(scrub(f"TypeSafe request failed: {exc}", key))
            if 300 <= res.status < 400:
                self.close()
                raise JevError(f"TypeSafe HTTP {res.status}: redirect refused")
            if res.status in (429, 529) and attempt == 1:
                time.sleep(_retry_delay(res.headers))
                last = JevError(f"TypeSafe HTTP {res.status}: {scrub(raw.decode('utf-8', 'replace')[:300], key)}")
                continue
            if res.status < 200 or res.status >= 300:
                detail = raw.decode("utf-8", "replace")[:300]
                raise JevError(f"TypeSafe HTTP {res.status}: {scrub(detail, key)}")
            return _parsed_json(raw, key)
        raise last or JevError("TypeSafe request failed")


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
    if seconds < 0:
        seconds = 0
    return min(seconds, 2)


def _open(req, timeout):
    opener = urllib.request.build_opener(_NoRedirect)
    return opener.open(req, timeout=timeout)


def _post_with_opener(body, key, timeout, opener):
    """Injected-opener path used by tests. One retry on 429 or 529."""
    base = _typesafe_base().rstrip("/")
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
            with opener(req, timeout=timeout) as res:
                raw = res.read().decode("utf-8")
            return _parsed_json(raw, key)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            last = JevError(f"TypeSafe HTTP {exc.code}: {scrub(detail, key)}")
            if exc.code in (429, 529) and attempt == 1:
                time.sleep(_retry_after(exc))
                continue
            raise last
        except urllib.error.URLError as exc:
            raise JevError(scrub(f"TypeSafe request failed: {exc.reason}", key))
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
