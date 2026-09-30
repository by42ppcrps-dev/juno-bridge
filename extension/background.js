/* Juno Bridge — background service worker.
 *
 * Holds a live WebSocket to the relay, receives commands the instant they're
 * sent, executes them against tabs via chrome.debugger (CDP), and sends
 * results back once the relay has acknowledged receipt. If the socket can't
 * be opened it falls back to polling over HTTP and retries the socket every
 * minute.
 *
 * Safety model — these are the limits, not aspirations:
 *  - Pause: `enabled === false` drops the local queue, cancels an in-flight
 *    command at the next browser mutation, and detaches debugger sessions.
 *    The check is repeated after an awaited tab lookup, immediately before
 *    the browser call. An input event or navigation already handed to Chrome
 *    is not undone.
 *  - A command's 30s timeout marks that command dead before the failure is
 *    reported. A late browser response cannot continue it, and the next
 *    command is not held behind the abandoned handler.
 *  - A workflow is a finite list of at most 10 steps on one tab. The debugger
 *    stays attached until that workflow finishes or is interrupted, then it
 *    is released. It is not held between commands or while a model is
 *    choosing the next step. Pause, page, and permission checks still run
 *    before every step and every input event.
 *  - A snapshot ref is one node from that capture. This worker stores
 *    Chrome's backend node id for it, scoped to the document. The id a
 *    caller saves is 128 random bits, so a restarted worker cannot issue
 *    that same id for a different capture. The extension binding is
 *    required even when the page still holds the id. Attributes on the
 *    page are not that identity. If the id cannot be resolved, the
 *    command stops before it sends input.
 *  - Existing-tab commands require an explicit tabId. There is no fallback
 *    to whichever tab is active.
 *  - A command is authorized against one page. The tab's URL and the
 *    document location are checked again immediately before each mutation
 *    or read. Navigation off that page aborts the rest of the command.
 *  - Freshness is measured at execution, not at receipt: relay age at
 *    delivery plus time spent waiting on this machine. Over 2 minutes is
 *    refused. Pause does not resume the in-memory queue.
 *  - Delivery is at-most-once: the cursor is saved before a command runs.
 *  - Snapshot redaction covers recognized password, payment, and one-time-code
 *    fields only. Screenshots are unmasked. `text` is unfiltered page text.
 *  - `eval` is off by default and bypasses redaction.
 *  - Every action is appended to a local activity log.
 */

importScripts("config.js", "allowlist.js");

const WS_URL = JUNO_RELAY_URL.replace(/^http/, "ws") + "/ws";
const SOCKET_PROTOCOL = "juno-bridge-v1";
const SOCKET_TICKET_TIMEOUT_MS = 10000;
const SOCKET_WELCOME_TIMEOUT_MS = 10000;
const PING_MS = 20000; // < 30s: keeps the MV3 service worker alive and the socket warm
const SOCKET_SILENCE_MS = 50000; // nothing heard (not even a pong) → treat the socket as dead
const WS_MAX_MSG = 900 * 1024; // larger results go over HTTP
const HTTP_FALLBACK_MS = 60000; // after a socket fails to open, poll over HTTP this long before retrying
const POLL_MS = 2500;
const MAX_BACKOFF_MS = 60000;
const CMD_TIMEOUT_MS = 30000;
const CMD_MAX_AGE_MS = 120000; // relay age at delivery + local wait, checked at execution
const WORKFLOW_MAX_STEPS = 10;
const READY_BUDGET_MS = 15000;
const READY_POLL_MS = 50;
const REF_RE = /^e[1-9][0-9]{0,2}$/;
const SNAPSHOT_ID_RE = /^snap_[0-9a-f]{32}$/;
// A new worker starts this at zero. Ids must not be derived from it:
// every worker's first capture would otherwise be snap_00000001.
let snapshotSerial = 0;
// snapshot id → { tabId, doc, url, nodes: [{ ref, backendNodeId }] }.
// The page can copy attributes onto another element; the backend node id
// cannot. The map dies with this worker. A missing entry is a stale ref
// even when the isolated world still names that snapshot.
const snapshotBindings = new Map();
const SNAPSHOT_BINDING_MAX = 32;
const RESULT_ACK_MS_DEFAULT = 5000;
const NAV_WAIT_MS = 15000;
const CDP_VERSION = "1.3";
const LOG_CAP = 50;
const TEXT_CAP = 100000;
// Count the full POST envelope. This is slightly stricter than the relay's
// 8 MiB serialized record limit and leaves room for its receipt metadata.
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const RESULT_TIMEOUT_MS = 10000;
const RESULT_RETRY_MS = 1000;
const POLL_TIMEOUT_MS = 10000;

// Puppeteer-style key definitions. A `text` makes CDP emit a real keypress,
// which is what makes Enter submit a form; keys without text use rawKeyDown.
const KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
};
KEYS.Space = KEYS[" "];

// Recognized sensitive fields only. A field with none of these signals still
// contributes its value; snapshot redaction is a reduction, not a guarantee.
const SECRET_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;
const SECRET_HINT = /password|passphrase|passcode|one[-_ ]?time|onetime|\botp\b|\btotp\b|\bpin\b|\bmfa\b|\b2fa\b|verification[-_ ]?code|security[-_ ]?code|auth(?:entication|enticator)?[-_ ]?code|\bcvv\b|\bcvc\b|\bcsc\b|card[-_ ]?(?:number|code|verification)|credit[-_ ]?card|cc[-_ ]?number|\bssn\b|social[-_ ]?security|tax[-_ ]?id|routing[-_ ]?number|account[-_ ]?number/i;

let resultAckTimeoutMs = RESULT_ACK_MS_DEFAULT;
// Bumped on pause, resume, re-pair, and permission changes. A command captures
// the epoch when scheduled; a mismatch means it must not touch the browser.
let controlEpoch = 0;
let acceptingCommands = true;

function cancelled() {
  const error = new Error("cancelled: extension paused or settings changed");
  error.code = "cancelled";
  return error;
}

// `epoch` is the number captured when the command was scheduled, or a
// per-command control `{ epoch, dead }`. Timeout sets `dead` and it stays
// set. A number has no deadline of its own; pause still fails it when the
// global epoch moves.
function commandEpoch(epoch) {
  return epoch && typeof epoch === "object" ? epoch.epoch : epoch;
}

function commandLive(epoch) {
  if (!acceptingCommands || commandEpoch(epoch) !== controlEpoch) return false;
  if (epoch && typeof epoch === "object" && epoch.dead) return false;
  return true;
}

function assertActive(epoch) {
  if (!commandLive(epoch)) throw cancelled();
}

function cursorKey(token) {
  return `cursor:${token}`;
}

function savedCursor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// Migration must finish before any command can save progress. The scoped read
// belongs inside this gate: a delayed, missing-key snapshot must never write an
// old cursor after another reader has migrated it and taken a newer command.
const cursorInitializations = new Map();

async function initializeCursor(token) {
  let pending = cursorInitializations.get(token);
  if (!pending) {
    pending = (async () => {
      const key = cursorKey(token);
      const stored = await chrome.storage.local.get({ [key]: null, cursor: 0, legacyCursorToken: null });
      if (stored[key] !== null) return;
      // The unscoped cursor is only an upgrade source. Bind it to its original
      // device so a later device with no scoped cursor cannot borrow its seq.
      const ownsLegacy = !stored.legacyCursorToken || stored.legacyCursorToken === token;
      await chrome.storage.local.set({
        [key]: ownsLegacy ? savedCursor(stored.cursor) : 0,
        ...(ownsLegacy && !stored.legacyCursorToken ? { legacyCursorToken: token } : {}),
      });
    })();
    cursorInitializations.set(token, pending);
    const clear = () => {
      if (cursorInitializations.get(token) === pending) cursorInitializations.delete(token);
    };
    pending.then(clear, clear);
  }
  await pending;
}

async function getState() {
  const state = await chrome.storage.local.get({
    deviceToken: null,
    enabled: true,
    allowlist: [], // deny by default: you add sites explicitly in Options
    allowEval: false,
  });
  let cursor = 0;
  if (state.deviceToken) {
    await initializeCursor(state.deviceToken);
    const key = cursorKey(state.deviceToken);
    const stored = await chrome.storage.local.get({ [key]: 0 });
    cursor = savedCursor(stored[key]);
  }
  return { ...state, cursor, allowlist: Array.isArray(state.allowlist) ? state.allowlist.slice() : [] };
}

function permissionKey(state) {
  return JSON.stringify([state.deviceToken, state.allowlist, !!state.allowEval]);
}

// Read storage as well as the epoch: Chrome can deliver a storage notification
// after the promise for a browser operation has already resolved.
async function assertPermissions(state, control) {
  assertActive(control);
  const current = await getState();
  assertActive(control);
  if (!current.enabled || !current.deviceToken || permissionKey(current) !== permissionKey(state)) {
    throw cancelled();
  }
}

function errMsg(e) {
  return (e && e.message) || String(e);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- activity log ---------- */

// The side panel listens to storage.onChanged, so writing is enough to refresh it.
async function logActivity(entry) {
  const { log } = await chrome.storage.local.get({ log: [] });
  log.push({ t: Date.now(), ...entry });
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
  await chrome.storage.local.set({ log });
}

/* ---------- relay status (shown in the side panel) ---------- */

let lastRelayState = null;

// via: "live" (WebSocket push) or "polling" (HTTP fallback).
async function setRelayState(state, via = null) {
  const key = state + "/" + via;
  if (key === lastRelayState) return; // only write on change
  lastRelayState = key;
  await chrome.storage.local.set({ relayStatus: { state, via, at: Date.now() } });
}

/* ---------- debugger helpers ---------- */

function pageOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// Existing-tab operations always name a tab. Omitting tabId is an error,
// not a request for the active tab in the last-focused window.
async function resolveTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
  return await chrome.tabs.get(tabId);
}

