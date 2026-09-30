#!/usr/bin/env python3
"""Juno Bridge driver CLI — the operator's side of the browser bridge.

Setup:
  export JUNO_BRIDGE_PSK="your-admin-passphrase"   # or store it in
                                                   # ~/.config/juno-bridge/psk (mode 0600)
  jb.py init https://YOUR-RELAY.workers.dev
  jb.py bootstrap      # print the ADMIN_PSK_SHA256 value to set; does not contact the relay
  jb.py pair           # mint a 10-minute pairing code for the browser
  jb.py ping           # check relay + device count
  jb.py devices        # list paired browsers (id, name, connected, pending)
  jb.py revoke <device-id>
                       # unpair a browser (lost laptop, stale pairing)
  jb.py send <action> [params-json] [device]
                       # e.g. jb.py send navigate '{"url":"https://example.com"}'
                       # waits up to 60s for the result and prints it
                       # exits 1 if that result is a failure

Actions: ping, tabs, navigate, screenshot, snapshot, text, click, type, key,
         scroll, close, eval, workflow

  jb.py operator       # run the local operator process in the foreground
  jb.py operator stop

Normal commands go through that process so the HTTP client stays alive.
A client that closes its socket does not stop the process.
JUNO_OPERATOR=0 uses one curl subprocess per relay request instead.

Security notes:
  - The passphrase is a bearer secret. The driver sends it only in an
    `Authorization: Bearer` header over HTTPS, never in a URL or a log line.
    Keep it out of shell history (prefer the psk file over the env var on
    shared machines).
  - The relay stores and compares the SHA-256 of the passphrase. Sending the
    passphrase to authenticate is not the same as it never leaving the machine.
  - `bootstrap` does not contact the relay and cannot claim one. Set
    ADMIN_PSK_SHA256 before the relay is reachable.
"""
import hashlib
import importlib.util
import json
import os
import secrets
import stat
import subprocess
import sys
import tempfile
import time

CONFIG_DIR = os.path.expanduser("~/.config/juno-bridge")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
PSK_FILE = os.path.join(CONFIG_DIR, "psk")
PSK_ENV = "JUNO_BRIDGE_PSK"
MIN_PSK_LEN = 16


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def load_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    with open(CONFIG_FILE) as f:
        return json.load(f)


def relay_url():
    url = load_config().get("relay_url", "").rstrip("/")
    if not url:
        die("no relay configured — run: jb.py init <relay-url>", 2)
    if not url.startswith("https://"):
        die("relay URL must be https")
    return url


def admin_psk():
    psk = os.environ.get(PSK_ENV, "").strip()
    if psk:
        return psk
    if os.path.exists(PSK_FILE):
        mode = stat.S_IMODE(os.stat(PSK_FILE).st_mode)
        if mode & 0o077:
            die(f"{PSK_FILE} is too permissive (mode {oct(mode)}); run: chmod 600 {PSK_FILE}")
        with open(PSK_FILE) as f:
            psk = f.read().strip()
        if psk:
            return psk
    die(f"no admin passphrase — set {PSK_ENV} or write it to {PSK_FILE} (chmod 600)")


def operator_enabled():
    """False keeps the per-request curl path. The default reuses one client."""
    if os.environ.get("JUNO_OPERATOR_CHILD") == "1":
        return False
    if os.environ.get("JUNO_BRIDGE_HTTP", "").strip() == "curl":
        return False
    return os.environ.get("JUNO_OPERATOR", "1").strip() != "0"


def interpret_relay(status, payload, tolerate):
    if not isinstance(payload, dict):
        payload = {"_raw": payload}
    if status in tolerate:
        copied = dict(payload)
        copied["_status"] = status
        return copied
    if status is not None and not (200 <= status < 300):
        die(f"HTTP {status}: {json.dumps(payload)[:300]}")
    return payload


