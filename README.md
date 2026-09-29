# Juno Bridge

Experimental developer preview. Juno Bridge lets an operator drive Chrome
through a self-hosted relay: an MV3 extension, an unlisted Cloudflare Worker,
and a driver CLI. Try it in a separate Chrome profile. It is not ready to
attach to the browser profile you use every day.

The operator sends commands (navigate, snapshot, click, type, …). The relay
pushes them to the extension over a WebSocket, and the extension runs them
with `chrome.debugger`. Commands and results pass through the relay. This
tree is extension v1.3.0.

## What the safeguards actually do

- **Pause** stops further commands. The local queue is dropped, an in-flight
  command is cancelled at the next browser mutation, debugger sessions are
  detached, and the socket is closed. An action already sent to Chrome is not
  undone: a mouse event or navigation Chrome has already accepted stays sent.
- **Freshness is checked at execution**, not when the command arrives. Age is
  the command's age on the relay at delivery, plus the time it then waited on
  this machine, including time queued behind other commands. Older than two
  minutes is refused. A missing or unusable timestamp is refused.
- **Pause does not continue the in-memory queue on resume.** A command that
  had not been taken stays on the relay with no result, and a later delivery
  runs only if it is still inside the two-minute window. A command already
  taken is not retried; if pause cancelled it, the result is
  `cancelled: extension paused`. A pause shorter than two minutes can still
  allow a fresh redelivery. That is the window, not a resume of local work.
- **Existing-tab commands require `tabId`.** Omitting it is an error. There
  is no fallback to whichever tab is active. `navigate` without `tabId`
  opens a new background tab (`active: false`).
- **A command is bound to one page.** The tab URL is checked against the
  allowlist, then the tab URL and the document location are checked again
  immediately before each mutation or read. Navigation off that page aborts
  the rest of the command. The error does not include the new URL.
- **Allowlist.** Empty by default. Only `http` and `https` pages on domains
  you list can be acted on, and a domain covers its subdomains. `tabs` shows
  allowlisted tabs and only counts the rest.
- **Activity log.** Actions are recorded locally, including failures.
- **Pairing.** Browsers join with single-use codes that expire after 10
  minutes. Revoking a device closes its live socket and rejects its later
  polls.
- **Result ownership.** The relay remembers which device a command was issued
  to. That record survives delivery acknowledgement and lasts until the
  result is accepted or it expires (10 minutes). Another device cannot submit
  the result. The first result from the owning device is kept; a repeat is
  `{ok: true, duplicate: true}` and does not replace it.
- **Result delivery.** A WebSocket `send` is not enough. The extension waits
  for `{type: "result_ack"}`. On timeout it posts the result to `POST /result`.
  `{type: "result_rejected"}` is final and is not posted again.

## Privacy

The relay stores a hash of the admin passphrase. The driver transmits the passphrase over HTTPS for authentication. Commands and browser results pass through the relay. Snapshot redaction reduces exposure of recognized sensitive fields but does not guarantee removal of all sensitive information.

Snapshot values are omitted for password and hidden inputs, for autocomplete
tokens `cc-*`, `current-password`, `new-password`, and `one-time-code`, and
for fields whose name, id, placeholder, label, class, or aria-label matches a
password, payment, or one-time-code pattern. A field with none of those
signals is included. The result says `redaction: "heuristic"`.

Screenshots are unmasked (`redaction: "none"`). `text` is visible page text
with no sensitive-content filter (`redaction: "none"`). `eval` is off by
default and bypasses redaction.

Storing only a hash is not the same as the passphrase never leaving your
machines. `jb.py` sends it in an `Authorization: Bearer` header over HTTPS.

## Layout

| Path | Runs on | What it does |
|---|---|---|
| `extension/` | Your Chrome (load unpacked) | WebSocket to the relay, HTTP polling fallback, commands via `chrome.debugger`, side panel (pause, connection, activity log), Options (pairing, allowlist) |
| `relay/worker.js` | Cloudflare Worker + Durable Object (unlisted) | Admin API, device registration, per-device queues, result ownership |
| `relay/wrangler.jsonc` | Your machine | Deploy config. `ADMIN_PSK_SHA256` is required |
| `driver/jb.py` | Operator's machine | CLI: `init`, `bootstrap`, `pair`, `ping`, `devices`, `revoke`, `send` |

## Breaking changes in 1.3.0

- Operational routes stay dark until `ADMIN_PSK_SHA256` is set to the hex
  SHA-256 of the admin passphrase. A relay locked with the old
  `POST /admin/bootstrap` endpoint needs that secret set to the same
  passphrase's hash before admin calls work again. Paired device tokens are
  unchanged. A hash stored in the Durable Object, including one imported from
  KV, does not authenticate.
- `jb.py bootstrap` prints the secret-setup command and the expected hash.
  It does not contact the relay and cannot claim one.
- Existing-tab commands require `tabId`.
- `jb.py send` exits 1 when the device result's `ok` is not true. The JSON
  result is still printed on stdout.

## Setup

Use a passphrase of at least 16 characters. Deploy first. Until the secret is
set, `GET /` reports `configured: false`, `POST /admin/bootstrap` returns
410, and every other route returns 503. Nobody can claim the passphrase in
that window.

```bash
export JUNO_BRIDGE_PSK="a-long-random-passphrase-you-invent"
# or store it in ~/.config/juno-bridge/psk (chmod 600)
cd relay
npx wrangler login
npx wrangler deploy
printf '%s' "$JUNO_BRIDGE_PSK" | shasum -a 256 | cut -d' ' -f1 | npx wrangler secret put ADMIN_PSK_SHA256
```

`python3 driver/jb.py bootstrap` prints that same command and the expected
SHA-256. It does not send the passphrase.