// Authorize one page. Later mutations call assertStillAuthorized so a
// navigation after this check cannot inherit it.
async function authorizeTab(params, state, ctx, verb, epoch) {
  assertActive(epoch);
  if (!params || params.tabId === undefined || params.tabId === null) {
    throw new Error(`${verb}: tabId required`);
  }
  const tab = await resolveTab(params.tabId);
  await assertPermissions(state, epoch);
  const url = tab.url || "";
  ctx.target = url;
  if (!urlAllowed(url, state.allowlist)) throw new Error(`${verb}: site not in allowlist`);
  assertActive(epoch);
  const control = epoch && typeof epoch === "object" ? epoch : null;
  return {
    tabId: tab.id,
    url,
    origin: pageOrigin(url),
    verb,
    epoch: control ? control.epoch : epoch,
    control,
    state,
  };
}

async function assertStillAuthorized(auth) {
  const control = auth.control || auth.epoch;
  await assertPermissions(auth.state, control);
  const tab = await chrome.tabs.get(auth.tabId);
  await assertPermissions(auth.state, control);
  const url = tab.url || "";
  // Exact page, not merely "still on some allowlisted origin". The new URL
  // is deliberately absent from the error: it may itself be sensitive, and
  // it must not ride back through the relay in an error string.
  if (url !== auth.url || (tab.pendingUrl && tab.pendingUrl !== auth.url) ||
      pageOrigin(url) !== auth.origin || !urlAllowed(url, auth.state.allowlist)) {
    throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
  }
}

async function readDocumentUrl(auth) {
  const control = auth.control || auth.epoch;
  await assertPermissions(auth.state, control);
  assertActive(control);
  let res;
  try {
    res = await chrome.debugger.sendCommand({ tabId: auth.tabId }, "Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
  } catch (e) {
    if (!commandLive(control)) throw cancelled();
    throw e;
  }
  await assertPermissions(auth.state, control);
  const value = res && res.result ? res.result.value : "";
  if (typeof value !== "string" || !value) {
    throw new Error(`${auth.verb}: could not confirm the authorized page`);
  }
  return value;
}

async function readDocumentId(auth) {
  const control = auth.control || auth.epoch;
  await assertPermissions(auth.state, control);
  assertActive(control);
  // Chrome's frame/loader ids survive neither navigation nor a same-URL
  // reload. Page script cannot spoof them as it can performance.timeOrigin.
  const res = await chrome.debugger.sendCommand({ tabId: auth.tabId }, "Page.getFrameTree");
  await assertPermissions(auth.state, control);
  const frame = res && res.frameTree && res.frameTree.frame;
  const expectedUrl = new URL(auth.url);
  expectedUrl.hash = "";
  if (!frame || typeof frame.id !== "string" || typeof frame.loaderId !== "string" ||
      !frame.id || !frame.loaderId || frame.url !== expectedUrl.href) {
    throw new Error(`${auth.verb}: could not confirm the authorized document`);
  }
  return frame.id + "\0" + frame.loaderId;
}

async function cdp(auth, method, params = {}, opts = {}) {
  await assertStillAuthorized(auth);
  // tab.url can lag the document. Bind the mutation to the page we authorized.
  const href = await readDocumentUrl(auth);
  if (href !== auth.url) {
    throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
  }
  const documentId = await readDocumentId(auth);
  if (auth.documentId && documentId !== auth.documentId) {
    throw new Error(`${auth.verb}: the document changed`);
  }
  auth.documentId = documentId;
  assertActive(auth.control || auth.epoch);
  if (detachedTabs.has(auth.tabId)) throw detachedError(auth);
  // After the page checks, immediately before the browser call. A failure
  // from here on may mean the input already reached Chrome.
  if (opts.dispatch && auth.control) auth.control.dispatched = true;
  try {
    const result = await chrome.debugger.sendCommand({ tabId: auth.tabId }, method, params);
    await assertPermissions(auth.state, auth.control || auth.epoch);
    if (!opts.dispatch) {
      // A capture or evaluation can finish after navigation, including a
      // same-URL reload. Discard its output before any caller can publish it.
      await assertStillAuthorized(auth);
      if (await readDocumentId(auth) !== documentId) {
        throw new Error(`${auth.verb}: the document changed`);
      }
    }
    return result;
  } catch (e) {
    // Detach-on-pause rejects the in-flight call. The event may already have
    // reached Chrome; refusing the rest of the command is all pause can do.
    if (!commandLive(auth.control || auth.epoch)) throw cancelled();
    if (detachedTabs.has(auth.tabId)) throw detachedError(auth);
    throw e;
  }
}

function detachedError(auth) {
  const verb = auth && auth.verb ? auth.verb : "command";
  const err = new Error(`${verb}: debugger detached`);
  err.uncertain = true;
  return err;
}

// tabId → token of the command currently holding the debugger on it. Tokens
// stop a timed-out handler's late cleanup from detaching a newer session.
const debugSessions = new Map();
// Tabs whose debugging bar the user dismissed, or that Chrome detached.
const detachedTabs = new Set();

async function withDebugger(auth, fn) {
  const control = auth.control || auth.epoch;
  assertActive(control);
  await assertStillAuthorized(auth);
  if (debugSessions.has(auth.tabId)) throw new Error("tab is busy with another command");
  assertActive(control);
  // A detach recorded for a previous command must not poison this one.
  detachedTabs.delete(auth.tabId);
  await chrome.debugger.attach({ tabId: auth.tabId }, CDP_VERSION);
  // Attach was in flight across the await. Timeout, a newer command, or the
  // user dismissing the bar may have landed. Do not adopt the session, and
  // do not detach a session that a newer command already owns.
  if (!commandLive(control) || debugSessions.has(auth.tabId) || detachedTabs.has(auth.tabId)) {
    const userDetached = detachedTabs.has(auth.tabId);
    if (!debugSessions.has(auth.tabId)) await detachDebugger(auth.tabId);
    detachedTabs.delete(auth.tabId);
    if (!commandLive(control)) throw cancelled();
    if (userDetached) throw detachedError(auth);
    throw new Error("tab is busy with another command");
  }
  const token = Symbol(auth.tabId);
  debugSessions.set(auth.tabId, token);
  try {
    assertActive(control);
    const href = await readDocumentUrl(auth);
    if (href !== auth.url) {
      throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
    }
    return await fn();
  } finally {
    if (debugSessions.get(auth.tabId) === token) await detachDebugger(auth.tabId);
  }
}

async function detachDebugger(tabId) {
  debugSessions.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached */
  }
}

// Commands run one at a time, so anything still attached after a command
// settles belongs to a handler that timed out or was paused. Detaching also
// dismisses the debugging banner.
async function releaseAllDebuggers() {
  await Promise.all([...debugSessions.keys()].map(detachDebugger));
}

// The user dismissing the "is debugging this browser" bar, or the tab closing.
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId !== undefined) {
    debugSessions.delete(source.tabId);
    detachedTabs.add(source.tabId);
  }
});

async function evaluate(auth, expression, opts = {}) {
  const params = {
    expression,
    returnByValue: true,
    awaitPromise: true,
  };
  // location.href checks go through readDocumentUrl and stay in the main
  // world. contextId is set once this command has entered the isolated world.
  if (auth.contextId) params.contextId = auth.contextId;
  const res = await cdp(auth, "Runtime.evaluate", params, opts);
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const why = (d.exception && (d.exception.description || d.exception.value)) || d.text || "exception";
    throw new Error("page threw: " + String(why).slice(0, 300));
  }
  return res.result ? res.result.value : undefined;
}

function waitForLoad(tabId, ms) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (loaded) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(loaded);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(false);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(() => finish(false), ms);
  });
}

// Relay age at delivery, plus time this process has held the command since.
// Null means the timestamps can't be trusted, which is treated as stale.
function commandAgeMs(cmd, relayNow, receivedAt, now) {
  const relayAge = Number(relayNow) - Number(cmd && cmd.issued_at);
  const localWait = Number(now) - Number(receivedAt);
  if (!Number.isFinite(relayAge) || !Number.isFinite(localWait)) return null;
  if (relayAge < -5000 || localWait < -1000) return null;
  return Math.max(0, relayAge) + Math.max(0, localWait);
}

/* ---------- command implementations ---------- */

function newSnapshotId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return "snap_" + hex;
}

