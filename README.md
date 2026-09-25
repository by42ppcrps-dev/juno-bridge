# Juno Bridge

Let an AI operator drive your Chrome browser — on your terms. Juno Bridge is a
small, self-hosted bridge: a Chrome (MV3) extension on your machine, an
unlisted Cloudflare Worker relay, and a driver CLI for the operator. The
operator sends commands (navigate, snapshot, click, type…); the relay pushes
them to the extension over a live WebSocket the instant they're sent, and the
extension executes them against your real browser profile and returns results.

You stay in charge the whole time:

- **Kill switch** — pause the extension from its side panel; commands stop instantly.
- **Site allowlist** — the operator can only act on domains you list. Empty by default.
- **Activity log** — every action is recorded locally for you to inspect, including why anything failed.
- **Stale commands refused** — anything queued more than 2 minutes ago (say, while paused) is rejected, not run.
- **Secrets stay put** — page snapshots never include password, payment, or one-time-code field values, and `tabs` only reveals allowlisted tabs.
- **Pairing codes** — browsers join with single-use, 10-minute codes; no open enrollment.
- **No credential exposure** — the relay stores only the SHA-256 of your admin passphrase.

## Layout

| Path | Runs on | What it does |
|---|---|---|
| `extension/` | Your Chrome (load unpacked) | Holds a live WebSocket to the relay (HTTP polling fallback), runs commands via `chrome.debugger` (CDP), side panel with kill switch + connection state + activity log, Options page for pairing + allowlist |
| `relay/worker.js` | Cloudflare Worker + Durable Object (unlisted) | Message bus: admin endpoints (passphrase auth), device registration via pairing codes, per-device command queues pushed over WebSockets, results returned the moment they land |
| `relay/wrangler.jsonc` | Your machine | Deploy config for the relay |
| `driver/jb.py` | Operator's machine | CLI: `init`, `bootstrap`, `pair`, `ping`, `devices`, `revoke`, `send` |

## Setup

### 1 · Deploy the relay

The relay keeps all state in a single SQLite-backed
[Durable Object](https://developers.cloudflare.com/durable-objects/), which
works on Cloudflare's free plan. Deploy it with Wrangler (the Durable Object
binding can't be set up by pasting code into the dashboard):

```bash
cd relay
npx wrangler login
npx wrangler deploy
```

Note the `*.workers.dev` URL it prints — keep it unlisted.

**Upgrading from the KV-based relay (v1.0.x)?** Uncomment the `kv_namespaces`
block in `relay/wrangler.jsonc` and put your old namespace id in it
(`npx wrangler kv namespace list`). On first boot the relay imports your
passphrase hash and paired browsers, so nothing needs re-pairing. The old
driver and extensions keep working against the new relay while you upgrade.

**Updating the extension:** copy the new files into the folder Chrome already
loads it from, then click the reload ↻ icon on its card in `chrome://extensions`.
Chrome derives an unpacked extension's identity from its folder path, so
loading the update from a *different* folder installs a fresh copy that has to
be paired again. Each Chrome profile is its own device.

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
device name and the code, then click **Register**. Clicking the extension's
toolbar icon opens the side panel, which shows whether the live connection is up. Add your site allowlist
(one domain per line) and click **Save settings**.

## Driving it

```bash
python3 driver/jb.py ping                                        # relay + device count
python3 driver/jb.py devices                                     # paired browsers + who's connected
python3 driver/jb.py send tabs                                  # list open (allowlisted) tabs
python3 driver/jb.py send navigate '{"url":"https://example.com"}'
python3 driver/jb.py send snapshot '{"tabId":123456}'           # accessibility snapshot
python3 driver/jb.py send click '{"tabId":123456,"x":722,"y":42}'
python3 driver/jb.py send type '{"tabId":123456,"text":"hello"}'
python3 driver/jb.py send key '{"tabId":123456,"key":"Enter"}'
python3 driver/jb.py send screenshot '{"tabId":123456}'          # returns JPEG data URI
python3 driver/jb.py send text '{"tabId":123456}'                # visible page text
python3 driver/jb.py send scroll '{"tabId":123456,"dy":600}'
python3 driver/jb.py send close '{"tabId":123456}'
python3 driver/jb.py send tabs '{}' a1b2c3d4                     # target one browser by id
```

`send` waits up to 60 seconds for the device result and prints it as JSON.
With several paired browsers, commands go to the most recently paired one
unless you pass a device id (from `devices`). `revoke <device-id>` unpairs one.
Commands target explicit tab IDs and open new tabs in the background — the
operator never takes your mouse, keyboard, or active tab.

Actions: `ping`, `tabs`, `navigate`, `screenshot`, `snapshot`, `text`,
`click`, `type`, `key`, `scroll`, `close`, `eval` (`eval` runs arbitrary page
JS and is off by default — enable it in Options only if you understand the
implications).

`navigate` waits for the page to load and can reuse a tab (`"tabId"`); it
reports `"redirectedOffAllowlist": true` instead of revealing where an
off-allowlist redirect went. `key` supports Enter (submits forms), Tab,
Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown and Space.

### Relay API (for other drivers)

All admin calls take `Authorization: Bearer <passphrase>`.

| Endpoint | Purpose |
|---|---|
| `POST /admin/run` `{action, params, device?, wait?}` | Enqueue and wait up to `wait` s (default 30, max 60) for the result — one round trip |
| `POST /admin/cmd` `{action, params, device?}` | Enqueue only; returns `id` |
| `GET /admin/result?id=…&wait=…` | Consume a result, waiting up to `wait` s (default 10; `wait=0` answers at once) |
| `GET /admin/devices` · `POST /admin/revoke {device}` | List / unpair browsers |
| `POST /admin/pair` · `GET /admin/ping` · `POST /admin/bootstrap` | Pairing code · health · one-shot setup |

## Notes

- Commands are pushed over the extension's WebSocket as soon as they're sent;
  a relay round trip is typically well under a second. If the socket can't be
  opened, the extension falls back to polling every ~2.5 seconds and retries
  the socket every minute. A 1-minute watchdog alarm restarts everything
  after Chrome suspends the extension.
- Delivery is at-most-once: the extension records each command before running
  it, so a dropped connection never repeats a click.
- Uncollected commands expire after 3 minutes; results after 10.
- While a command runs against a tab, Chrome shows a brief "debugging" banner
  on that tab only.
- `driver/jb.py` shells out to `curl` because some Cloudflare-fronted hosts
  block Python `urllib`'s TLS fingerprint at the edge.

## License

MIT — see [LICENSE](LICENSE).
