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
const RESULT_ACK_MS_DEFAULT = 5000;
const NAV_WAIT_MS = 15000;
const CDP_VERSION = "1.3";
const LOG_CAP = 50;
const TEXT_CAP = 100000;
const MAX_RESULT_CHARS = 16 * 1024 * 1024;

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
// Bumped on pause, resume, and re-pair. A command captures the epoch when it
// is scheduled; a mismatch means that command must not touch the browser.
let controlEpoch = 0;
let acceptingCommands = true;

function cancelled() {
  const error = new Error("cancelled: extension paused");
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

async function getState() {
  return await chrome.storage.local.get({
    deviceToken: null,
    enabled: true,
    allowlist: [], // deny by default: you add sites explicitly in Options
    allowEval: false,
    cursor: 0, // seq of the last command taken from the relay
  });
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
  assertActive(control);
  const tab = await chrome.tabs.get(auth.tabId);
  assertActive(control);
  const url = tab.url || "";
  // Exact page, not merely "still on some allowlisted origin". The new URL
  // is deliberately absent from the error: it may itself be sensitive, and
  // it must not ride back through the relay in an error string.
  if (url !== auth.url || pageOrigin(url) !== auth.origin || !urlAllowed(url, auth.state.allowlist)) {
    throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
  }
}

async function readDocumentUrl(auth) {
  const control = auth.control || auth.epoch;
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
  assertActive(control);
  const value = res && res.result ? res.result.value : "";
  if (typeof value !== "string" || !value) {
    throw new Error(`${auth.verb}: could not confirm the authorized page`);
  }
  return value;
}

async function cdp(auth, method, params = {}, opts = {}) {
  await assertStillAuthorized(auth);
  // tab.url can lag the document. Bind the mutation to the page we authorized.
  const href = await readDocumentUrl(auth);
  if (href !== auth.url) {
    throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
  }
  if (detachedTabs.has(auth.tabId)) throw detachedError(auth);
  // After the page checks, immediately before the browser call. A failure
  // from here on may mean the input already reached Chrome.
  if (opts.dispatch && auth.control) auth.control.dispatched = true;
  try {
    return await chrome.debugger.sendCommand({ tabId: auth.tabId }, method, params);
  } catch (e) {
    if (detachedTabs.has(auth.tabId)) throw detachedError(auth);
    // Detach-on-pause rejects the in-flight call. The event may already have
    // reached Chrome; refusing the rest of the command is all pause can do.
    if (!commandLive(auth.control || auth.epoch)) throw cancelled();
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
  // world. contextId is set only while a workflow holds nodes for one document.
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

// Interactive elements with viewport-relative centre points (the coordinate
// space Input.dispatchMouseEvent uses). Values are copied only for fields
// that fail the secret check above.
function snapshotSource(storeNodes) {
  // storeNodes keeps the DOM node next to its ref inside an isolated world.
  // A one-shot snapshot leaves hold null, so its result matches the script
  // that does not store nodes.
  const holdPrelude = storeNodes
    ? "const hold = globalThis.__junoHold;"
    : "const hold = null;";
  return `(() => {
  ${holdPrelude}
  const SECRET_AUTOCOMPLETE = ${SECRET_AUTOCOMPLETE};
  const SECRET_HINT = ${SECRET_HINT};
  const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="textbox"],[role="menuitem"],[role="tab"],[contenteditable="true"]';
  const vw = window.innerWidth, vh = window.innerHeight;
  const els = [];
  for (const el of document.querySelectorAll(sel)) {
    if (els.length >= 300) break;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
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
    // ref is this snapshot's handle (e1, e2, ...). It is not a DOM id, and a
    // later snapshot assigns its own refs. Callers resolve a ref in code.
    const item = { ref: 'e' + (els.length + 1), tag, text, x, y, w: Math.round(r.width), h: Math.round(r.height),
      inView: x >= 0 && y >= 0 && x < vw && y < vh };
    if (el.href) item.href = String(el.href).slice(0, 160);
    if (type) item.inputType = type;
    if (secret) item.redacted = true;
    if (el.disabled) item.disabled = true;
    els.push(item);
    if (hold) hold.nodes.push(el);
  }
  return { title: document.title, url: location.href,
    viewport: { w: vw, h: vh }, scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    elements: els };
})()`;
}

const SNAPSHOT_JS = snapshotSource(false);

// href + NUL + timeOrigin. A reload of the same URL changes timeOrigin and
// drops the nodes held for the previous document.
const DOC_JS = `(() => {
  const key = location.href + "\\0" + (performance.timeOrigin || 0);
  let hold = globalThis.__junoHold;
  if (!hold || hold.key !== key) {
    hold = { key: key, nodes: [], url: location.href };
    globalThis.__junoHold = hold;
  }
  return { doc: hold.key, url: location.href };
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
  assertActive(epoch);
  const url = params.url;
  if (!url || typeof url !== "string") throw new Error("navigate: missing url");
  ctx.target = url;
  if (!urlAllowed(url, state.allowlist)) throw new Error("navigate: site not in allowlist");
  let tab;
  if (params.tabId !== undefined && params.tabId !== null) {
    const current = await resolveTab(params.tabId);
    if (!urlAllowed(current.url, state.allowlist)) {
      throw new Error("navigate: that tab's current page is not in allowlist");
    }
    assertActive(epoch);
    const again = await chrome.tabs.get(current.id);
    const againUrl = again.url || "";
    if (againUrl !== (current.url || "") || !urlAllowed(againUrl, state.allowlist)) {
      throw new Error("navigate: that tab changed or is no longer allowlisted");
    }
    // The second lookup was awaited. Pause or this command's timeout may
    // have landed during it. Recheck before the navigation is issued.
    assertActive(epoch);
    tab = await chrome.tabs.update(again.id, { url });
  } else {
    assertActive(epoch);
    tab = await chrome.tabs.create({ url, active: false });
  }
  // The navigation has been handed to Chrome. Pause cannot pull it back;
  // waiting for load is observation, not another mutation.
  const loaded = await waitForLoad(tab.id, NAV_WAIT_MS);
  const final = await chrome.tabs.get(tab.id);
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

async function cmdSnapshot(params, state, ctx, epoch) {
  const auth = await authorizeTab(params, state, ctx, "snapshot", epoch);
  const snap = await withDebugger(auth, () => evaluate(auth, SNAPSHOT_JS));
  refuseDrifted("snapshot", auth, snap && snap.url);
  return { tabId: auth.tabId, ...snap, redaction: "heuristic" };
}

async function cmdText(params, state, ctx, epoch) {
  const auth = await authorizeTab(params, state, ctx, "text", epoch);
  const page = await withDebugger(auth, () => evaluate(auth, pageTextExpression()));
  refuseDrifted("text", auth, page && page.url);
  return { tabId: auth.tabId, ...page, redaction: "none" };
}

function readyExpression(ready) {
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
    const refJson = JSON.stringify(ready.ref);
    const enabled = ready.type === "element_enabled" ? "if (el.disabled) return false;" : "";
    return `(() => {
      const hold = globalThis.__junoHold;
      if (!hold || !Array.isArray(hold.nodes)) return false;
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

function validateAfter(after) {
  if (after === undefined || after === null) return;
  if (!after || typeof after !== "object" || Array.isArray(after)) throw new Error("after: invalid");
  if (after.observe !== "snapshot" && after.observe !== "text") {
    throw new Error("after: observe must be snapshot or text");
  }
  if (after.ready !== undefined) readyExpression(after.ready);
}

async function waitReady(auth, ready) {
  const expression = readyExpression(ready);
  let timeoutMs = READY_BUDGET_MS;
  if (ready.timeoutMs !== undefined) {
    timeoutMs = Number(ready.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > READY_BUDGET_MS) {
      throw new Error("ready: timeoutMs must be between 0 and 15000");
    }
  }
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

async function collectAfter(auth, after) {
  validateAfter(after);
  if (after.ready) await waitReady(auth, after.ready);
  const href = await readDocumentUrl(auth);
  if (href !== auth.url) {
    throw new Error(`${auth.verb}: tab navigated away from the authorized page`);
  }
  if (after.observe === "snapshot") {
    const snap = await evaluate(auth, snapshotSource(false));
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

function resolveRefExpression(ref) {
  const refJson = JSON.stringify(ref);
  return `(() => {
    const hold = globalThis.__junoHold;
    if (!hold || !Array.isArray(hold.nodes)) return { ok: false };
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
    await clickAt(auth, x, y);
    if (!params || !params.after) return { tabId: auth.tabId, x, y };
    const observation = await collectAfter(auth, params.after);
    return { tabId: auth.tabId, x, y, dispatched: true, observed: true, observation };
  });
}

async function cmdType(params, state, ctx, epoch) {
  validateAfter(params && params.after);
  const auth = await authorizeTab(params, state, ctx, "type", epoch);
  const { text } = params;
  if (typeof text !== "string" || !text) throw new Error("type: missing text");
  return await withDebugger(auth, async () => {
    await cdp(auth, "Input.insertText", { text }, { dispatch: true });
    if (!params || !params.after) return { tabId: auth.tabId, chars: text.length };
    const observation = await collectAfter(auth, params.after);
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
    await cdp(auth, "Input.dispatchKeyEvent", def.text
      ? { ...base, type: "keyDown", text: def.text, unmodifiedText: def.text }
      : { ...base, type: "rawKeyDown" }, { dispatch: true });
    await cdp(auth, "Input.dispatchKeyEvent", { ...base, type: "keyUp" }, { dispatch: true });
    if (!params || !params.after) return { tabId: auth.tabId, key: def.key };
    const observation = await collectAfter(auth, params.after);
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
    const observation = await collectAfter(auth, params.after);
    return { tabId: auth.tabId, scroll: pos, dispatched: true, observed: true, observation };
  });
}

const STEP_OPS = new Set(["click", "type", "key", "scroll", "snapshot", "text", "wait"]);

function validateStep(step) {
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
  if (step.op === "wait") readyExpression(step.ready);
  if (step.after !== undefined) validateAfter(step.after);
}

function validateWorkflow(params) {
  const steps = params && params.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > WORKFLOW_MAX_STEPS) {
    throw new Error(`workflow: need 1 to ${WORKFLOW_MAX_STEPS} steps`);
  }
  for (const step of steps) validateStep(step);
  if (!params || !Number.isInteger(params.tabId)) throw new Error("workflow: tabId required");
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

async function runStep(auth, step, ctx) {
  if (step.op === "click") {
    const found = await evaluate(auth, resolveRefExpression(step.ref));
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
    const observation = step.after ? await collectAfter(auth, step.after) : null;
    return { result: { ref: step.ref, x: found.x, y: found.y }, observation };
  }
  if (step.op === "type") {
    await cdp(auth, "Input.insertText", { text: step.text }, { dispatch: true });
    const observation = step.after ? await collectAfter(auth, step.after) : null;
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
    const observation = step.after ? await collectAfter(auth, step.after) : null;
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
    const observation = step.after ? await collectAfter(auth, step.after) : null;
    return { result: { scroll: pos }, observation };
  }
  if (step.op === "snapshot") {
    const snap = await evaluate(auth, snapshotSource(false));
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
  await waitReady(auth, step.ready);
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
      await ensureWorld(auth);
      const doc = await evaluate(auth, DOC_JS);
      if (!doc || doc.url !== auth.url || typeof doc.doc !== "string") {
        throw new Error("workflow: could not confirm the authorized page");
      }
      auth.doc = doc.doc;
      const snap = await evaluate(auth, snapshotSource(true));
      refuseDrifted("workflow", auth, snap && snap.url);
      if (!snap || typeof snap !== "object") throw new Error("workflow: snapshot failed");
      bag.before = { ...snap, redaction: "heuristic" };
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
        try {
          const out = await runStep(auth, steps[i], ctx);
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
const pendingResultAcks = new Map();

function waitForResultAck(id) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingResultAcks.delete(id);
      resolve(status);
    };
    const timer = setTimeout(() => finish("timeout"), resultAckTimeoutMs);
    pendingResultAcks.set(id, finish);
  });
}

function failPendingResultAcks() {
  for (const finish of [...pendingResultAcks.values()]) finish("timeout");
}

function handleSocketMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "result_ack") {
    const finish = pendingResultAcks.get(msg.id);
    if (finish) finish("acked");
    return;
  }
  if (msg.type === "result_rejected") {
    const finish = pendingResultAcks.get(msg.id);
    if (finish) finish("rejected");
    return;
  }
  if (msg.type === "cmd" && msg.cmd) schedule(msg.cmd, msg.now);
}

async function postResult(deviceToken, id, outcome) {
  let body = JSON.stringify({
    token: deviceToken,
    id,
    ok: outcome.ok,
    data: outcome.data ?? null,
    error: outcome.ok ? null : outcome.error,
  });
  if (body.length > MAX_RESULT_CHARS) {
    body = JSON.stringify({ token: deviceToken, id, ok: false, data: null, error: "result too large to relay" });
  }
  // One retry: a dropped result leaves the driver waiting for a timeout, and
  // the command itself can't be re-run (the cursor has already moved on).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(JUNO_RELAY_URL + "/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.ok || (res.status >= 400 && res.status < 500)) return;
    } catch {
      /* fall through to retry */
    }
    await sleep(1000);
  }
}

// A socket send() is not delivery. The relay acks a result only after it has
// accepted ownership; anything else is posted over HTTP.
async function sendResultOverSocket(id, outcome) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const msg = JSON.stringify({
    type: "result",
    id,
    ok: outcome.ok,
    data: outcome.data ?? null,
    error: outcome.ok ? null : outcome.error,
  });
  if (msg.length > WS_MAX_MSG) return false;
  const ack = waitForResultAck(id);
  try {
    socket.send(msg);
  } catch {
    const finish = pendingResultAcks.get(id);
    if (finish) finish("timeout");
    return false;
  }
  const status = await ack;
  // "rejected" is still a receipt: the relay saw the result and refused it.
  // Posting the same body over HTTP would get the same answer.
  return status === "acked" || status === "rejected";
}

async function sendResult(deviceToken, id, outcome) {
  if (await sendResultOverSocket(id, outcome)) return;
  await postResult(deviceToken, id, outcome);
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

async function finishTaken(state, cmd, outcome, ctx) {
  await sendResult(state.deviceToken, cmd.id, outcome);
  try {
    await logActivity({
      action: String(cmd.action).slice(0, 40),
      target: ctx.target,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: String(outcome.error || "").slice(0, 160) }),
    });
  } catch {
    /* local log is best-effort */
  }
}

function sendAck(seq) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: "ack", seq }));
    } catch {
      /* the next hello carries the cursor anyway */
    }
  }
}

// Commands run strictly one at a time, in arrival order, whichever transport
// delivered them. Pause invalidates anything still queued: its epoch no
// longer matches, and takeAndRun returns without running it.
let work = Promise.resolve();

function schedule(cmd, relayNow) {
  const receivedAt = Date.now();
  const scheduledEpoch = controlEpoch;
  const run = work.then(() => takeAndRun(cmd, relayNow, receivedAt, scheduledEpoch));
  work = run.catch((err) => {
    console.error("juno-bridge: command queue error", err && err.stack ? err.stack : err);
  });
  return run;
}

// Takes a command at most once: skips anything at or below the cursor (a
// re-send after reconnect), saves the new cursor BEFORE running, then acks.
// Once the cursor is saved the command will not be redelivered, so every
// path after that point sends a result — including cancel and expiry.
async function takeAndRun(cmd, relayNow, receivedAt, scheduledEpoch) {
  if (!cmd || typeof cmd.id !== "string") return;
  if (!acceptingCommands || scheduledEpoch !== controlEpoch) return;
  const state = await getState();
  if (!state.enabled || !state.deviceToken) return;
  if (!acceptingCommands || scheduledEpoch !== controlEpoch) return;
  if (typeof cmd.seq === "number") {
    if (cmd.seq <= state.cursor) return;
    await chrome.storage.local.set({ cursor: cmd.seq });
    sendAck(cmd.seq);
    if (!acceptingCommands || scheduledEpoch !== controlEpoch) {
      await finishTaken(state, cmd, { ok: false, error: "cancelled: extension paused" }, { target: "" });
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
  await finishTaken(state, cmd, outcome, ctx);
}

/* ---------- live socket ---------- */

// Runs one socket session until it closes. Resolves with what happened so
// the loop can decide whether to reconnect, back off, or fall back to HTTP.
function runSocket(token, after) {
  return new Promise((resolve) => {
    const outcome = { opened: false, welcomed: false, rejected: false };
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      resolve(outcome);
      return;
    }
    socket = ws;
    let lastHeard = Date.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(pinger);
      failPendingResultAcks();
      if (socket === ws) socket = null;
      resolve(outcome);
    };
    // Keepalive doubles as dead-connection detection: the relay answers
    // "ping" with "pong", so silence means the connection is gone.
    const pinger = setInterval(() => {
      if (Date.now() - lastHeard > SOCKET_SILENCE_MS) {
        try {
          ws.close(4008, "silent");
        } catch {
          /* already closed */
        }
        finish();
        return;
      }
      try {
        ws.send("ping");
      } catch {
        /* close event follows */
      }
    }, PING_MS);

    ws.onopen = () => {
      outcome.opened = true;
      ws.send(JSON.stringify({
        type: "hello", token, after, version: chrome.runtime.getManifest().version,
      }));
    };
    ws.onmessage = (ev) => {
      lastHeard = Date.now();
      if (ev.data === "pong" || typeof ev.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "welcome") {
        outcome.welcomed = true;
        failStreak = 0;
        setRelayState("ok", "live").catch(() => {});
        return;
      }
      if (msg.type === "error" && msg.error === "unknown_device") {
        outcome.rejected = true;
        return;
      }
      handleSocketMessage(msg);
    };
    ws.onclose = (ev) => {
      if (ev.code === 4003) outcome.rejected = true;
      finish();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  });
}

function closeSocket(reason) {
  failPendingResultAcks();
  if (!socket) return;
  try {
    socket.close(1000, reason);
  } catch {
    /* already closed */
  }
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
  const state = await getState();
  if (!state.enabled || !state.deviceToken) return false;
  let res;
  try {
    // Token travels in the POST body only — never in the URL.
    res = await fetch(JUNO_RELAY_URL + "/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: state.deviceToken, after: state.cursor }),
    });
  } catch (e) {
    await setRelayState("unreachable");
    throw e;
  }
  if (res.status === 401 || res.status === 403) {
    await setRelayState("rejected");
    throw new Error("relay rejected device token");
  }
  if (!res.ok) {
    await setRelayState("error");
    throw new Error("relay error " + res.status);
  }
  await setRelayState("ok", "polling");
  if (res.status === 204) return false;

  const payload = await res.json();
  const cmd = payload && payload.cmd;
  if (!cmd || typeof cmd.id !== "string") return false;
  await schedule(cmd, payload.now);
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
  if (changes.deviceToken) {
    controlEpoch++;
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
    pollOnce,
    runSocket,
    sendResult,
    handleSocketMessage,
    commandAgeMs,
    CMD_MAX_AGE_MS,
    CMD_TIMEOUT_MS,
    SNAPSHOT_JS,
    pageTextExpression,
    attachSocket(ws) { socket = ws; },
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