Keep the `*.workers.dev` URL unlisted. Then point the driver at it and
confirm the secret is in place:

```bash
python3 driver/jb.py init https://YOUR-RELAY.workers.dev
python3 driver/jb.py ping
```

**Upgrading from the KV-based relay (v1.0.x)?** Uncomment the `kv_namespaces`
block in `relay/wrangler.jsonc`, put your old namespace id in it
(`npx wrangler kv namespace list`), and boot once. Paired browsers are
imported. The imported passphrase hash is not a credential; set
`ADMIN_PSK_SHA256` as above. Remove the KV binding after that boot.

**Updating the extension:** copy the new files into the folder Chrome already
loads it from, then click the reload icon on its card in `chrome://extensions`.
Chrome derives an unpacked extension's identity from its folder path, so
loading the update from a different folder installs a fresh copy that has to
be paired again. Each Chrome profile is its own device.

### Point the extension at your relay

1. In `extension/config.js`, set `JUNO_RELAY_URL` to your Worker URL.
2. In `extension/manifest.json`, replace `YOUR-RELAY.workers.dev` in `host_permissions` with your Worker's host.
3. Load that folder in a separate Chrome profile: `chrome://extensions`, Developer mode, **Load unpacked**.
4. Open Options. The page is an experimental-preview notice on purpose.

### Pair the browser

```bash
python3 driver/jb.py pair
```

Read the code to the browser owner. In Options, enter a device name and the
code, then click **Register**. The toolbar icon opens the side panel, which
shows whether the live connection is up. Add the site allowlist (one domain
per line) and click **Save settings**.

## Driving it

```bash
python3 driver/jb.py ping
python3 driver/jb.py devices
python3 driver/jb.py send tabs
python3 driver/jb.py send navigate '{"url":"https://example.com"}'          # new background tab
python3 driver/jb.py send snapshot '{"tabId":123456}'
python3 driver/jb.py send click '{"tabId":123456,"x":722,"y":42}'
python3 driver/jb.py send type '{"tabId":123456,"text":"hello"}'
python3 driver/jb.py send key '{"tabId":123456,"key":"Enter"}'
python3 driver/jb.py send screenshot '{"tabId":123456}'                      # JPEG data URI, unmasked
python3 driver/jb.py send text '{"tabId":123456}'                            # visible text, unfiltered
python3 driver/jb.py send scroll '{"tabId":123456,"dy":600}'
python3 driver/jb.py send close '{"tabId":123456}'
python3 driver/jb.py send tabs '{}' a1b2c3d4                                 # one browser, by id prefix
```

`ping` and `tabs` take no tab. `navigate` opens a background tab when
`tabId` is omitted, or reuses a tab when `tabId` is set and that tab's
current page is allowlisted. Every other action requires `tabId`.

`send` waits up to 60 seconds, prints the device result as JSON on stdout,
and exits 1 when `ok` is not true. With several paired browsers, commands go
to the most recently paired one unless you pass a device id (from
`devices`). `revoke <device-id>` unpairs one.

Actions: `ping`, `tabs`, `navigate`, `screenshot`, `snapshot`, `text`,
`click`, `type`, `key`, `scroll`, `close`, `eval` (`eval` runs arbitrary page
JS and is off by default — enable it in Options only if you understand that
it bypasses redaction).

`navigate` waits for the page to load. It reports `"redirectedOffAllowlist": true`
instead of revealing where an off-allowlist redirect went. `key` supports
Enter (submits forms), Tab, Escape, Backspace, Delete, arrows, Home/End,
PageUp/PageDown, and Space.

While a command runs against a tab, Chrome shows its debugging banner on
that tab. New tabs open in the background.

## Relay API

All admin calls take `Authorization: Bearer <passphrase>` over HTTPS.
`GET /` returns `{service, ok: true, configured}` and does not mean the
relay is ready to use; `configured` is true only when `ADMIN_PSK_SHA256` is
a 64-character hex SHA-256.

| Endpoint | Purpose |
|---|---|
| `POST /admin/run` `{action, params, device?, wait?}` | Enqueue and wait up to `wait` s (default 30, max 60) for the result |
| `POST /admin/cmd` `{action, params, device?}` | Enqueue only; returns `id` |
| `GET /admin/result?id=…&wait=…` | Consume a result, waiting up to `wait` s (default 10; `wait=0` answers at once) |
| `GET /admin/devices` · `POST /admin/revoke {device}` | List / unpair browsers |
| `POST /admin/pair` · `GET /admin/ping` | Pairing code · health |
| `POST /admin/bootstrap` | Disabled. Returns 410 `bootstrap_disabled` |

Device routes (`/register`, `/poll`, `/result`, `/unregister`, `/ws`) carry
the device token in the POST body or the first WebSocket message, never in
the URL. `POST /result` and a WebSocket result are accepted only from the
device the command was issued to.

## Notes

- Commands are pushed over the extension's WebSocket when they are sent. If
  the socket cannot be opened, the extension polls every ~2.5 seconds and
  retries the socket about once a minute. A 1-minute alarm restarts the
  loop after Chrome suspends the extension.
- Delivery is at-most-once: the extension records each command's sequence
  number before running it, so a dropped connection does not repeat a click.
- Uncollected commands expire after 3 minutes. Results and the
  command-to-device record expire after 10 minutes.
- `driver/jb.py` shells out to `curl` because some Cloudflare-fronted hosts
  block Python `urllib`'s TLS fingerprint at the edge.

Automated checks (no Chrome, no deploy):

```bash
node --test
python3 -m unittest discover -s test -p 'test_*.py'
```

## License

MIT — see [LICENSE](LICENSE).
