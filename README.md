# Juno Bridge

Experimental developer preview. Juno Bridge lets an operator drive Chrome
through a self-hosted relay: an MV3 extension, an unlisted Cloudflare Worker,
and a driver CLI. Try it in a separate Chrome profile. It is not ready to
attach to the browser profile you use every day.

The operator sends commands (navigate, snapshot, click, type, …). The relay
pushes them to the extension over a WebSocket, and the extension runs them
with `chrome.debugger`. Commands and results pass through the relay. This
tree is extension v1.4.9.

## Fixes in 1.4.9

A failed write of the panel's polling connection status no longer prevents a
received command from being delivered. Pairing, permission and pause checks
still run after that write attempt, and command progress must still be saved
before execution. This is an extension-only hardening change; the relay is
unchanged.

Polling carries the local HTTP receipt time through body parsing and status
updates, so those waits count toward the command's two-minute execution limit.

## Fixes in 1.4.8

An opened WebSocket that never receives its authenticated welcome now uses
HTTP polling for a bounded minute before trying a fresh ticket. Explicit
device rejection still stops delivery. This fixes a reproduced recovery gap;
it does not establish why a particular live browser failed to respond.

The panel's connection message now ages out after a minute without recent
relay confirmation. Successful empty polls and welcomed socket heartbeats
refresh that evidence without writing storage on every poll. Reconnecting
clears the previous success message.

Relay transport diagnostics record public device prefixes, command IDs,
numeric queue cursors, receipt times and fixed handshake error codes. They
exclude credentials, tickets, command parameters, page content and result
payloads. A queue acknowledgment confirms progress in delivery, not that an
action executed; a committed result supplies that separate evidence.

## What the safeguards actually do

- **Pause** stops further commands. The local queue is dropped, an in-flight
  command is cancelled at the next browser mutation, debugger sessions are
  detached, and the socket is closed. The check runs again after an awaited
  tab lookup, immediately before the browser call, so a reused-tab navigation
  cannot start after pause. An action already sent to Chrome is not undone:
  a mouse event or navigation Chrome has already accepted stays sent.
- **A command times out after 30 seconds.** That command is invalidated
  before the failure is reported. A browser response that arrives later
  cannot attach the debugger or continue the action. The following command
  is not held behind the abandoned handler.
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
- **Permission changes** cancel active commands and clear queued work. Changing
  the allowlist or eval permission invalidates the command's policy; reads
  are discarded if the document or permissions changed while Chrome was
  producing them. Input Chrome already accepted cannot be undone.
- **Activity log.** Actions are recorded locally, including failures. A
  result-delivery failure is shown separately from whether the action ran;
  the action is not repeated to recover a lost delivery.
- **Pairing.** Browsers join with single-use codes that expire after 10
  minutes. Revoking a device closes its live socket and rejects its later
  polls. If Register and Unregister overlap, the later choice wins. Re-pairing
  reports a failed old-device revocation with a command to revoke it manually.
- **Result ownership.** The relay remembers which device a command was issued
  to. That record survives delivery acknowledgement and lasts until the
  result is accepted or it expires (10 minutes). Another device cannot submit
  the result. The first result from the owning device is kept; a repeat is
  `{ok: true, duplicate: true}` and does not replace it.
- **Result delivery.** A WebSocket `send` is not enough. The extension waits
  for `{type: "result_ack"}`. On timeout it posts the result to `POST /result`.
  `{type: "result_rejected"}` is final and is not posted again. The extension
  in this source tree also authenticates HTTP results with a device-token header
  before uploading its body, so an unfinished anonymous upload cannot occupy
  their result-upload slot.

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
| `driver/jb.py`, `driver/juno_operator.py` | Operator's machine | CLI plus a user-scoped operator process on a private Unix socket. The process keeps one relay client and a separate TypeSafe client when optional Jev is used. `JUNO_OPERATOR=0` uses one curl subprocess per relay request. Jev is off by default and uses your own API key. |

## Fixes in 1.3.1

- Reused-tab `navigate` checks pause again after its second tab lookup,
  immediately before `chrome.tabs.update`.
- A command that reaches the 30 second limit is cancelled for good. A late
  response from the browser cannot continue it.

## Fewer round trips in 1.4.0