// Interactive elements with viewport-relative centre points (the coordinate
// space Input.dispatchMouseEvent uses). Values are copied only for fields
// that fail the secret check above.
// mode "store" replaces the node list for snapshotId. A later capture must
// not append: e1 would then name a different node than the new numbering.
// mode "read" describes those stored nodes and does not walk the live DOM.
// mode "ephemeral" walks the live DOM and stores nothing.
function snapshotSource(mode, snapshotId) {
  const store = mode === "store";
  const read = mode === "read";
  const idLiteral = JSON.stringify(store ? snapshotId : "");
  const prelude = store
    ? `const origin = (typeof performance !== "undefined" && performance && performance.timeOrigin) || 0;
  const key = location.href + "\\0" + origin;
  let hold = globalThis.__junoHold;
  if (!hold || hold.key !== key) {
    hold = { key: key, nodes: [], url: location.href, snapshot: ${idLiteral} };
    globalThis.__junoHold = hold;
  }
  hold.nodes = [];
  hold.snapshot = ${idLiteral};
  hold.url = location.href;
  const source = document.querySelectorAll(sel);`
    : read
      ? `const hold = globalThis.__junoHold;
  if (!hold || !Array.isArray(hold.nodes) || !hold.snapshot) return null;
  const source = hold.nodes;`
      : `const hold = null;
  const source = document.querySelectorAll(sel);`;
  return `(() => {
  const SECRET_AUTOCOMPLETE = ${SECRET_AUTOCOMPLETE};
  const SECRET_HINT = ${SECRET_HINT};
  const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="textbox"],[role="menuitem"],[role="tab"],[contenteditable="true"]';
  ${prelude}
  const reading = ${read ? "true" : "false"};
  const storing = ${store ? "true" : "false"};
  const vw = window.innerWidth, vh = window.innerHeight;
  const els = [];
  for (const el of source) {
    if (els.length >= 300) break;
    const ref = 'e' + (els.length + 1);
    if (reading && (!el || el.isConnected === false)) {
      els.push({ ref: ref, missing: true });
      continue;
    }
    const r = el.getBoundingClientRect();
    if (!reading && (r.width <= 0 || r.height <= 0)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/ +/).pop();
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    let labelText = '';
    if (el.labels) {
      for (const label of el.labels) labelText += ' ' + (label.innerText || '');
    }
    const blob = [el.getAttribute('name') || '', el.getAttribute('id') || '',
      el.getAttribute('placeholder') || '', el.getAttribute('aria-label') || '',
      el.getAttribute('class') || '', ac, labelText].join(' ');
    const secret = isField && (type === 'password' || type === 'hidden' ||
      SECRET_AUTOCOMPLETE.test(ac) || SECRET_HINT.test(blob));
    const value = isField && !secret ? String(el.value || '') : '';
    const text = ((isField ? '' : el.innerText) || value || el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    // ref is this snapshot's handle (e1, e2, ...). It is not a DOM id.
    // Another snapshot replaces the stored nodes and issues its own id.
    const item = { ref: ref, tag, text, x, y, w: Math.round(r.width), h: Math.round(r.height),
      inView: x >= 0 && y >= 0 && x < vw && y < vh && r.width > 0 && r.height > 0 };
    if (el.href) item.href = String(el.href).slice(0, 160);
    if (type) item.inputType = type;
    if (secret) item.redacted = true;
    if (el.disabled) item.disabled = true;
    els.push(item);
    if (storing && hold) hold.nodes.push(el);
  }
  const result = { title: document.title, url: location.href,
    viewport: { w: vw, h: vh }, scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    elements: els };
  if (hold && hold.snapshot) result.snapshot = hold.snapshot;
  if (hold && hold.key) result.doc = hold.key;
  return result;
})()`;
}

const SNAPSHOT_JS = snapshotSource("ephemeral");

// href + NUL + timeOrigin. A reload of the same URL changes timeOrigin and
// drops the nodes held for the previous document.
const DOC_JS = `(() => {
  const origin = (typeof performance !== "undefined" && performance && performance.timeOrigin) || 0;
  const key = location.href + "\\0" + origin;
  let hold = globalThis.__junoHold;
  if (!hold || hold.key !== key) {
    hold = { key: key, nodes: [], url: location.href, snapshot: null };
    globalThis.__junoHold = hold;
  }
  return { doc: hold.key, url: location.href, snapshot: hold.snapshot || null };
})()`;

const HOLD_JS = `(() => {
  const hold = globalThis.__junoHold;
  if (!hold) return null;
  return {
    snapshot: hold.snapshot || null,
    doc: hold.key || null,
    url: hold.url || location.href,
    count: Array.isArray(hold.nodes) ? hold.nodes.length : 0,
  };
})()`;

function pageTextExpression() {
  // Visible text only, with no sensitive-content filter. Input values are not
  // part of innerText; secrets rendered as text still are.
  return `(() => { const t = document.body ? document.body.innerText : '';
        return { title: document.title, url: location.href, length: t.length,
          text: t.slice(0, ${TEXT_CAP}), truncated: t.length > ${TEXT_CAP} }; })()`;
}

function refuseDrifted(verb, auth, pageUrl) {
  if (typeof pageUrl === "string" && pageUrl !== auth.url) {
    throw new Error(`${verb}: tab navigated away from the authorized page`);
  }
}

async function cmdPing(_params, _state, _ctx, epoch) {
  assertActive(epoch);
  return { version: chrome.runtime.getManifest().version, relay: JUNO_RELAY_URL };
}

// Only allowlisted tabs are visible to Juno; the rest are just counted.
async function cmdTabs(_params, state, ctx, epoch) {
  assertActive(epoch);
  const all = await chrome.tabs.query({});
  await assertPermissions(state, epoch);
  const visible = all.filter((t) => urlAllowed(t.url, state.allowlist));
  ctx.target = `${visible.length} of ${all.length} tabs visible`;
  return {
    tabs: visible.map((t) => ({
      id: t.id,
      windowId: t.windowId,
      active: t.active,
      title: (t.title || "").slice(0, 120),
      url: t.url || "",
    })),
    hidden: all.length - visible.length,
  };
}

// Opens a background tab (never steals focus), or reuses `tabId` when that
// tab's current page is allowlisted. Reuse re-reads the tab immediately
// before the navigation so a race can't send an allowlisted URL into a tab
// that has since left the allowlist.
async function cmdNavigate(params, state, ctx, epoch) {
  await assertPermissions(state, epoch);
  const url = params.url;
  if (!url || typeof url !== "string") throw new Error("navigate: missing url");
  ctx.target = url;
  if (!urlAllowed(url, state.allowlist)) throw new Error("navigate: site not in allowlist");
  let tab;
  if (params.tabId !== undefined && params.tabId !== null) {
    const current = await resolveTab(params.tabId);
    await assertPermissions(state, epoch);
    if (!urlAllowed(current.url, state.allowlist)) {
      throw new Error("navigate: that tab's current page is not in allowlist");
    }
    assertActive(epoch);
    const again = await chrome.tabs.get(current.id);
    await assertPermissions(state, epoch);
    const againUrl = again.url || "";
    if (againUrl !== (current.url || "") || (again.pendingUrl && again.pendingUrl !== againUrl) ||
        !urlAllowed(againUrl, state.allowlist)) {
      throw new Error("navigate: that tab changed or is no longer allowlisted");
    }
    // The second lookup was awaited. Pause or this command's timeout may
    // have landed during it. Recheck before the navigation is issued.
    await assertPermissions(state, epoch);
    assertActive(epoch);
    tab = await chrome.tabs.update(again.id, { url });
  } else {
    await assertPermissions(state, epoch);
    assertActive(epoch);
    tab = await chrome.tabs.create({ url, active: false });
  }
  await assertPermissions(state, epoch);
  // The navigation has been handed to Chrome. Pause cannot pull it back;
  // waiting for load is observation, not another mutation.
  const loaded = await waitForLoad(tab.id, NAV_WAIT_MS);
  const final = await chrome.tabs.get(tab.id);
  await assertPermissions(state, epoch);
  const finalUrl = final.url || final.pendingUrl;
  const stillAllowed = urlAllowed(finalUrl, state.allowlist);
  return {
    tabId: tab.id,
    loaded,
    // Don't reveal where an off-allowlist redirect went.
    url: stillAllowed ? finalUrl || url : null,
    redirectedOffAllowlist: !stillAllowed,
  };
}

async function cmdScreenshot(params, state, ctx, epoch) {
  const auth = await authorizeTab(params, state, ctx, "screenshot", epoch);
  const data = await withDebugger(auth, async () => {
    const res = await cdp(auth, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return res.data;
  });
  return { tabId: auth.tabId, image: "data:image/jpeg;base64," + data, redaction: "none" };
}

function rememberSnapshot(snapshotId, binding) {
  const stale = [];
  for (const [id, prev] of snapshotBindings) {
    if (id !== snapshotId && prev.tabId === binding.tabId && prev.doc === binding.doc) stale.push(id);
  }
  for (const id of stale) snapshotBindings.delete(id);
  snapshotBindings.delete(snapshotId);
  snapshotBindings.set(snapshotId, binding);
  while (snapshotBindings.size > SNAPSHOT_BINDING_MAX) {
    const oldest = snapshotBindings.keys().next().value;
    if (oldest === snapshotId) break;
    snapshotBindings.delete(oldest);
  }
}

function forgetSnapshots() {
  snapshotBindings.clear();
}

// Test hook. A restarted worker loses the map and starts its counter over.
// Production ids do not read that counter; the reset is what makes a
// counter-based id collide with the previous worker's first capture.
function simulateWorkerRestart() {
  snapshotBindings.clear();
  snapshotSerial = 0;
  return snapshotSerial;
}

// Record backend node ids for the elements the store expression just held.
// A later command resolves those ids. It does not search the DOM for a copy.
async function retainSnapshot(auth, snapshotId, described) {
  const elements = described.elements;
  if (!Array.isArray(elements)) throw new Error("snapshot: snapshot failed");
  if (typeof described.doc !== "string" || described.url !== auth.url) {
    throw new Error("snapshot: could not retain the captured nodes");
  }
  const remote = await cdp(auth, "Runtime.evaluate", {
    expression: `(() => {
      const hold = globalThis.__junoHold;
      if (!hold || hold.snapshot !== ${JSON.stringify(snapshotId)} || !Array.isArray(hold.nodes)) return null;
      return hold.nodes;
    })()`,
    returnByValue: false,
    awaitPromise: true,
    contextId: auth.contextId,
  });
  if (remote && remote.exceptionDetails) throw new Error("snapshot: could not retain the captured nodes");
  const nodes = [];
  if (elements.length > 0) {
    const listId = remote && remote.result && remote.result.objectId;
    if (!listId) throw new Error("snapshot: could not retain the captured nodes");
    const props = await cdp(auth, "Runtime.getProperties", { objectId: listId, ownProperties: true });
    const byIndex = new Map();
    for (const prop of (props && props.result) || []) {
      if (!prop || !/^\d+$/.test(prop.name)) continue;
      const id = prop.value && prop.value.objectId;
      if (!id) continue;
      byIndex.set(Number(prop.name), id);
    }
    if (byIndex.size !== elements.length) throw new Error("snapshot: could not retain the captured nodes");
    for (let i = 0; i < elements.length; i++) {
      const describedNode = await cdp(auth, "DOM.describeNode", { objectId: byIndex.get(i) });
      const backendNodeId = describedNode && describedNode.node && describedNode.node.backendNodeId;
      if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
        throw new Error("snapshot: could not retain the captured nodes");
      }
      nodes.push({ ref: "e" + (i + 1), backendNodeId });
    }
  }
  rememberSnapshot(snapshotId, {
    tabId: auth.tabId,
    doc: described.doc,
    url: described.url,
    nodes,
  });
}

