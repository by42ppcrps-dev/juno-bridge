/* Juno Bridge — background service worker.
 *
 * Holds a live WebSocket to the relay, receives commands from Juno the
 * instant they're sent, executes them against tabs via chrome.debugger
 * (Chrome DevTools Protocol), and sends results straight back. If the socket
 * can't be opened (older relay, network blocking WebSockets) it falls back to
 * polling over HTTP and retries the socket every minute.
 *
 * Safety model:
 *  - Kill switch: storage `enabled`. When false the loop goes dormant and
 *    nothing executes. You toggle it from the side panel.
 *  - Site allowlist: commands touching a URL outside the allowlist are
 *    rejected before anything runs, and `tabs` only reveals allowlisted tabs.
 *  - Stale commands (queued while paused, or delayed) are refused, not run.
 *  - Delivery is at-most-once: the cursor (highest seq taken) is saved
 *    before a command runs, so a crash or reconnect never replays a click.
 *  - Snapshots never include password, payment or one-time-code field values.
 *  - `eval` (arbitrary JS) is off by default; you enable it in Options.
 *  - Every action is appended to a local activity log you can inspect.
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
const CMD_MAX_AGE_MS = 120000; // measured on the relay's clock
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

async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null) {
    if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
    return await chrome.tabs.get(tabId);
  }
  // Service workers have no "current" window; use the one the user last focused.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

// Resolve the target tab and enforce the allowlist in one place. Records the
// URL on ctx for the local activity log (it is never sent to the relay).
async function allowedTab(params, state, ctx, verb) {
  const tab = await resolveTab(params.tabId);
  ctx.target = tab.url || "";
  if (!urlAllowed(tab.url, state.allowlist)) throw new Error(`${verb}: site not in allowlist`);
  return tab;
}

async function cdp(tabId, method, params = {}) {
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

// tabId → token of the command currently holding the debugger on it. Tokens
// stop a timed-out handler's late cleanup from detaching a newer session.
const debugSessions = new Map();

async function withDebugger(tabId, fn) {
  if (debugSessions.has(tabId)) throw new Error("tab is busy with another command");
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  const token = Symbol(tabId);
  debugSessions.set(tabId, token);
  try {
    return await fn();
  } finally {
    if (debugSessions.get(tabId) === token) await detachDebugger(tabId);
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
// settles belongs to a handler that timed out. Detaching also unblocks it.
async function releaseAllDebuggers() {
  await Promise.all([...debugSessions.keys()].map(detachDebugger));
}

// The user dismissing the "is debugging this browser" bar, or the tab closing.
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId !== undefined) debugSessions.delete(source.tabId);
});

async function evaluate(tabId, expression) {
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
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

/* ---------- command implementations ---------- */

// Interactive elements with viewport-relative centre points (the coordinate
// space Input.dispatchMouseEvent uses). Values of password, payment and
// one-time-code fields are never read, so they can't leave the machine.
const SNAPSHOT_JS = `(() => {
  const SECRET_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;
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
    const secret = type === 'password' || type === 'hidden' || SECRET_AUTOCOMPLETE.test(ac);
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const value = isField && !secret ? String(el.value || '') : '';
    const text = ((isField ? '' : el.innerText) || value || el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const item = { tag, text, x, y, w: Math.round(r.width), h: Math.round(r.height),
      inView: x >= 0 && y >= 0 && x < vw && y < vh };
    if (el.href) item.href = String(el.href).slice(0, 160);
    if (type) item.inputType = type;
    if (secret) item.redacted = true;
    if (el.disabled) item.disabled = true;
    els.push(item);
  }
  return { title: document.title, url: location.href,
    viewport: { w: vw, h: vh }, scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    elements: els };
})()`;

async function cmdPing() {
  return { version: chrome.runtime.getManifest().version, relay: JUNO_RELAY_URL };
}

// Only allowlisted tabs are visible to Juno; the rest are just counted.
async function cmdTabs(params, state, ctx) {
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

// Opens a background tab (never steals the user's focus), or reuses `tabId` if
// given — in which case that tab's current page must be allowlisted too.
async function cmdNavigate(params, state, ctx) {
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
    tab = await chrome.tabs.update(current.id, { url });
  } else {
    tab = await chrome.tabs.create({ url, active: false });
  }
  const loaded = await waitForLoad(tab.id, NAV_WAIT_MS);
  const final = await chrome.tabs.get(tab.id);
  const stillAllowed = urlAllowed(final.url || final.pendingUrl, state.allowlist);
  return {
    tabId: tab.id,
    loaded,
    // Don't reveal where an off-allowlist redirect went.
    url: stillAllowed ? final.url || final.pendingUrl || url : null,
    redirectedOffAllowlist: !stillAllowed,
  };
}

