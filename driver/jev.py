"""Optional TypeSafe Jev decisions for the operator.

Off unless JUNO_JEV=1. An enabled call bills the TypeSafe account that owns
TYPESAFE_API_KEY. This module does not talk to the relay and does not click.
The CLI takes the snapshot, and it clicks only when --click was passed and
the code revalidation below accepts the choice.

Jev sees text. Coordinates stay on this machine and are applied only after a
ref from the candidate list is resolved here.
"""
import json
import math
import os
import stat
import time
import urllib.error
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
    "[--device name] [--click]"
)


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


def parse_args(args):
    kinds = []
    tab = None
    goal = None
    device = "default"
    click = False
    i = 0
    while i < len(args):
        token = args[i]
        if token in KINDS:
            if token not in kinds:
                kinds.append(token)
        elif token == "--click":
            click = True
        elif token in ("--tab", "--goal", "--device"):
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
    return {"kinds": kinds, "tab": tab, "goal": goal, "device": device, "click": click}


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
                "This choice does not authorize an action."
            ),
            "criteria": {
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


def _fingerprint(el):
    return (
        el.get("tag") or "",
        el.get("text") or "",
        el.get("inputType") or "",
        el.get("href") or "",
        bool(el.get("disabled")),
    )


def revalidate(original_url, chosen, fresh):
    """Match the chosen element on a new snapshot. Refs are not reused."""
    fresh_url = fresh.get("url") or ""
    if fresh_url != (original_url or ""):
        return None, "the page changed before the click, so the Jev choice was not used"
    elements = fresh.get("elements") if isinstance(fresh.get("elements"), list) else []
    wanted = _fingerprint(chosen)
    matches = [el for el in elements if isinstance(el, dict) and _fingerprint(el) == wanted]
    if len(matches) != 1:
        return None, "the chosen element was not unique on a fresh snapshot, so no click was issued"
    match = matches[0]
    if match.get("inView") is False:
        return None, "the chosen element is outside the viewport on a fresh snapshot, so no click was issued"
    if not _finite_number(match.get("x")) or not _finite_number(match.get("y")):
        return None, "the fresh snapshot has no coordinates for that element"
    return match, ""


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


def _open(req, timeout):
    opener = urllib.request.build_opener(_NoRedirect)
    return opener.open(req, timeout=timeout)


def post_systemone(body, key, timeout=30, opener=None):
    """POST one System One request. Retry once on 429 or 529.

    A completed response is not sent again: a second success would bill twice.
    Redirects are refused so the bearer token stays on the TypeSafe host.
    """
    base = os.environ.get(BASE_URL_ENV, DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL
    url = base.rstrip("/") + "/v1/systemone"
    data = json.dumps(body).encode("utf-8")
    open_fn = opener or _open
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
            with open_fn(req, timeout=timeout) as res:
                raw = res.read().decode("utf-8")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                raise JevError("TypeSafe returned a response that was not JSON")
            if not isinstance(parsed, dict):
                raise JevError("TypeSafe returned a response that was not a JSON object")
            return parsed
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
