# Juno Bridge

Let an AI operator drive your Chrome browser — on your terms. Juno Bridge is a
small, self-hosted bridge: a Chrome (MV3) extension on your machine, an
unlisted Cloudflare Worker relay, and a driver CLI for the operator. The
operator sends commands (navigate, snapshot, click, type…); the extension
executes them against your real browser profile and returns results.

You stay in charge the whole time:

- **Kill switch** — pause the extension from its side panel; commands stop instantly.
- **Site allowlist** — the operator can only act on domains you list. Empty by default.
- **Activity log** — every action is recorded locally for you to inspect.
- **Pairing codes** — browsers join with single-use, 10-minute codes; no open enrollment.
- **No credential exposure** — the relay stores only the SHA-256 of your admin passphrase.

## Layout

| Path | Runs on | What it does |
|---|---|---|
| `extension/` | Your Chrome (load unpacked) | Polls the relay, runs commands via `chrome.debugger` (CDP), side panel with kill switch + activity log, Options page for pairing + allowlist |
| `relay/worker.js` | Cloudflare Worker (unlisted) | Message bus: admin endpoints (passphrase auth), device registration via pairing codes, per-command queues + results in KV |
| `driver/jb.py` | Operator's machine | CLI: `init`, `bootstrap`, `pair`, `ping`, `send` |

## Setup

### 1 · Deploy the relay

1. In the [Cloudflare dashboard](https://dash.cloudflare.com), create a Worker (any name, e.g. `juno-bridge`).
2. Create a KV namespace (e.g. `juno-bridge`) and bind it to the Worker as `BRIDGE`.
3. Paste `relay/worker.js` as the Worker's code and deploy. Note your Worker's `*.workers.dev` URL — keep it unlisted.

### 2 · Point the extension at your relay

1. In `extension/config.js`, set `JUNO_RELAY_URL` to your Worker URL.
2. In `extension/manifest.json`, replace `YOUR-RELAY.workers.dev` in `host_permissions` with your Worker's host.
3. Zip the `extension/` folder contents (or load the folder directly).

### 3 · Load the extension

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the extension folder.
2. Open the extension's **Options** page.

### 4 · Configure the driver

On the operator's machine:

```bash
export JUNO_BRIDGE_PSK="a-long-random-passphrase-you-invent"
# …or store it in ~/.config/juno-bridge/psk (chmod 600) instead of the env var
python3 driver/jb.py init https://YOUR-RELAY.workers.dev
python3 driver/jb.py bootstrap   # one-shot: locks the relay to your passphrase
```

The relay stores only the SHA-256 hash — the passphrase itself never leaves your machines.

### 5 · Pair the browser

```bash
python3 driver/jb.py pair
```

Read the code to the browser owner. In the extension's Options page, enter a
device name and the code, then click **Register**. Add your site allowlist
(one domain per line) and click **Save settings**.

## Driving it

```bash
python3 driver/jb.py ping                                        # relay + device count
python3 driver/jb.py send tabs                                  # list open tabs
python3 driver/jb.py send navigate '{"url":"https://example.com"}'
python3 driver/jb.py send snapshot '{"tabId":123456}'           # accessibility snapshot
python3 driver/jb.py send click '{"tabId":123456,"x":722,"y":42}'
python3 driver/jb.py send type '{"tabId":123456,"text":"hello"}'
python3 driver/jb.py send key '{"tabId":123456,"key":"Enter"}'
python3 driver/jb.py send screenshot '{"tabId":123456}'          # returns JPEG data URI
```

`send` waits up to 60 seconds for the device result and prints it as JSON.
Commands target explicit tab IDs and open new tabs in the background — the
operator never takes your mouse, keyboard, or active tab.

Actions: `ping`, `tabs`, `navigate`, `screenshot`, `snapshot`, `click`,
`type`, `key`, `eval` (`eval` runs arbitrary page JS and is off by default —
enable it in Options only if you understand the implications).

## Notes

- The extension polls the relay every ~2.5 seconds; after waking from sleep it
  can take up to a minute to pick up the first command (a 1-minute watchdog
  alarm restarts the poll loop).
- Commands and results expire after 10 minutes.
- While a command runs against a tab, Chrome shows a brief "debugging" banner
  on that tab only.
- `driver/jb.py` shells out to `curl` because some Cloudflare-fronted hosts
  block Python `urllib`'s TLS fingerprint at the edge.

## License

MIT — see [LICENSE](LICENSE).