async function cmdScreenshot(params, state, ctx) {
  const tab = await allowedTab(params, state, ctx, "screenshot");
  const data = await withDebugger(tab.id, async () => {
    const res = await cdp(tab.id, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return res.data;
  });
  return { tabId: tab.id, image: "data:image/jpeg;base64," + data };
}

async function cmdSnapshot(params, state, ctx) {
  const tab = await allowedTab(params, state, ctx, "snapshot");
  const snap = await withDebugger(tab.id, () => evaluate(tab.id, SNAPSHOT_JS));
  return { tabId: tab.id, ...snap };
}

async function cmdText(params, state, ctx) {
  const tab = await allowedTab(params, state, ctx, "text");
  const page = await withDebugger(tab.id, () =>
    evaluate(
      tab.id,
      `(() => { const t = document.body ? document.body.innerText : '';
        return { title: document.title, url: location.href, length: t.length,
          text: t.slice(0, ${TEXT_CAP}), truncated: t.length > ${TEXT_CAP} }; })()`
    )
  );
  return { tabId: tab.id, ...page };
}

async function cmdClick(params, state, ctx) {
  const tab = await allowedTab(params, state, ctx, "click");
  const { x, y } = params;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click: missing x/y");
  ctx.target += ` @${x},${y}`;
  await withDebugger(tab.id, async () => {
    // Move first: hover handlers and some frameworks need it before the press.
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    const base = { x, y, button: "left", clickCount: 1 };
    await cdp(tab.id, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await cdp(tab.id, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  });
  return { tabId: tab.id, x, y };
}

async function cmdType(params, state, ctx) {
  const tab = await allowedTab(params, state, ctx, "type");
  const { text } = params;
  if (typeof text !== "string" || !text) throw new Error("type: missing text");
  await withDebugger(tab.id, () => cdp(tab.id, "Input.insertText", { text }));
  return { tabId: tab.id, chars: text.length };
}

async function cmdKey(params, state, ctx) {
  const tab = await allowedTab(params, state, ctx, "key");
  const { key } = params;
  const def = typeof key === "string" && Object.hasOwn(KEYS, key) ? KEYS[key] : null;
  if (!def) throw new Error("key: unsupported key " + String(key).slice(0, 40));
  ctx.target += ` [${def.code}]`;
  const base = {
    key: def.key, code: def.code,
    windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
  };
  await withDebugger(tab.id, async () => {
    await cdp(tab.id, "Input.dispatchKeyEvent", def.text
      ? { ...base, type: "keyDown", text: def.text, unmodifiedText: def.text }
      : { ...base, type: "rawKeyDown" });
    await cdp(tab.id, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  });
  return { tabId: tab.id, key: def.key };
}

// Scroll the page by (dx, dy) CSS px. With x/y, sends a wheel event at that
// point instead, which also scrolls inner scrollable panes.
async function cmdScroll(params, state, ctx) {
  const tab = await allowedTab(params, state, ctx, "scroll");
  const dx = params.dx === undefined ? 0 : params.dx;
  const dy = params.dy === undefined ? 0 : params.dy;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) {
    throw new Error("scroll: need a nonzero numeric dx or dy");
  }
  const atPoint = Number.isFinite(params.x) && Number.isFinite(params.y);
  const pos = await withDebugger(tab.id, async () => {
    if (atPoint) {
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: params.x, y: params.y, deltaX: dx, deltaY: dy,
      });
      await sleep(150); // let the scroll land before reading the position
    } else {
      await evaluate(tab.id, `window.scrollBy(${dx}, ${dy})`);
    }
    return await evaluate(tab.id, `({ x: Math.round(scrollX), y: Math.round(scrollY) })`);
  });
  return { tabId: tab.id, scroll: pos };
}

// Close a tab Juno is done with. tabId is required: never guess.
async function cmdClose(params, state, ctx) {
  if (params.tabId === undefined || params.tabId === null) throw new Error("close: tabId required");
  const tab = await allowedTab(params, state, ctx, "close");
  await chrome.tabs.remove(tab.id);
  return { tabId: tab.id, closed: true };
}

async function cmdEval(params, state, ctx) {
  if (!state.allowEval) throw new Error("eval: disabled in Options");
  const tab = await allowedTab(params, state, ctx, "eval");
  const { js } = params;
  if (typeof js !== "string" || !js) throw new Error("eval: missing js");
  const value = await withDebugger(tab.id, () => evaluate(tab.id, js));
  return { tabId: tab.id, value: value ?? null };
}

const HANDLERS = {
  ping: cmdPing, tabs: cmdTabs, navigate: cmdNavigate, screenshot: cmdScreenshot,
  snapshot: cmdSnapshot, text: cmdText, click: cmdClick, type: cmdType, key: cmdKey,
  scroll: cmdScroll, close: cmdClose, eval: cmdEval,
};

/* ---------- relay I/O ---------- */

let socket = null; // the live WebSocket, when open

async function postResult(deviceToken, id, outcome) {
  let body = JSON.stringify({
    token: deviceToken,
    id,
    ok: outcome.ok,
    data: outcome.ok ? outcome.data ?? null : null,
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

// Results go back over the live socket when possible; big ones (screenshots)
// and anything while the socket is down go over HTTP.
async function sendResult(deviceToken, id, outcome) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    const msg = JSON.stringify({
      type: "result",
      id,
      ok: outcome.ok,
      data: outcome.ok ? outcome.data ?? null : null,
      error: outcome.ok ? null : outcome.error,
    });
    if (msg.length <= WS_MAX_MSG) {
      try {
        socket.send(msg);
        return;
      } catch {
        /* fall back to HTTP */
      }
    }
  }
  await postResult(deviceToken, id, outcome);
}

// Runs one command under a timeout. A handler that never settles (hung
// debugger/CDP call) is abandoned and its debugger session force-detached,
// so the command queue and the tab are both freed.
async function runCommand(cmd, state, ctx) {
  const handler = Object.hasOwn(HANDLERS, cmd.action) ? HANDLERS[cmd.action] : null;
  if (!handler) return { ok: false, error: "unknown action: " + String(cmd.action).slice(0, 60) };
  const params = cmd.params && typeof cmd.params === "object" ? cmd.params : {};
  let timer = null;
  try {
    const data = await Promise.race([
      handler(params, state, ctx),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`command timed out after ${CMD_TIMEOUT_MS / 1000}s`)),
          CMD_TIMEOUT_MS
        );
      }),
    ]);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: errMsg(e).slice(0, 500) };
  } finally {
    clearTimeout(timer);
    await releaseAllDebuggers();
  }
}