A click, key, type, or scroll can carry `after`. The extension performs the
action, waits for an optional readiness condition, and returns that
observation in the same result. `after.observe` is `snapshot` or `text`.
`after.ready.type` is `text`, `element_visible`, or `element_enabled`.
`text` matches visible page text. `element_visible` and `element_enabled`
name a `ref` from an earlier `snapshot` and include that snapshot id.
`timeoutMs` from 0 to 15000 is the budget for that condition. `0` checks
the page once. The snapshot id and `timeoutMs` are checked before input
is sent. The ref has to match the browser node id saved for that snapshot.
A node that cannot be verified stops the command before input is sent.
The budget is not a sleep, and the relay's `wait` is a
maximum: the response is sent when the result arrives. Shortening `wait`
does not shorten the browser action.

`workflow` runs 1 to 10 already-chosen steps on one tab. The steps are
`click` (by snapshot `ref`), `type`, `key`, `scroll`, `snapshot`, `text`,
and `wait`. A click, or an element readiness condition, requires the
snapshot id returned by `snapshot`. The extension resolves those refs
against that capture's browser node ids. If the document changed, a newer
snapshot replaced that id, or the node can no longer be resolved, the
workflow refuses the reference instead of clicking a different element. A
bound click also checks that the captured element is at the click point
immediately before input; a page change after that check can still make a
coordinate click uncertain. A `snapshot` step inside a workflow is only a
view of the live page and does not retarget the authorized refs. The extension keeps one debugger attachment for that list and
releases it when the workflow finishes or is interrupted. A workflow holds the debugger until that workflow finishes, then releases it.
Pause, the allowlist, and the page check still run on every step.
No model call runs inside the workflow.

```bash
python3 driver/jb.py send click '{"tabId":123456,"x":50,"y":30,"after":{"observe":"snapshot","ready":{"type":"text","text":"Results","timeoutMs":15000}}}'
python3 driver/jb.py send workflow '{"tabId":123456,"snapshot":"snap_0123456789abcdef0123456789abcdef","steps":[{"op":"click","ref":"e1"},{"op":"type","text":"invoice"},{"op":"key","key":"Enter"}]}'
```

## Fixes in 1.4.1

- The operator's reused HTTP client clears the previous request method
  before each request, so a GET that follows a POST is sent as a GET.
- A workflow reference resolves only against the snapshot id the caller
  selected. A missing or replaced capture is refused.
- `element_visible` and `element_enabled` use that same snapshot id, and
  `timeoutMs` is checked before input is sent.

## Fixes in 1.4.2

- A snapshot ref is stored with Chrome's node id for that document. The
  extension does not recover a target from attributes on the page. After the
  debugger reconnects, the ref resolves to that node, or the command stops
  before input. A replacement that copied the old attributes is refused,
  including one with the same tag and label. If this worker restarts, the
  saved ids are gone and the old snapshot is refused.

## Fixes in 1.4.3

- A snapshot id is 128 random bits (`snap_` plus 32 hex digits). After this
  worker restarts, a new capture gets a different id. An id saved earlier
  is refused, including when that new capture would otherwise have reused it.
- The extension binding has to be present every time a snapshot id is used.
  A page that still holds the id is not accepted when the binding is gone.

## Fixes in 1.4.5

- The operator answers a health check while a relay request is
  still running. A client that disconnects, including a write to a closed
  socket, does not stop the process. Relay calls stay on one
  worker, so they do not share a connection handle. A request that already
  left is not sent again because the caller went away.
- The observation after an action or workflow is a new snapshot: its own
  `snap_` id, the document, and the extension's node bindings. It does not
  reuse the id the action started with. A later step in that same workflow
  still uses the starting snapshot. `--observation` reads that object, a
  snapshot result, or the saved `data.observation` / `click.observation`
  wrapper.

## Fixes in 1.4.6

- A device authenticates before the relay accepts its WebSocket. The
  extension obtains a durable, one-use upgrade ticket that expires after
  30 seconds and offers it as a WebSocket subprotocol. The device token
  stays in the ticket request's POST body; neither token nor ticket is put
  in the URL. Anonymous upgrades cannot occupy the relay's socket slots.
  Older extensions and relays keep working through HTTP polling.
- Poll replies, commands, and result receipts belong to the pairing and
  policy that started them. Re-pairing, pausing, or changing permissions
  discards stale work; an old result is never sent on a new device's socket.
  Polling and result delivery have deadlines covering the response body.
  Saved command positions are scoped to each device; a late write from an
  old pairing cannot overwrite the new pairing's progress. Existing numeric
  positions migrate without resetting the current device's cursor.