async function cmdSnapshot(params, state, ctx, epoch) {
  const auth = await authorizeTab(params, state, ctx, "snapshot", epoch);
  const snapshotId = newSnapshotId();
  const snap = await withDebugger(auth, async () => {
    await ensureWorld(auth);
    const described = await evaluate(auth, snapshotSource("store", snapshotId));
    refuseDrifted("snapshot", auth, described && described.url);
    if (!described || typeof described !== "object") throw new Error("snapshot: snapshot failed");
    await retainSnapshot(auth, snapshotId, described);
    return described;
  });
  return { tabId: auth.tabId, ...snap, snapshot: snapshotId, redaction: "heuristic" };
}

async function cmdText(params, state, ctx, epoch) {
  const auth = await authorizeTab(params, state, ctx, "text", epoch);
  const page = await withDebugger(auth, () => evaluate(auth, pageTextExpression()));
  refuseDrifted("text", auth, page && page.url);
  return { tabId: auth.tabId, ...page, redaction: "none" };
}

function readySnapshotId(ready, inheritedSnapshot) {
  if (ready && typeof ready.snapshot === "string") return ready.snapshot;
  return inheritedSnapshot;
}

function readyExpression(ready, inheritedSnapshot) {
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) throw new Error("ready: invalid");
  if (ready.type === "text") {
    if (typeof ready.text !== "string" || ready.text.length < 1 || ready.text.length > 200) {
      throw new Error("ready: text must be 1 to 200 characters");
    }
    const needle = JSON.stringify(ready.text);
    return `(() => { const t = document.body ? document.body.innerText : ""; return t.includes(${needle}); })()`;
  }
  if (ready.type === "element_visible" || ready.type === "element_enabled") {
    if (typeof ready.ref !== "string" || !REF_RE.test(ready.ref)) throw new Error("ready: ref required");
    const snapshotId = readySnapshotId(ready, inheritedSnapshot);
    if (typeof snapshotId !== "string" || !SNAPSHOT_ID_RE.test(snapshotId)) {
      throw new Error("ready: snapshot required");
    }
    if (ready.snapshot !== undefined && ready.snapshot !== snapshotId) {
      throw new Error("ready: snapshot does not match");
    }
    const refJson = JSON.stringify(ready.ref);
    const snapJson = JSON.stringify(snapshotId);
    const enabled = ready.type === "element_enabled" ? "if (el.disabled) return false;" : "";
    return `(() => {
      const hold = globalThis.__junoHold;
      if (!hold || hold.snapshot !== ${snapJson} || !Array.isArray(hold.nodes)) return false;
      const m = ${refJson}.match(/^e(\\d+)$/);
      if (!m) return false;
      const el = hold.nodes[Number(m[1]) - 1];
      if (!el || el.isConnected === false) return false;
      const r = el.getBoundingClientRect();
      const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      if (!inView) return false;
      ${enabled}
      return true;
    })()`;
  }
  throw new Error("ready: unsupported condition");
}

function validateReady(ready, inheritedSnapshot) {
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) throw new Error("ready: invalid");
  if (ready.timeoutMs !== undefined) {
    const timeoutMs = Number(ready.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > READY_BUDGET_MS) {
      throw new Error("ready: timeoutMs must be between 0 and 15000");
    }
  }
  readyExpression(ready, inheritedSnapshot);
}

function validateAfter(after, inheritedSnapshot) {
  if (after === undefined || after === null) return;
  if (!after || typeof after !== "object" || Array.isArray(after)) throw new Error("after: invalid");
  if (after.observe !== "snapshot" && after.observe !== "text") {
    throw new Error("after: observe must be snapshot or text");
  }
  if (after.ready !== undefined) validateReady(after.ready, inheritedSnapshot);
}

function elementReadySnapshot(after) {
  const ready = after && after.ready;
  if (!ready || (ready.type !== "element_visible" && ready.type !== "element_enabled")) return null;
  return ready.snapshot || null;
}

function installHoldSource(snapshotId, docKey, url) {
  const snapJson = JSON.stringify(snapshotId);
  const docJson = JSON.stringify(docKey);
  const urlJson = JSON.stringify(url);
  // Arguments are the nodes DOM.resolveNode returned, in ref order. A missing
  // argument stays empty. Nothing here looks at attributes or the live order.
  return `function() {
    const nodes = [];
    let identified = 0;
    for (let i = 0; i < arguments.length; i++) {
      const el = arguments[i];
      if (!el) {
        nodes.push(null);
        continue;
      }
      identified += 1;
      nodes.push(el);
    }
    if (!identified) return { ok: false, count: 0 };
    globalThis.__junoHold = {
      key: ${docJson},
      nodes: nodes,
      url: ${urlJson},
      snapshot: ${snapJson},
    };
    return { ok: true, count: identified };
  }`;
}

async function callInPage(auth, functionDeclaration, args) {
  const res = await cdp(auth, "Runtime.callFunctionOn", {
    functionDeclaration,
    arguments: args,
    executionContextId: auth.contextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res && res.exceptionDetails) {
    const detail = res.exceptionDetails;
    const why = (detail.exception && (detail.exception.description || detail.exception.value)) || detail.text || "exception";
    throw new Error("page threw: " + String(why).slice(0, 300));
  }
  return res && res.result ? res.result.value : undefined;
}

async function restoreSnapshot(auth, snapshotId, binding) {
  const args = [];
  for (const entry of binding.nodes) {
    let objectId = null;
    try {
      const resolved = await cdp(auth, "DOM.resolveNode", {
        backendNodeId: entry.backendNodeId,
        executionContextId: auth.contextId,
      });
      if (resolved && !resolved.exceptionDetails && resolved.object) {
        objectId = resolved.object.objectId || null;
      }
    } catch {
      objectId = null;
    }
    args.push(objectId ? { objectId } : { value: null });
  }
  return callInPage(auth, installHoldSource(snapshotId, binding.doc, binding.url), args);
}

async function bindSnapshot(auth, snapshotId) {
  await ensureWorld(auth);
  const doc = await evaluate(auth, DOC_JS);
  if (!doc || doc.url !== auth.url || typeof doc.doc !== "string") {
    throw new Error(`${auth.verb}: could not confirm the authorized page`);
  }
  const binding = snapshotBindings.get(snapshotId);
  // A newer capture deletes the old id. A reload changes the document key.
  // A restarted worker drops the map. The page holder is not a substitute:
  // this check runs even when that holder still names the id.
  if (!binding || binding.tabId !== auth.tabId || binding.doc !== doc.doc || binding.url !== auth.url) {
    throw new Error(`${auth.verb}: snapshot is stale`);
  }
  let held = await evaluate(auth, HOLD_JS);
  const holdMatches = held && held.snapshot === snapshotId && held.doc === doc.doc && held.url === auth.url;
  if (!holdMatches) {
    const restored = await restoreSnapshot(auth, snapshotId, binding);
    if (!restored || restored.ok !== true) throw new Error(`${auth.verb}: snapshot is stale`);
    held = await evaluate(auth, HOLD_JS);
    if (!held || held.snapshot !== snapshotId || held.doc !== doc.doc || held.url !== auth.url) {
      throw new Error(`${auth.verb}: snapshot is stale`);
    }
  }
  auth.doc = doc.doc;
  auth.snapshot = snapshotId;
}

// Element readiness names a ref. Confirm that node is still the captured one
// before any input. Visibility after the action stays in waitReady.
async function requireReadyTarget(auth, after) {
  const snapshotId = elementReadySnapshot(after);
  if (!snapshotId) return;
  await bindSnapshot(auth, snapshotId);
  const ref = after.ready.ref;
  const found = await evaluate(auth, resolveRefExpression(ref, snapshotId));
  if (found && found.stale) throw new Error(`${auth.verb}: snapshot is stale`);
  if (!found || found.ok !== true) throw new Error(`${auth.verb}: element ${ref} is gone`);
}

async function waitReady(auth, ready, inheritedSnapshot) {
  const expression = readyExpression(ready, inheritedSnapshot || auth.snapshot);
  let timeoutMs = READY_BUDGET_MS;
  if (ready.timeoutMs !== undefined) timeoutMs = Number(ready.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    assertActive(auth.control || auth.epoch);
    const href = await readDocumentUrl(auth);
    if (href !== auth.url) {
      throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
    }
    if ((await evaluate(auth, expression)) === true) return;
    if (Date.now() >= deadline) {
      const err = new Error(`${auth.verb}: observation was not ready`);
      err.report = {
        status: "unobserved",
        dispatched: !!(auth.control && auth.control.dispatched),
        observed: false,
      };
      throw err;
    }
    const slice = Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now()));
    if (slice > 0) await sleep(slice);
  }
}

// A new id and a new binding. Copying the id the action started with would
// make the new elements answer to the previous capture.
async function retainObservedSnapshot(auth) {
  await ensureWorld(auth);
  const snapshotId = newSnapshotId();
  const described = await evaluate(auth, snapshotSource("store", snapshotId));
  refuseDrifted(auth.verb, auth, described && described.url);
  if (!described || typeof described !== "object") throw new Error(`${auth.verb}: snapshot failed`);
  await retainSnapshot(auth, snapshotId, described);
  return {
    observe: "snapshot",
    observed: true,
    ...described,
    snapshot: snapshotId,
    redaction: "heuristic",
  };
}

function observationNeedsCapture(observation) {
  if (!observation || observation.observe !== "snapshot") return false;
  return typeof observation.snapshot !== "string" || !SNAPSHOT_ID_RE.test(observation.snapshot);
}