def relay_request(method, path, data=None, timeout=30, tolerate=()):
    """Send one relay request. The operator process is the normal path.

    curl is the compatibility path (JUNO_OPERATOR=0 or JUNO_BRIDGE_HTTP=curl).
    Some Cloudflare-fronted hosts block urllib's TLS fingerprint before the
    request reaches the Worker. The operator uses libcurl with certificate
    checks left on, and does not follow redirects.
    """
    if operator_enabled():
        try:
            status, payload = operator_mod().call(method, path, data, timeout)
        except operator_mod().OperatorError as exc:
            die(f"request failed: {exc}")
        return interpret_relay(status, payload, tolerate)
    return relay_request_curl(method, path, data, timeout, tolerate)


def relay_request_curl(method, path, data=None, timeout=30, tolerate=()):
    """One curl subprocess. HTTP statuses in `tolerate` are returned (with the
    status under "_status") instead of aborting.
    """
    url = relay_url() + path
    headers = {"Authorization": f"Bearer {admin_psk()}"}
    if data is not None:
        headers["Content-Type"] = "application/json"

    lines = [
        "silent = true",
        "show-error = true",
        f'request = "{method}"',
        f'url = "{url}"',
        "connect-timeout = 10",
        f"max-time = {int(timeout)}",
        'write-out = "\\nHTTPSTATUS:%{http_code}"',
    ]
    for name, value in headers.items():
        safe = value.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'header = "{name}: {safe}"')

    body_file = cfg_file = None
    try:
        if data is not None:
            bf = tempfile.NamedTemporaryFile(mode="w", prefix="jb-body-",
                                             suffix=".json", delete=False)
            body_file = bf.name
            json.dump(data, bf)
            bf.close()
            os.chmod(body_file, 0o600)
            lines.append(f'data-binary = "@{body_file}"')
        cf = tempfile.NamedTemporaryFile(mode="w", prefix="jb-cfg-",
                                         suffix=".cfg", delete=False)
        cfg_file = cf.name
        cf.write("\n".join(lines) + "\n")
        cf.close()
        os.chmod(cfg_file, 0o600)
        # The passphrase travels in the 0600 config file, never on a command line.
        proc = subprocess.run(["curl", "--config", cfg_file],
                              capture_output=True, text=True, timeout=timeout + 15)
    finally:
        for p in (cfg_file, body_file):
            if p:
                try:
                    os.remove(p)
                except OSError:
                    pass

    if proc.returncode != 0:
        die(f"request failed: {proc.stderr.strip()[-300:]}")
    out = proc.stdout
    status = None
    if "\nHTTPSTATUS:" in out:
        out, _, status_s = out.rpartition("\nHTTPSTATUS:")
        try:
            status = int(status_s.strip())
        except ValueError:
            status = None
    try:
        payload = json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        payload = {"_raw": out.strip()[-300:]}
    if status in tolerate:
        payload = payload if isinstance(payload, dict) else {"_raw": payload}
        payload["_status"] = status
        return payload
    if status is not None and not (200 <= status < 300):
        detail = payload if isinstance(payload, dict) else {"_raw": payload}
        die(f"HTTP {status}: {json.dumps(detail)[:300]}")
    return payload if isinstance(payload, dict) else {"_raw": payload}


def cmd_init(args):
    if not args:
        die("usage: jb.py init <relay-url>", 2)
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        json.dump({"relay_url": args[0].rstrip("/")}, f, indent=2)
    print("relay set to", args[0].rstrip("/"))


def psk_sha256(psk):
    return hashlib.sha256(psk.encode("utf-8")).hexdigest()


def cmd_bootstrap(_args):
    """Tell the operator how to set ADMIN_PSK_SHA256. Does not send the passphrase."""
    psk = admin_psk()
    if len(psk) < MIN_PSK_LEN:
        die(f"passphrase must be at least {MIN_PSK_LEN} characters", 2)
    digest = psk_sha256(psk)
    print("Open enrollment is disabled. The relay serves admin and device")
    print("traffic only after ADMIN_PSK_SHA256 is set to the SHA-256 of this")
    print("passphrase. From the relay/ directory:")
    print()
    print("  printf '%s' \"$JUNO_BRIDGE_PSK\" | shasum -a 256 | cut -d' ' -f1 | npx wrangler secret put ADMIN_PSK_SHA256")
    print()
    print("Expected SHA-256:", digest)
    print("This command does not contact the relay. After the secret is set,")
    print("check it with: jb.py ping")