- Admin authentication happens before body reading. Request bodies,
  readers, retained results, queues, registry records, sockets, and waiters
  have explicit limits. Sizes count UTF-8 bytes. Periodic cleanup and
  revocation remove expired or revoked state in bounded storage batches.
- Results are durably stored before acknowledgment, including large
  screenshots. The primary result and repeated `request_id` share one
  chunked payload, so a relay restart or consuming the primary result does
  not lose the repeated-request receipt. Command ownership, the queue, and
  the idempotency receipt are committed together. A failed legacy import
  remains incomplete and can be retried.

The relay accepts ordinary JSON bodies up to 64 KiB and result POST bodies
up to 10 MiB, with a 15-second read deadline. A stored result is at most
8 MiB; larger accepted records become an explicit `result_too_large`
failure. Primary and replay results share a 16 MiB retained-payload budget.
At capacity, new requests fail explicitly instead of growing memory without
bound. These limits use UTF-8 bytes. Anonymous WebSocket upgrades are rejected
before acceptance; ordinary network flooding still requires platform-level
rate limits or upstream protection.

The extension in this source tree sends `x-juno-device-token` on
`POST /result` in addition to the token in the JSON body. The relay validates
the header before reading the body and requires it to match the body token.
Verified uploads have one reader per device, with two readers total to bound
memory use. A third simultaneous upload gets a retryable 429. Older body-only
clients use a separate bounded upload slot; an unfinished legacy upload can
delay another legacy upload, but cannot occupy a verified device's slot or a
WebSocket result commit. The relay must be updated before the new header path
takes effect.

These source changes do not alter a deployed relay or an already-loaded
browser extension. Deploy the relay and reload the extension after verification.

The result status is `completed`, `cancelled`, `interrupted`, `uncertain`,
or `unobserved`. `uncertain` means some input may already have reached
Chrome, including navigation, close, or enabled `eval`. A timed-out command
is not sent again. `jb.py` sends a `request_id`
with each action. The operator repeats a timed-out HTTP request with that
same id; the relay returns the existing command instead of starting another
one. While waiting for a current relay, the driver also reuses that id to
recover the result after an interrupted response. Two `send` calls are two
ids and two actions. Before sending a command, the driver fixes the selected
device when `/admin/devices` is available and checks whether the relay
advertises idempotency. Older relays use one command POST and consuming result
reads; an interrupted result response on that path can still have an uncertain
outcome.

The normal path is a user-scoped operator process on a private Unix socket.
It keeps one HTTP client for the relay and a separate client for optional
TypeSafe requests. A queued Jev call whose caller disconnects or times out
before admission is refused before a paid request is sent; once TypeSafe has
accepted a request, disconnecting cannot undo it.
Certificate verification stays on, and redirects are not followed.
A health check is answered while one of those requests is still running, and
a client that closes its socket does not stop the process.
After updating the operator source, run `python3 driver/jb.py operator stop`
once if the old process is still running. The next CLI request starts the new
process; until then, the updated CLI refuses relay and Jev calls to the old
process before they are sent.
`JUNO_OPERATOR=0` or `JUNO_BRIDGE_HTTP=curl` is the curl compatibility path:
one curl subprocess per relay request. Local native messaging is
not in this release.

Reusing the operator's relay connection avoids creating a new client for
every command, even with Jev off. Jev serves a different purpose: semantic
target or next-action selection that can reduce general-purpose model
round trips. It does not inherently shorten a deterministic relay API call.

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
`devices`). `revoke <device-id>` unpairs one. `jb.py send` does not call Jev.

`snapshot` returns an id (`snap_` plus 32 hex digits) and gives each
element a `ref` (`e1`, `e2`, …) in the order the page was walked. A ref
belongs to that snapshot id. The extension keeps Chrome's node id for each
captured element, scoped to that document. It does not treat attributes on
the page as the identity of a target. Pass the id to `workflow`, or to
`element_visible` and `element_enabled`, to use those elements. The next
snapshot replaces that id. A same-URL reload, a restarted extension worker,
or a node the browser can no longer resolve refuses the old id instead of
selecting a different element. A capture taken after that restart gets a
new id, so an earlier id is not reused. An `x`/`y` click still uses the
coordinates you send.

Actions: `ping`, `tabs`, `navigate`, `screenshot`, `snapshot`, `text`,
`click`, `type`, `key`, `scroll`, `close`, `workflow`, `eval` (`eval` runs
arbitrary page JS and is off by default — enable it in Options only if you
understand that it bypasses redaction). `workflow` is a list of 1 to 10
steps the operator already chose.