async function collectAfter(auth, after, retainSnapshotNow) {
  validateAfter(after, auth.snapshot);
  if (after.ready) await waitReady(auth, after.ready, auth.snapshot);
  const href = await readDocumentUrl(auth);
  if (href !== auth.url) {
    throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
  }
  if (after.observe === "snapshot") {
    // Retaining replaces every other id for this document. A later step that
    // still names the snapshot this workflow started with must run first.
    if (retainSnapshotNow) return retainObservedSnapshot(auth);
    const snap = await evaluate(auth, snapshotSource("ephemeral"));
    refuseDrifted(auth.verb, auth, snap && snap.url);
    if (!snap || typeof snap !== "object") throw new Error(`${auth.verb}: snapshot failed`);
    return { observe: "snapshot", observed: true, ...snap, redaction: "heuristic" };
  }
  const page = await evaluate(auth, pageTextExpression());
  refuseDrifted(auth.verb, auth, page && page.url);
  if (!page || typeof page !== "object") throw new Error(`${auth.verb}: text failed`);
  return { observe: "text", observed: true, ...page, redaction: "none" };
}

async function clickAt(auth, x, y) {
  await cdp(auth, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, { dispatch: true });
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp(auth, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, { dispatch: true });
  await cdp(auth, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, { dispatch: true });
}

async function ensureWorld(auth) {
  if (auth.contextId) return auth.contextId;
  const tree = await cdp(auth, "Page.getFrameTree");
  const frame = tree && tree.frameTree && tree.frameTree.frame;
  const frameId = frame && frame.id;
  if (typeof frameId !== "string" && typeof frameId !== "number") {
    throw new Error(`${auth.verb}: could not find the page frame`);
  }
  const world = await cdp(auth, "Page.createIsolatedWorld", {
    frameId,
    worldName: "juno-bridge",
    grantUniveralAccess: true,
  });
  const contextId = world && world.executionContextId;
  if (!Number.isInteger(contextId)) throw new Error(`${auth.verb}: could not enter the page`);
  auth.contextId = contextId;
  return contextId;
}

function resolveRefExpression(ref, snapshotId) {
  const refJson = JSON.stringify(ref);
  const snapJson = JSON.stringify(snapshotId);
  return `(() => {
    const hold = globalThis.__junoHold;
    if (!hold || hold.snapshot !== ${snapJson} || !Array.isArray(hold.nodes)) return { ok: false, stale: true };
    const m = ${refJson}.match(/^e(\\d+)$/);
    if (!m) return { ok: false };
    const el = hold.nodes[Number(m[1]) - 1];
    if (!el || el.isConnected === false) return { ok: false };
    const r = el.getBoundingClientRect();
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.getAttribute ? (el.getAttribute("type") || "") : "").toLowerCase();
    const isField = tag === "input" || tag === "textarea" || tag === "select";
    const value = isField ? String(el.value || "") : "";
    const text = ((isField ? "" : el.innerText) || value || (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title"))) || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const vw = window.innerWidth, vh = window.innerHeight;
    return { ok: true, tag, text, x, y, disabled: !!el.disabled, inView: x >= 0 && y >= 0 && x < vw && y < vh && r.width > 0 && r.height > 0 };
  })()`;
}

async function cmdClick(params, state, ctx, epoch) {
  validateAfter(params && params.after);
  const auth = await authorizeTab(params, state, ctx, "click", epoch);
  const { x, y } = params;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click: missing x/y");
  ctx.target += ` @${x},${y}`;
  // Recheck before each event. Pause or navigation after mouseMoved must not
  // deliver the press and release. An event already sent cannot be undone.
  return await withDebugger(auth, async () => {
    await requireReadyTarget(auth, params && params.after);
    await clickAt(auth, x, y);
    if (!params || !params.after) return { tabId: auth.tabId, x, y };
    const observation = await collectAfter(auth, params.after, true);
    return { tabId: auth.tabId, x, y, dispatched: true, observed: true, observation };
  });
}

async function cmdType(params, state, ctx, epoch) {
  validateAfter(params && params.after);
  const auth = await authorizeTab(params, state, ctx, "type", epoch);
  const { text } = params;
  if (typeof text !== "string" || !text) throw new Error("type: missing text");
  return await withDebugger(auth, async () => {
    await requireReadyTarget(auth, params && params.after);
    await cdp(auth, "Input.insertText", { text }, { dispatch: true });
    if (!params || !params.after) return { tabId: auth.tabId, chars: text.length };
    const observation = await collectAfter(auth, params.after, true);
    return { tabId: auth.tabId, chars: text.length, dispatched: true, observed: true, observation };
  });
}

async function cmdKey(params, state, ctx, epoch) {
  validateAfter(params && params.after);
  const auth = await authorizeTab(params, state, ctx, "key", epoch);
  const { key } = params;
  const def = typeof key === "string" && Object.hasOwn(KEYS, key) ? KEYS[key] : null;
  if (!def) throw new Error("key: unsupported key " + String(key).slice(0, 40));
  ctx.target += ` [${def.code}]`;
  const base = {
    key: def.key, code: def.code,
    windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
  };
  return await withDebugger(auth, async () => {
    await requireReadyTarget(auth, params && params.after);
    await cdp(auth, "Input.dispatchKeyEvent", def.text
      ? { ...base, type: "keyDown", text: def.text, unmodifiedText: def.text }
      : { ...base, type: "rawKeyDown" }, { dispatch: true });
    await cdp(auth, "Input.dispatchKeyEvent", { ...base, type: "keyUp" }, { dispatch: true });
    if (!params || !params.after) return { tabId: auth.tabId, key: def.key };
    const observation = await collectAfter(auth, params.after, true);
    return { tabId: auth.tabId, key: def.key, dispatched: true, observed: true, observation };
  });
}

// Scroll the page by (dx, dy) CSS px. With x/y, sends a wheel event at that
// point instead, which also scrolls inner scrollable panes.
async function cmdScroll(params, state, ctx, epoch) {
  validateAfter(params && params.after);
  const auth = await authorizeTab(params, state, ctx, "scroll", epoch);
  const dx = params.dx === undefined ? 0 : params.dx;
  const dy = params.dy === undefined ? 0 : params.dy;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) {
    throw new Error("scroll: need a nonzero numeric dx or dy");
  }
  const atPoint = Number.isFinite(params.x) && Number.isFinite(params.y);
  return await withDebugger(auth, async () => {
    await requireReadyTarget(auth, params && params.after);
    if (atPoint) {
      await cdp(auth, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: params.x, y: params.y, deltaX: dx, deltaY: dy,
      }, { dispatch: true });
      await sleep(150); // let the scroll land before reading the position
    } else {
      await evaluate(auth, `window.scrollBy(${dx}, ${dy})`, { dispatch: true });
    }
    const pos = await evaluate(auth, `({ x: Math.round(scrollX), y: Math.round(scrollY) })`);
    if (!params || !params.after) return { tabId: auth.tabId, scroll: pos };
    const observation = await collectAfter(auth, params.after, true);
    return { tabId: auth.tabId, scroll: pos, dispatched: true, observed: true, observation };
  });
}

const STEP_OPS = new Set(["click", "type", "key", "scroll", "snapshot", "text", "wait"]);

function stepNeedsSnapshot(step) {
  if (!step || typeof step !== "object") return false;
  if (step.op === "click") return true;
  const ready = step.op === "wait" ? step.ready : step.after && step.after.ready;
  return !!ready && (ready.type === "element_visible" || ready.type === "element_enabled");
}

function validateStep(step, inheritedSnapshot) {
  if (!step || typeof step !== "object" || Array.isArray(step) || !STEP_OPS.has(step.op)) {
    throw new Error("workflow: step op must be click, type, key, scroll, snapshot, text, or wait");
  }
  if (step.op === "click") {
    if (typeof step.ref !== "string" || !REF_RE.test(step.ref)) throw new Error("workflow: click needs a ref");
    if (step.expect !== undefined) {
      if (!step.expect || typeof step.expect !== "object" || Array.isArray(step.expect)) {
        throw new Error("workflow: click expect must be an object");
      }
      if (step.expect.tag !== undefined && typeof step.expect.tag !== "string") {
        throw new Error("workflow: expect.tag must be a string");
      }
      if (step.expect.text !== undefined && typeof step.expect.text !== "string") {
        throw new Error("workflow: expect.text must be a string");
      }
    }
  }
  if (step.op === "type" && (typeof step.text !== "string" || !step.text)) throw new Error("workflow: type needs text");
  if (step.op === "key") {
    if (typeof step.key !== "string" || !Object.hasOwn(KEYS, step.key)) throw new Error("workflow: unsupported key");
  }
  if (step.op === "scroll") {
    const dx = step.dx === undefined ? 0 : step.dx;
    const dy = step.dy === undefined ? 0 : step.dy;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) {
      throw new Error("workflow: scroll needs a nonzero dx or dy");
    }
  }
  if (step.op === "wait") validateReady(step.ready, inheritedSnapshot);
  if (step.after !== undefined) validateAfter(step.after, inheritedSnapshot);
}

function validateWorkflow(params) {
  const steps = params && params.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > WORKFLOW_MAX_STEPS) {
    throw new Error(`workflow: need 1 to ${WORKFLOW_MAX_STEPS} steps`);
  }
  if (!params || !Number.isInteger(params.tabId)) throw new Error("workflow: tabId required");
  const needsSnapshot = steps.some(stepNeedsSnapshot);
  if (needsSnapshot && (typeof params.snapshot !== "string" || !SNAPSHOT_ID_RE.test(params.snapshot))) {
    throw new Error("workflow: snapshot required");
  }
  if (!needsSnapshot && params.snapshot !== undefined && (typeof params.snapshot !== "string" || !SNAPSHOT_ID_RE.test(params.snapshot))) {
    throw new Error("workflow: snapshot required");
  }
  for (const step of steps) validateStep(step, params.snapshot);
}