def cmd_pair(_args):
    res = relay_request("POST", "/admin/pair", {})
    print("\n  Pairing code:", res["code"], "\n")
    print("Give this to the browser owner — single use, expires in 10 minutes.")


def cmd_ping(_args):
    print(json.dumps(relay_request("GET", "/admin/ping"), indent=2))


def cmd_devices(_args):
    print(json.dumps(relay_request("GET", "/admin/devices"), indent=2))


def cmd_revoke(args):
    if not args:
        die("usage: jb.py revoke <device-id>   (ids from: jb.py devices)", 2)
    print(json.dumps(relay_request("POST", "/admin/revoke", {"device": args[0]}), indent=2))


def finish_result(result):
    """Print a device result. The process status follows result['ok']."""
    print(json.dumps(result, indent=2))
    if isinstance(result, dict) and result.get("ok") is True:
        return 0
    return 1


def run_action(action, params, device="default"):
    """Send one command and return the device result dict.

    request_id is new for each call. A transport retry inside the operator
    reuses this same id; it does not enqueue a second browser command.
    """
    cmd = {
        "device": device,
        "action": action,
        "params": params,
        "request_id": "req_" + secrets.token_hex(8),
    }
    deadline = time.time() + 60

    # Fast path: enqueue and wait for the result in one request. The relay
    # answers the moment the browser reports back.
    res = relay_request("POST", "/admin/run", dict(cmd, wait=25), timeout=40, tolerate=(404,))
    if res.get("_status") == 404:
        # Relay predates /admin/run: enqueue, then poll for the result.
        res = relay_request("POST", "/admin/cmd", cmd)
    elif not res.get("pending"):
        result = res.get("result")
        if not isinstance(result, dict):
            die("relay returned no result")
        return result

    cmd_id = res["id"]
    while time.time() < deadline:
        started = time.time()
        # Current relays hold this request until the result lands (up to 20s).
        r = relay_request("GET", f"/admin/result?id={cmd_id}&wait=20", timeout=35)
        if not r.get("pending"):
            result = r.get("result")
            if not isinstance(result, dict):
                die("relay returned no result")
            return result
        if time.time() - started < 1:
            time.sleep(2.0)  # older relay answered at once: don't hammer it
    die(f"timeout waiting for device (id {cmd_id})")


def cmd_operator(args):
    mod = operator_mod()
    if args == ["stop"]:
        try:
            mod.stop()
        except mod.OperatorError as exc:
            die(str(exc), 2)
        print("operator stopped")
        return 0
    if args:
        die("usage: jb.py operator [stop]", 2)
    try:
        return mod.serve()
    except mod.OperatorError as exc:
        die(str(exc), 2)


def cmd_send(args):
    if not args:
        die("usage: jb.py send <action> [params-json] [device]", 2)
    action = args[0]
    try:
        params = json.loads(args[1]) if len(args) > 1 else {}
    except json.JSONDecodeError as e:
        die(f"bad params JSON: {e}", 2)
    device = args[2] if len(args) > 2 else "default"
    return finish_result(run_action(action, params, device))


_operator = None


def operator_mod():
    """Load the local operator. Importing it does not start the process."""
    global _operator
    if _operator is None:
        # Not operator.py: running this file puts driver/ on sys.path, and that
        # name would shadow the stdlib operator module during startup.
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "juno_operator.py")
        spec = importlib.util.spec_from_file_location("juno_operator", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _operator = mod
    return _operator



def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmds = {"init": cmd_init, "bootstrap": cmd_bootstrap, "pair": cmd_pair,
            "ping": cmd_ping, "devices": cmd_devices, "revoke": cmd_revoke,
            "send": cmd_send, "operator": cmd_operator}
    fn = cmds.get(argv[1])
    if not fn:
        die(f"unknown command: {argv[1]}", 2)
    code = fn(argv[2:])
    return 0 if code is None else code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
