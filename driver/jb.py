#!/usr/bin/env python3
"""Juno Bridge driver CLI — the operator's side of the browser bridge.

Setup:
  export JUNO_BRIDGE_PSK="your-admin-passphrase"   # or store it in
                                                   # ~/.config/juno-bridge/psk (mode 0600)
  jb.py init https://YOUR-RELAY.workers.dev
  jb.py bootstrap      # one-shot: lock the relay to your passphrase
  jb.py pair           # mint a 10-minute pairing code for the browser
  jb.py ping           # check relay + device count
  jb.py devices        # list paired browsers (id, name, connected, pending)
  jb.py revoke <device-id>
                       # unpair a browser (lost laptop, stale pairing)
  jb.py send <action> [params-json] [device]
                       # e.g. jb.py send navigate '{"url":"https://example.com"}'
                       # waits up to 60s for the result and prints it

Actions: ping, tabs, navigate, screenshot, snapshot, text, click, type, key,
         scroll, close, eval

Security notes:
  - The passphrase is a bearer secret. It travels only in an
    `Authorization: Bearer` header, never in URLs or logs. Keep it out of
    shell history (prefer the psk file over the env var on shared machines).
  - The relay stores only the SHA-256 of the passphrase, never the value.
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import time

CONFIG_DIR = os.path.expanduser("~/.config/juno-bridge")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
PSK_FILE = os.path.join(CONFIG_DIR, "psk")
PSK_ENV = "JUNO_BRIDGE_PSK"


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


def relay_request(method, path, data=None, timeout=30, tolerate=()):
    """Relay call via curl. HTTP statuses in `tolerate` are returned (with the
    status under "_status") instead of aborting.

    curl is used instead of Python's urllib because some Cloudflare-fronted
    hosts block urllib's TLS fingerprint (HTTP 403, error 1010) before the
    request reaches the Worker, while curl's fingerprint passes.
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


def cmd_bootstrap(_args):
    print(json.dumps(relay_request("POST", "/admin/bootstrap", {}), indent=2))


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


def cmd_send(args):
    if not args:
        die("usage: jb.py send <action> [params-json] [device]", 2)
    action = args[0]
    try:
        params = json.loads(args[1]) if len(args) > 1 else {}
    except json.JSONDecodeError as e:
        die(f"bad params JSON: {e}", 2)
    device = args[2] if len(args) > 2 else "default"
    cmd = {"device": device, "action": action, "params": params}
    deadline = time.time() + 60

    # Fast path: enqueue and wait for the result in one request. The relay
    # answers the moment the browser reports back.
    res = relay_request("POST", "/admin/run", dict(cmd, wait=25), timeout=40, tolerate=(404,))
    if res.get("_status") == 404:
        # Relay predates /admin/run: enqueue, then poll for the result.
        res = relay_request("POST", "/admin/cmd", cmd)
    elif not res.get("pending"):
        print(json.dumps(res["result"], indent=2))
        return

    cmd_id = res["id"]
    while time.time() < deadline:
        started = time.time()
        # Current relays hold this request until the result lands (up to 20s).
        r = relay_request("GET", f"/admin/result?id={cmd_id}&wait=20", timeout=35)
        if not r.get("pending"):
            print(json.dumps(r["result"], indent=2))
            return
        if time.time() - started < 1:
            time.sleep(2.0)  # older relay answered at once: don't hammer it
    die(f"timeout waiting for device (id {cmd_id})")


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmds = {"init": cmd_init, "bootstrap": cmd_bootstrap, "pair": cmd_pair,
            "ping": cmd_ping, "devices": cmd_devices, "revoke": cmd_revoke,
            "send": cmd_send}
    fn = cmds.get(argv[1])
    if not fn:
        die(f"unknown command: {argv[1]}", 2)
    fn(argv[2:])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