function workflowReport(bag, status, control) {
  return {
    status,
    dispatched: !!(control && control.dispatched),
    observed: status === "unobserved" ? false : !!bag.observed,
    steps: bag.steps,
    observation: bag.observation,
    before: bag.before,
  };
}

function workflowError(message, report) {
  const err = new Error(message);
  err.report = report;
  return err;
}

function markUnstarted(steps, from) {
  for (let j = from; j < steps.length; j++) steps[j].status = "unstarted";
}

async function assertSameDocument(auth) {
  await assertStillAuthorized(auth);
  const href = await readDocumentUrl(auth);
  if (href !== auth.url) {
    throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
  }
  if (!auth.contextId) return;
  const doc = await evaluate(auth, DOC_JS);
  if (!doc || typeof doc.doc !== "string" || doc.url !== auth.url || doc.doc !== auth.doc) {
    const err = new Error(`${auth.verb}: the document changed`);
    if (auth.control && auth.control.dispatched) err.uncertain = true;
    throw err;
  }
}

async function runStep(auth, step, ctx, retainSnapshotNow) {
  if (step.op === "click") {
    const found = await evaluate(auth, resolveRefExpression(step.ref, auth.snapshot));
    if (found && found.stale) throw new Error("workflow: snapshot is stale");
    if (!found || found.ok !== true || !Number.isFinite(found.x) || !Number.isFinite(found.y)) {
      throw new Error("workflow: element " + step.ref + " is gone");
    }
    if (step.expect && step.expect.tag !== undefined && step.expect.tag !== found.tag) {
      throw new Error("workflow: element " + step.ref + " did not match");
    }
    if (step.expect && Object.prototype.hasOwnProperty.call(step.expect, "text") && step.expect.text !== found.text) {
      throw new Error("workflow: element " + step.ref + " did not match");
    }
    if (found.disabled) throw new Error("workflow: element " + step.ref + " is disabled");
    if (found.inView !== true) throw new Error("workflow: element " + step.ref + " is outside the viewport");
    ctx.target += ` @${found.x},${found.y}`;
    await clickAt(auth, found.x, found.y);
    const observation = step.after ? await collectAfter(auth, step.after, retainSnapshotNow) : null;
    return { result: { ref: step.ref, x: found.x, y: found.y }, observation };
  }
  if (step.op === "type") {
    await cdp(auth, "Input.insertText", { text: step.text }, { dispatch: true });
    const observation = step.after ? await collectAfter(auth, step.after, retainSnapshotNow) : null;
    return { result: { chars: step.text.length }, observation };
  }
  if (step.op === "key") {
    const def = KEYS[step.key];
    const base = {
      key: def.key, code: def.code,
      windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
    };
    await cdp(auth, "Input.dispatchKeyEvent", def.text
      ? { ...base, type: "keyDown", text: def.text, unmodifiedText: def.text }
      : { ...base, type: "rawKeyDown" }, { dispatch: true });
    await cdp(auth, "Input.dispatchKeyEvent", { ...base, type: "keyUp" }, { dispatch: true });
    const observation = step.after ? await collectAfter(auth, step.after, retainSnapshotNow) : null;
    return { result: { key: def.key }, observation };
  }
  if (step.op === "scroll") {
    const dx = step.dx === undefined ? 0 : step.dx;
    const dy = step.dy === undefined ? 0 : step.dy;
    if (Number.isFinite(step.x) && Number.isFinite(step.y)) {
      await cdp(auth, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: step.x, y: step.y, deltaX: dx, deltaY: dy,
      }, { dispatch: true });
      await sleep(150);
    } else {
      await evaluate(auth, `window.scrollBy(${dx}, ${dy})`, { dispatch: true });
    }
    const pos = await evaluate(auth, `({ x: Math.round(scrollX), y: Math.round(scrollY) })`);
    const observation = step.after ? await collectAfter(auth, step.after, retainSnapshotNow) : null;
    return { result: { scroll: pos }, observation };
  }
  if (step.op === "snapshot") {
    const snap = await evaluate(auth, snapshotSource("ephemeral"));
    refuseDrifted(auth.verb, auth, snap && snap.url);
    const observation = { observe: "snapshot", observed: true, ...snap, redaction: "heuristic" };
    return { result: { observe: "snapshot" }, observation };
  }
  if (step.op === "text") {
    const page = await evaluate(auth, pageTextExpression());
    refuseDrifted(auth.verb, auth, page && page.url);
    const observation = { observe: "text", observed: true, ...page, redaction: "none" };
    return { result: { observe: "text" }, observation };
  }
  await waitReady(auth, step.ready, auth.snapshot);
  return { result: { waited: true }, observation: null };
}

// One debugger attachment for the whole list. No model call runs inside it.
async function cmdWorkflow(params, state, ctx, epoch) {
  validateWorkflow(params);
  const auth = await authorizeTab(params, state, ctx, "workflow", epoch);
  if (!auth.control) auth.control = { epoch: auth.epoch, dead: false };
  const control = auth.control;
  const steps = params.steps;
  const bag = {
    before: null,
    observation: null,
    observed: false,
    steps: steps.map((step, index) => ({ index, op: step.op, status: "unstarted" })),
  };
  if (control) control.report = bag;
  try {
    return await withDebugger(auth, async () => {
      if (steps.some(stepNeedsSnapshot)) {
        await bindSnapshot(auth, params.snapshot);
        const snap = await evaluate(auth, snapshotSource("read"));
        refuseDrifted("workflow", auth, snap && snap.url);
        if (!snap || typeof snap !== "object" || snap.snapshot !== params.snapshot) {
          throw new Error("workflow: snapshot is stale");
        }
        bag.before = { ...snap, redaction: "heuristic" };
      } else {
        await ensureWorld(auth);
        const doc = await evaluate(auth, DOC_JS);
        if (!doc || doc.url !== auth.url || typeof doc.doc !== "string") {
          throw new Error("workflow: could not confirm the authorized page");
        }
        auth.doc = doc.doc;
        const snap = await evaluate(auth, snapshotSource("ephemeral"));
        refuseDrifted("workflow", auth, snap && snap.url);
        if (!snap || typeof snap !== "object") throw new Error("workflow: snapshot failed");
        bag.before = { ...snap, redaction: "heuristic" };
      }
      for (let i = 0; i < steps.length; i++) {
        try {
          assertActive(control);
          await assertSameDocument(auth);
        } catch (e) {
          const status = (e && e.uncertain) || (control && control.dispatched)
            ? "uncertain"
            : !commandLive(control) ? "cancelled" : "failed";
          markUnstarted(bag.steps, i);
          throw workflowError(errMsg(e), workflowReport(bag, status, control));
        }
        bag.steps[i].status = "running";
        const dispatchedBefore = !!(control && control.dispatched);
        const laterNeedsSnapshot = steps.slice(i + 1).some(stepNeedsSnapshot);
        try {
          const out = await runStep(auth, steps[i], ctx, !laterNeedsSnapshot);
          bag.steps[i].status = "completed";
          if (out && out.result) bag.steps[i].result = out.result;
          if (out && out.observation) {
            bag.observation = out.observation;
            bag.observed = true;
          }
        } catch (e) {
          const dispatchedNow = !!(control && control.dispatched);
          const live = commandLive(control);
          let status;
          if (e && e.report && e.report.status === "unobserved") status = "unobserved";
          else if ((e && e.uncertain) || (!live && dispatchedNow)) status = "uncertain";
          else if (!live) status = "interrupted";
          else if (dispatchedNow && !dispatchedBefore) status = "interrupted";
          else status = "failed";
          bag.steps[i].status = status === "unobserved" ? "failed" : status;
          bag.steps[i].error = errMsg(e).slice(0, 300);
          markUnstarted(bag.steps, i + 1);
          if (e && e.report && e.report.status === "unobserved") {
            throw workflowError(errMsg(e), workflowReport(bag, "unobserved", control));
          }
          throw workflowError(errMsg(e), workflowReport(bag, status, control));
        }
      }
      // The steps that needed the starting snapshot have finished. The view
      // this workflow returns is a new capture, not that id stamped onto new elements.
      if (observationNeedsCapture(bag.observation)) {
        bag.observation = await retainObservedSnapshot(auth);
        bag.observed = true;
      }
      return {
        status: "completed",
        dispatched: !!(control && control.dispatched),
        observed: bag.observed,
        steps: bag.steps,
        observation: bag.observation,
        before: bag.before,
        tabId: auth.tabId,
      };
    });
  } catch (e) {
    if (e && e.report) throw e;
    const status = (e && e.uncertain) || (control && control.dispatched)
      ? "uncertain"
      : control && !commandLive(control) ? "cancelled" : "failed";
    throw workflowError(errMsg(e), workflowReport(bag, status, control));
  }
}

async function cmdClose(params, state, ctx, epoch) {
  const auth = await authorizeTab(params, state, ctx, "close", epoch);
  await assertStillAuthorized(auth);
  assertActive(epoch);
  await chrome.tabs.remove(auth.tabId);
  await assertPermissions(state, epoch);
  return { tabId: auth.tabId, closed: true };
}

async function cmdEval(params, state, ctx, epoch) {
  if (!state.allowEval) throw new Error("eval: disabled in Options");
  const auth = await authorizeTab(params, state, ctx, "eval", epoch);
  const { js } = params;
  if (typeof js !== "string" || !js) throw new Error("eval: missing js");
  const value = await withDebugger(auth, () => evaluate(auth, js));
  return { tabId: auth.tabId, value: value ?? null };
}

const HANDLERS = {
  ping: cmdPing, tabs: cmdTabs, navigate: cmdNavigate, screenshot: cmdScreenshot,
  snapshot: cmdSnapshot, text: cmdText, click: cmdClick, type: cmdType, key: cmdKey,
  scroll: cmdScroll, close: cmdClose, eval: cmdEval, workflow: cmdWorkflow,
};

/* ---------- relay I/O ---------- */

let socket = null; // the live WebSocket, when open
const socketIdentities = new WeakMap();
const pendingResultAcks = new Map();