`navigate` waits for the page to load. It reports `"redirectedOffAllowlist": true`
instead of revealing where an off-allowlist redirect went. `key` supports
Enter (submits forms), Tab, Escape, Backspace, Delete, arrows, Home/End,
PageUp/PageDown, and Space.

While a command runs against a tab, Chrome shows its debugging banner on
that tab. New tabs open in the background.

## Optional Jev decisions — bring your own key

Jev is off by default. It can make a bounded semantic choice about one
snapshot using your own TypeSafe API key. There is no bundled key, shared
account, or free service supplied by this project. An enabled call sends
snapshot text to TypeSafe and may bill your account, including a choice of
`none` or a request whose result is refused by the browser safeguards.
Check TypeSafe's current account pricing and model limits before enabling it.

### Configure, enable, and disable

```bash
python3 driver/jb.py jev configure  # prompts without echoing your API key
python3 driver/jb.py jev on
python3 driver/jb.py jev status
python3 driver/jb.py jev off
```

`configure` stores the key in `~/.config/juno-bridge/jev-api-key` with mode
`0600`, readable only by its owner. It does not enable Jev, call TypeSafe, or
bill your account. `on` requires a configured key and persists
`jev_enabled: true` in that directory's `config.json`; `off` persists false.
`status` reports the effective setting and whether a key is configured,
without printing the key. These setup commands make no network requests.
The aliases `enable` and `disable` also work.

`JUNO_JEV=1` or `JUNO_JEV=0` overrides the persisted setting for that process.
Without either override, an absent setting means off. `TYPESAFE_API_KEY`
takes precedence over the private key file, so an existing secure environment
setup works with `JUNO_JEV=1` as well. Avoid putting a key in command arguments
or shell history. `JUNO_JEV_CONFIG_DIR` selects a different private config
directory; otherwise `JUNO_OPERATOR_DIR` is used if set, then
`~/.config/juno-bridge`. Keep it outside the repository.

If an operator is already running when you update this driver or change
`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, or proxy environment settings, run
`python3 driver/jb.py operator stop` before the next Jev command. The next
command starts the operator with the new environment. The driver rejects a
key or endpoint mismatch before making a paid request. Updating the private
key file or saved on/off setting applies to the next request without a
restart. A `JUNO_JEV` override is passed for each invocation.

When Jev is off, decision commands stop before contacting the relay or
TypeSafe. Turning it off prevents later requests; it cannot cancel billing
for a request already sent.

### Choose within the user's task

Name one or more of `target`, `page`, and `step`, a tab, and a goal of at most
500 characters. Questions on the same invocation share one TypeSafe request;
they cannot see each other's answers. A later decision is another request.

```bash
python3 driver/jb.py jev target --tab 123456 --goal "Find the invoice download page"
python3 driver/jb.py jev target page --tab 123456 --goal "Find the invoice download page"
python3 driver/jb.py jev target --tab 123456 --goal "Find the invoice download page" --observation snapshot.json --click
```

Without `--observation`, the command takes one ordinary relay snapshot.
With `--observation <file>`, it reuses the observation, a snapshot result,
or a saved `data.observation` / `click.observation` wrapper. The object must
include its `snap_` id, URL, and element list. This avoids taking another
snapshot when you already have a suitable observation.

| Decision | Choice | Effect |
|---|---|---|
| `target` | A snapshot ref (`e1`, `e2`, …) or `none` | Prints the choice; `--click` can submit the selected ref on that snapshot |
| `page` | `search_results`, `login_required`, `validation_error`, `unexpected`, or `other` | Prints the label; login, validation, and unexpected-page labels block a click |
| `step` | `proceed_with_selected_target`, `observe`, `recover`, or `escalate` | Only the proceed label permits continuing an explicitly requested click; the other labels do not act |

`--click` is an explicit action request and requires `target`. Keep the goal
within the user's authorized task; a model choice does not grant permission.
The driver checks confidence (`JUNO_JEV_MIN_CONFIDENCE`, default `0.8`), the
selected element, and the observation, then submits one workflow bound to
that snapshot id and ref. The browser verifies the saved node before input.
A stale or missing node is refused rather than replaced by a coordinate
click. `none`, a disabled or off-screen target, missing confidence, and a
blocking page or step decision do not click. Pause, the allowlist, `tabId`,
and the command deadline still apply. Confidence is not proof of correctness.

That workflow returns a new snapshot observation with its own id and node
bindings, which can be reused for the next decision. `--after-ready <json>`
adds one bounded readiness condition when a requested click needs the page
to settle: `text`, `element_visible`, or `element_enabled`, with `timeoutMs`
from 0 to 15000. Omitting it does not wait. For example:

```bash
python3 driver/jb.py jev target --tab 123456 --goal "Find the invoice download page" --observation snapshot.json --click --after-ready '{"type":"text","text":"Invoice","timeoutMs":5000}'
```

These are task-scoped choices and actions, not a background autonomous loop.
Combining a decision, a bound action, and the returned observation can reduce
extra model/relay round trips. There is no measured speedup or guaranteed
reduction in task time claimed here. Compare completion, elapsed time, wrong
actions, and general-purpose model calls on your own tasks with Jev on/off.

### API key and snapshot privacy

The TypeSafe key stays in the local driver/operator. It is never sent to the
relay, Chrome extension, or local Unix socket and must not appear in logs,
public issues, or repository files. The operator normally reads the key and
uses its separate TypeSafe client; the compatibility path reads it locally
for that command. Neither the extension nor the relay has a TypeSafe client.
Private key files are checked for ownership and restrictive permissions.

An enabled TypeSafe request sends the page title, URL, and element text and
metadata from the snapshot to the configured API origin. The default origin
is `https://api.typesafe.ai`; `TYPESAFE_BASE_URL` overrides it. Use an override
only for a service you trust with both your key and the page data. Snapshot
redaction is heuristic and cannot guarantee removal of every secret. A page
result still passes through the relay when captured; its TypeSafe request is
a separate transmission. Do not enable a decision for data you are unwilling
to send there. `jb.py send` stays independent of this optional integration.