async function handleCommand(cmd, state, relayNow) {
  const ctx = { target: "" };
  const age = relayNow - cmd.issued_at; // both on the relay's clock
  const outcome = Number.isFinite(age) && age > CMD_MAX_AGE_MS
    ? { ok: false, error: `expired: issued ${Math.round(age / 1000)}s ago, not run` }
    : await runCommand(cmd, state, ctx);
  await sendResult(state.deviceToken, cmd.id, outcome);
  try {
    await logActivity({
      action: String(cmd.action).slice(0, 40),
      target: ctx.target,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.error.slice(0, 160) }),
    });
  } catch {
    /* local log is best-effort */
  }
}

// Commands run strictly one at a time, in arrival order, whichever transport
// delivered them.
let work = Promise.resolve();

function schedule(cmd, relayNow) {
  work = work.then(() => takeAndRun(cmd, relayNow)).catch(() => {});
  return work;
}

// Takes a command at most once: skips anything at or below the cursor (a
// re-send after reconnect), saves the new cursor BEFORE running, then acks.
async function takeAndRun(cmd, relayNow) {
  if (!cmd || typeof cmd.id !== "string") return;
  const state = await getState();
  // Paused or unpaired: leave it untaken; the relay re-sends it on reconnect.
  if (!state.enabled || !state.deviceToken) return;
  if (typeof cmd.seq === "number") {
    if (cmd.seq <= state.cursor) return;
    await chrome.storage.local.set({ cursor: cmd.seq });
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "ack", seq: cmd.seq }));
      } catch {
        /* the next hello carries the cursor anyway */
      }
    }
  }
  await handleCommand(cmd, state, relayNow);
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
      } else if (msg.type === "cmd") {
        schedule(msg.cmd, msg.now);
      } else if (msg.type === "error" && msg.error === "unknown_device") {
        outcome.rejected = true;
      }
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
  if (changes.enabled || changes.deviceToken) {
    lastRelayState = null; // re-report connectivity for the new state
    closeSocket("state change"); // pause stops delivery now; re-pair reconnects with the new token
    kick();
  }
});

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