// The race covers fetch and body consumption. Abort releases a real fetch;
// the race also frees the command queue if a mocked or broken reader ignores it.
async function withRequestDeadline(ms, request) {
  const abort = new AbortController();
  let timer;
  try {
    return await Promise.race([
      request(abort.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("relay request timed out"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForResultAck(id, ws, token) {
  return new Promise((resolve) => {
    const previous = pendingResultAcks.get(id);
    if (previous) previous.finish("timeout");
    const record = { ws, token, finish: null };
    let settled = false;
    record.finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingResultAcks.get(id) === record) pendingResultAcks.delete(id);
      resolve(status);
    };
    const timer = setTimeout(() => record.finish("timeout"), resultAckTimeoutMs);
    pendingResultAcks.set(id, record);
  });
}

function failPendingResultAcks(ws) {
  for (const record of [...pendingResultAcks.values()]) {
    if (record.ws === ws) record.finish("timeout");
  }
}

function handleSocketMessage(msg, ws = socket, token = socketIdentities.get(ws)?.token,
  deliveryEpoch = controlEpoch) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "result_ack" || msg.type === "result_rejected") {
    const record = pendingResultAcks.get(msg.id);
    if (record && record.ws === ws && record.token === token) {
      record.finish(msg.type === "result_ack" ? "acked" : "rejected");
    }
    return;
  }
  if (msg.type === "cmd" && msg.cmd && socketIdentities.get(ws)?.welcomed) {
    schedule(msg.cmd, msg.now, token, deliveryEpoch, ws);
  }
}

async function postResult(deviceToken, id, outcome) {
  let body = JSON.stringify({
    token: deviceToken, id, ok: outcome.ok, data: outcome.data ?? null,
    error: outcome.ok ? null : outcome.error,
  });
  if (new TextEncoder().encode(body).byteLength > MAX_RESULT_BYTES) {
    body = JSON.stringify({ token: deviceToken, id, ok: false, data: null, error: "result too large to relay" });
  }
  // Retrying delivery never retries the browser action. Successful receipts
  // require the complete body; a stalled result cannot hold the queue forever.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await withRequestDeadline(RESULT_TIMEOUT_MS, async (signal) => {
        const res = await fetch(JUNO_RELAY_URL + "/result", {
          method: "POST", headers: { "content-type": "application/json" }, body, signal,
        });
        const receipt = res.ok ? await res.json() : null;
        return { res, receipt };
      });
      if (response.res.ok && response.receipt && response.receipt.ok === true) return true;
      if (response.res.status >= 400 && response.res.status < 500 &&
          response.res.status !== 408 && response.res.status !== 429) return false;
    } catch {
      /* fall through to the one bounded delivery retry */
    }
    if (attempt === 0) await sleep(RESULT_RETRY_MS);
  }
  return false;
}

// Bind both send and receipt to this exact socket and device. A late result
// from a previous pairing must use that pairing's HTTP identity instead.
async function sendResultOverSocket(deviceToken, id, outcome, originSocket) {
  const ws = originSocket || socket;
  const identity = ws && socketIdentities.get(ws);
  if (!ws || ws.readyState !== WebSocket.OPEN || !identity?.welcomed || identity.token !== deviceToken) return null;
  const msg = JSON.stringify({
    type: "result", id, ok: outcome.ok, data: outcome.data ?? null,
    error: outcome.ok ? null : outcome.error,
  });
  if (new TextEncoder().encode(msg).byteLength > WS_MAX_MSG) return null;
  const ack = waitForResultAck(id, ws, deviceToken);
  try {
    ws.send(msg);
  } catch {
    const record = pendingResultAcks.get(id);
    if (record && record.ws === ws) record.finish("timeout");
    return null;
  }
  return await ack;
}

async function sendResult(deviceToken, id, outcome, originSocket = null) {
  const receipt = await sendResultOverSocket(deviceToken, id, outcome, originSocket);
  if (receipt === "acked") return true;
  // Only a matching socket/device can settle this receipt. Its explicit
  // rejection is final, and is recorded as failed delivery in the local log.
  if (receipt === "rejected") return false;
  return await postResult(deviceToken, id, outcome);
}

// Runs one command under a timeout. The timer marks this command dead before
// rejecting, so a browser call that resolves later cannot keep going. The
// handler promise is retained only so that late rejection is not unhandled;
// the race's result is the one that is reported. A hung debugger session is
// force-detached when the race settles, which frees the queue for the next
// command.
async function runCommand(cmd, state, ctx) {
  const handler = Object.hasOwn(HANDLERS, cmd.action) ? HANDLERS[cmd.action] : null;
  if (!handler) return { ok: false, error: "unknown action: " + String(cmd.action).slice(0, 60) };
  const params = cmd.params && typeof cmd.params === "object" ? cmd.params : {};
  const control = { epoch: controlEpoch, dead: false };
  let timer = null;
  try {
    assertActive(control);
    // Promise.resolve().then so a handler that returns a plain value, or throws
    // synchronously, still becomes a promise the race can abandon.
    const execution = Promise.resolve().then(() => handler(params, state, ctx, control));
    execution.catch(() => {
      /* The race already observed a rejection, or this command was abandoned. */
    });
    const data = await Promise.race([
      execution,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          control.dead = true;
          reject(new Error(`command timed out after ${CMD_TIMEOUT_MS / 1000}s`));
        }, CMD_TIMEOUT_MS);
      }),
    ]);
    await assertPermissions(state, control);
    assertActive(control);
    return { ok: true, data };
  } catch (e) {
    const error = errMsg(e).slice(0, 500);
    if (e && e.report) return { ok: false, error, data: e.report };
    // Timeout sets dead before this runs. Pause moves the epoch. Either one
    // means this command must not be reported as a clean failure with no
    // dispatch state: a late browser call cannot revive it.
    if (control.dispatched || !commandLive(control)) {
      const data = {
        status: control.dispatched ? "uncertain" : "cancelled",
        dispatched: !!control.dispatched,
      };
      if (control.report && Array.isArray(control.report.steps)) {
        data.steps = control.report.steps;
        data.observed = !!control.report.observed;
        if (control.report.before) data.before = control.report.before;
      }
      return { ok: false, error, data };
    }
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
    await releaseAllDebuggers();
  }
}

async function finishTaken(state, cmd, outcome, ctx, originSocket = null) {
  const delivered = await sendResult(state.deviceToken, cmd.id, outcome, originSocket);
  try {
    await logActivity({
      action: String(cmd.action).slice(0, 40),
      target: ctx.target,
      ok: outcome.ok,
      resultDelivered: delivered,
      ...(!delivered ? { deliveryError: "result delivery failed; action will not be retried" } : {}),
      ...(outcome.ok ? {} : { error: String(outcome.error || "").slice(0, 160) }),
    });
  } catch {
    /* local log is best-effort */
  }
}

function sendAck(seq, deviceToken, originSocket) {
  const ws = originSocket || socket;
  const identity = ws && socketIdentities.get(ws);
  if (ws && ws.readyState === WebSocket.OPEN && identity?.welcomed && identity.token === deviceToken) {
    try {
      ws.send(JSON.stringify({ type: "ack", seq }));
    } catch {
      /* the next hello carries the cursor anyway */
    }
  }
}

// Commands run strictly one at a time, in arrival order, whichever transport
// delivered them. Pause invalidates anything still queued: its epoch no
// longer matches, and takeAndRun returns without running it.
let work = Promise.resolve();

function schedule(cmd, relayNow, originToken = null, scheduledEpoch = controlEpoch, originSocket = null) {
  const receivedAt = Date.now();
  const run = work.then(() => takeAndRun(cmd, relayNow, receivedAt, scheduledEpoch, originToken, originSocket));
  work = run.catch((err) => {
    console.error("juno-bridge: command queue error", err && err.stack ? err.stack : err);
  });
  return run;
}

// Takes a command at most once: skips anything at or below the cursor (a
// re-send after reconnect), saves the new cursor BEFORE running, then acks.
// Once the cursor is saved the command will not be redelivered, so every
// path after that point sends a result — including cancel and expiry.
async function takeAndRun(cmd, relayNow, receivedAt, scheduledEpoch, originToken = null, originSocket = null) {
  if (!cmd || typeof cmd.id !== "string") return;
  if (!acceptingCommands || scheduledEpoch !== controlEpoch) return;
  const state = await getState();
  if (!state.enabled || !state.deviceToken || (originToken && state.deviceToken !== originToken)) return;
  if (!acceptingCommands || scheduledEpoch !== controlEpoch) return;
  if (typeof cmd.seq === "number") {
    if (cmd.seq <= state.cursor) return;
    // A late save from the old pairing can update only that device's progress.
    await chrome.storage.local.set({ [cursorKey(state.deviceToken)]: cmd.seq });
    sendAck(cmd.seq, state.deviceToken, originSocket);
    if (!acceptingCommands || scheduledEpoch !== controlEpoch) {
      await finishTaken(state, cmd, { ok: false, error: "cancelled: extension paused" }, { target: "" }, originSocket);
      return;
    }
  }
  // Immediately before execution, not at receipt. Local wait covers time
  // queued behind other commands and time spent paused if this object was
  // held — redelivery after resume gets a new receivedAt and a new relayNow.
  const age = commandAgeMs(cmd, relayNow, receivedAt, Date.now());
  const ctx = { target: "" };
  let outcome;
  if (age == null) {
    outcome = { ok: false, error: "expired: unusable command timestamp, not run" };
  } else if (age > CMD_MAX_AGE_MS) {
    outcome = { ok: false, error: `expired: ${Math.round(age / 1000)}s old at execution, not run` };
  } else {
    outcome = await runCommand(cmd, state, ctx);
  }
  await finishTaken(state, cmd, outcome, ctx, originSocket);
}

/* ---------- live socket ---------- */