## Relay API

All admin calls take `Authorization: Bearer <passphrase>` over HTTPS.
`GET /` returns `{service, ok: true, configured}` and does not mean the
relay is ready to use; `configured` is true only when `ADMIN_PSK_SHA256` is
a 64-character hex SHA-256.

| Endpoint | Purpose |
|---|---|
| `POST /admin/run` `{action, params, device?, wait?, request_id?}` | Enqueue and wait up to `wait` s (default 30, max 60) for the result. The same `request_id` returns the existing command |
| `POST /admin/cmd` `{action, params, device?, request_id?}` | Enqueue only; returns `id`. The same `request_id` does not enqueue again |
| `GET /admin/result?id=…&wait=…` | Consume a result, waiting up to `wait` s (default 10; `wait=0` answers at once) |
| `GET /admin/devices` · `POST /admin/revoke {device}` | List / unpair browsers |
| `POST /admin/pair` · `GET /admin/ping` | Pairing code · health |
| `POST /admin/bootstrap` | Disabled. Returns 410 `bootstrap_disabled` |

Device HTTP routes (`/register`, `/poll`, `/result`, `/unregister`, and
`/ws-ticket`) use POST bodies. The extension in this source tree also sends
`x-juno-device-token` with the same token as the result body.
`POST /ws-ticket` takes `{token}` and returns
`{ticket, expires_in: 30}`. To upgrade `/ws`, offer the subprotocols
`juno-bridge-v1` and `juno-ticket.<ticket>`; the relay returns only the public
`juno-bridge-v1` protocol. The ticket is single-use, bound to the device and
the issuing extension origin when present, and validated before a socket
is accepted. After upgrading, send `{type: "hello", after, version}`; the
socket's authenticated identity is already fixed. Credentials never go in
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
- `jb.py` normally talks to a local operator process, which keeps a libcurl
  client with certificate verification on. `JUNO_OPERATOR=0` or
  `JUNO_BRIDGE_HTTP=curl` shells out to `curl` instead, because some
  Cloudflare-fronted hosts block Python `urllib`'s TLS fingerprint at the edge.

Automated checks (no Chrome, no deploy):

```bash
node --test
python3 -m unittest discover -s test -p 'test_*.py'
```

`npm test` runs both suites. Jev checks use fake keys, observations, and
responses: no billed calls, live browser actions, or deployments occur.
Real-browser verification is still required by [CONTRIBUTING.md](CONTRIBUTING.md)
before merging a browser or transport change. A live TypeSafe check is a
separate opt-in check using the tester's own account; record its cost and
exclude credentials and private page data from reports.

## License

MIT — see [LICENSE](LICENSE).