// Runs one socket session until it closes. Resolves with what happened so
// the loop can decide whether to reconnect, back off, or fall back to HTTP.
async function runSocket(token, after) {
  const outcome = { opened: false, welcomed: false, rejected: false };
  const sessionEpoch = controlEpoch;
  let ticket;
  try {
    const authorization = await withRequestDeadline(SOCKET_TICKET_TIMEOUT_MS, async (signal) => {
      const res = await fetch(JUNO_RELAY_URL + "/ws-ticket", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }), signal,
      });
      return { status: res.status, ok: res.ok, data: res.ok ? await res.json() : null };
    });
    // No socket is constructed for a paused, re-paired, or permission-changed
    // session, even if it was resumed while ticket issuance was in flight.
    if (!await deliveryCurrent(token, sessionEpoch)) return outcome;
    if (authorization.status === 401 || authorization.status === 403) {
      outcome.rejected = true;
      return outcome;
    }
    if (!authorization.ok || typeof authorization.data?.ticket !== "string" ||
        !/^[0-9a-f]{64}$/.test(authorization.data.ticket)) return outcome;
    ticket = authorization.data.ticket;
  } catch {
    return outcome; // old relays and unavailable ticket service use HTTP
  }
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(WS_URL, [SOCKET_PROTOCOL, "juno-ticket." + ticket]);
    } catch {
      resolve(outcome);
      return;
    }
    socket = ws;
    const identity = { token, welcomed: false };
    socketIdentities.set(ws, identity);
    let lastHeard = Date.now();
    let finished = false;
    let pinger;
    let welcomeTimer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(pinger);
      clearTimeout(welcomeTimer);
      failPendingResultAcks(ws);
      if (socket === ws) socket = null;
      resolve(outcome);
    };
    const stop = (code, reason) => {
      try { ws.close(code, reason); } catch { /* already closed */ }
      finish();
    };
    // Pongs cannot extend this absolute connect-and-welcome deadline.
    welcomeTimer = setTimeout(() => stop(4008, "welcome timeout"), SOCKET_WELCOME_TIMEOUT_MS);
    pinger = setInterval(() => {
      if (Date.now() - lastHeard > SOCKET_SILENCE_MS) {
        stop(4008, "silent");
        return;
      }
      try { ws.send("ping"); } catch { stop(4008, "send failed"); }
    }, PING_MS);
    ws.onopen = () => {
      if (finished || sessionEpoch !== controlEpoch || !acceptingCommands) {
        stop(1000, "state changed");
        return;
      }
      outcome.opened = true;
      try {
        ws.send(JSON.stringify({ type: "hello", after, version: chrome.runtime.getManifest().version }));
      } catch { stop(4008, "hello failed"); }
    };
    ws.onmessage = (ev) => {
      if (finished || sessionEpoch !== controlEpoch || !acceptingCommands) return;
      lastHeard = Date.now();
      if (ev.data === "pong" || typeof ev.data !== "string") return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "welcome") {
        outcome.welcomed = true;
        identity.welcomed = true;
        clearTimeout(welcomeTimer);
        failStreak = 0;
        setRelayState("ok", "live").catch(() => {});
        return;
      }
      if (msg.type === "error" && msg.error === "unknown_device") {
        outcome.rejected = true;
        stop(4003, "rejected");
        return;
      }
      if (identity.welcomed) handleSocketMessage(msg, ws, token, sessionEpoch);
    };
    ws.onclose = (ev) => {
      if (!finished && ev.code === 4003 && sessionEpoch === controlEpoch) outcome.rejected = true;
      finish();
    };
    ws.onerror = () => { /* onclose follows; the welcome timer also bounds it */ };
  });
}

function closeSocket(reason) {
  if (!socket) return;
  const ws = socket;
  failPendingResultAcks(ws);
  try { ws.close(1000, reason); } catch { /* already closed */ }
}

async function deliveryCurrent(token, epoch, requestedState = null) {
  if (epoch !== controlEpoch || !acceptingCommands) return false;
  const state = await getState();
  return epoch === controlEpoch && acceptingCommands && !!state.enabled && state.deviceToken === token &&
    (!requestedState || permissionKey(state) === permissionKey(requestedState));
}

/* ---------- HTTP fallback poll ---------- */

let failStreak = 0;

// Backoff when the relay is unreachable or erroring: 2.5s doubling up to
// 60s, so a dead relay doesn't get hammered and the loop stays cheap while down.
function pollDelayMs() {
  return Math.min(POLL_MS * Math.pow(2, Math.min(failStreak, 5)), MAX_BACKOFF_MS);
}

// Returns true if a command was handled (so the loop can poll again at once).
// Throws on relay trouble so the loop backs off.
async function pollOnce() {
  const deliveryEpoch = controlEpoch;
  const state = await getState();
  if (!state.enabled || !state.deviceToken || deliveryEpoch !== controlEpoch) return false;
  let response;
  try {
    response = await withRequestDeadline(POLL_TIMEOUT_MS, async (signal) => {
      const res = await fetch(JUNO_RELAY_URL + "/poll", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: state.deviceToken, after: state.cursor }), signal,
      });
      return { res, payload: res.ok && res.status !== 204 ? await res.json() : null };
    });
  } catch (e) {
    if (!await deliveryCurrent(state.deviceToken, deliveryEpoch, state) || deliveryEpoch !== controlEpoch) return false;
    await setRelayState("unreachable");
    throw e;
  }
  // An old request has no authority over the new pairing's status, cursor,
  // queue, or acknowledgements. Check before the first state write.
  if (!await deliveryCurrent(state.deviceToken, deliveryEpoch, state) || deliveryEpoch !== controlEpoch) return false;
  const { res, payload } = response;
  if (res.status === 401 || res.status === 403) {
    await setRelayState("rejected");
    throw new Error("relay rejected device token");
  }
  if (!res.ok) {
    await setRelayState("error");
    throw new Error("relay error " + res.status);
  }
  await setRelayState("ok", "polling");
  const cmd = payload && payload.cmd;
  if (!cmd || typeof cmd.id !== "string") return false;
  if (!await deliveryCurrent(state.deviceToken, deliveryEpoch, state)) return false;
  await schedule(cmd, payload.now, state.deviceToken, deliveryEpoch);
  return true;
}

/* ---------- pause / resume ---------- */

// Pause bumps the epoch (queued takeAndRun calls no-op), detaches debuggers,
// and closes the socket so nothing further is delivered. Commands not yet
// taken stay on the relay. On resume they are delivered again and run only
// if they are still inside the 2-minute window at execution.
function applyEnabled(enabled) {
  acceptingCommands = !!enabled;
  controlEpoch++;
  if (!enabled) releaseAllDebuggers().catch(() => {});
  lastRelayState = null;
  closeSocket(enabled ? "resumed" : "paused");
  if (typeof JUNO_TEST === "undefined" || !JUNO_TEST) kick();
}

/* ---------- main loop ---------- */

let running = false;

async function loop() {
  if (running) return;
  running = true;
  try {
    let pollUntil = 0; // while in the future, use HTTP polling instead of the socket
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const state = await getState();
      acceptingCommands = !!state.enabled && !!state.deviceToken;
      if (!state.enabled || !state.deviceToken) break; // go dormant; restarted on toggle/register

      if (Date.now() >= pollUntil) {
        const s = await runSocket(state.deviceToken, state.cursor);
        if (s.welcomed) {
          await sleep(500); // closed after a good session: reconnect promptly
          continue;
        }
        if (s.rejected) {
          // Token revoked or relay wiped: keep backing off until the user re-pairs.
          await setRelayState("rejected");
          failStreak++;
          await sleep(pollDelayMs());
          continue;
        }
        if (s.opened) {
          failStreak++; // connected but never welcomed: relay trouble
          await sleep(pollDelayMs());
          continue;
        }
        pollUntil = Date.now() + HTTP_FALLBACK_MS; // socket unavailable: poll for a while
      }

      let worked = false;
      try {
        worked = await pollOnce();
        failStreak = 0;
      } catch {
        // Nothing — not storage, not the network, not a handler bug — is
        // allowed to kill the loop. Back off and try again next tick.
        failStreak++;
      }
      if (!worked) await sleep(pollDelayMs());
    }
  } finally {
    running = false;
  }
}

function kick() {
  loop();
}

chrome.runtime.onStartup.addListener(kick);
chrome.runtime.onInstalled.addListener(kick);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) applyEnabled(!!changes.enabled.newValue);
  if (changes.deviceToken || changes.allowlist || changes.allowEval) {
    controlEpoch++;
    forgetSnapshots();
    releaseAllDebuggers().catch(() => {});
    lastRelayState = null;
    closeSocket("state change");
    if (typeof JUNO_TEST === "undefined" || !JUNO_TEST) kick();
  }
});

if (typeof JUNO_TEST !== "undefined" && JUNO_TEST) {
  globalThis.__juno = {
    HANDLERS,
    schedule,
    takeAndRun,
    getState,
    cursorKey,
    pollOnce,
    runSocket,
    sendResult,
    handleSocketMessage,
    commandAgeMs,
    CMD_MAX_AGE_MS,
    CMD_TIMEOUT_MS,
    SNAPSHOT_JS,
    pageTextExpression,
    forgetSnapshots,
    simulateWorkerRestart,
    attachSocket(ws, token) { socket = ws; socketIdentities.set(ws, { token, welcomed: true }); },
    setResultAckMs(ms) { resultAckTimeoutMs = ms; },
    epoch() { return controlEpoch; },
    drain() { return work; },
  };
} else {
  // Clicking the toolbar icon opens the side panel (there's no popup).
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // Start on service-worker boot (covers browser restart).
  kick();

  // MV3 service workers can be killed at any time. The kick() above restarts
  // the loop on every worker boot; this alarm is a backstop that wakes the
  // worker once a minute so a silently-dead loop can't stay dead.
  try {
    chrome.alarms.create("juno-watchdog", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === "juno-watchdog") kick();
    });
  } catch {
    /* alarms unavailable — the boot kick still applies */
  }
}
