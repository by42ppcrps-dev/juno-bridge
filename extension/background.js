/* Juno Bridge — background service worker.
 *
 * Polls the relay for commands from Juno, executes them against tabs via
 * chrome.debugger (Chrome DevTools Protocol), and posts results back.
 *
 * Safety model:
 *  - Kill switch: storage `enabled`. When false the loop goes dormant and
 *    nothing executes. You toggle it from the side panel.
 *  - Site allowlist: commands touching a URL outside the allowlist are
 *    rejected before anything runs.
 *  - `eval` (arbitrary JS) is off by default; you enable it in Options.
 *  - Every action is appended to a local activity log you can inspect.
 */

importScripts("config.js");

const POLL_MS = 2500;
const CDP_VERSION = "1.3";
const LOG_CAP = 50;

const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32,
};

async function getState() {
  const s = await chrome.storage.local.get({
    deviceToken: null,
    enabled: true,
    allowlist: [], // deny by default: you add sites explicitly in Options
    allowEval: false,
    log: [],
  });
  return s;
}

/* ---------- allowlist ---------- */

function hostAllowed(hostname, allowlist) {
  if (!hostname) return false;
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (hostname === entry || hostname.endsWith("." + entry)) return true;
  }
  return false;
}

function urlAllowed(url, allowlist) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return hostAllowed(u.hostname.toLowerCase(), allowlist);
  } catch {
    return false;
  }
}

/* ---------- activity log ---------- */

async function logActivity(entry) {
  const { log } = await chrome.storage.local.get({ log: [] });
  log.push({ t: Date.now(), ...entry });
  while (log.length > LOG_CAP) log.shift();
  await chrome.storage.local.set({ log });
  // Nudge the side panel to refresh, if open.
  try {
    await chrome.runtime.sendMessage({ type: "juno-log" });
  } catch {
    /* panel closed — fine */
  }
}

/* ---------- debugger helpers ---------- */

async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null) {
    return await chrome.tabs.get(tabId);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

async function cdp(tabId, method, params = {}) {
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

async function withDebugger(tabId, fn) {
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  try {
    return await fn();
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already detached */
    }
  }
}

/* ---------- command implementations ---------- */

const SNAPSHOT_JS = `(() => {
  const els = [];
  const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="textbox"],[role="menuitem"]';
  const nodes = document.querySelectorAll(sel);
  for (let i = 0; i < nodes.length && els.length < 300; i++) {
    const el = nodes[i];
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const item = { tag: el.tagName.toLowerCase(), text,
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height) };
    if (el.href) item.href = el.href.slice(0, 160);
    if (el.type) item.inputType = el.type;
    els.push(item);
  }
  return { title: document.title, url: location.href,
    viewport: { w: window.innerWidth, h: window.innerHeight }, elements: els };
})()`;

async function cmdPing() {
  return { version: chrome.runtime.getManifest().version, relay: JUNO_RELAY_URL };
}

async function cmdTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({ id: t.id, title: (t.title || "").slice(0, 120), url: t.url || "" })),
  };
}

async function cmdNavigate(params, state) {
  const url = params.url;
  if (!url || typeof url !== "string") throw new Error("navigate: missing url");
  if (!urlAllowed(url, state.allowlist)) throw new Error("navigate: site not in allowlist");
  const tab = await chrome.tabs.create({ url, active: false }); // background tab: never steal the user's focus
  await logActivity({ action: "navigate", target: url, ok: true });
  return { tabId: tab.id };
}

async function cmdScreenshot(params, state) {
  const tab = await resolveTab(params.tabId);
  if (!urlAllowed(tab.url, state.allowlist)) throw new Error("screenshot: site not in allowlist");
  const data = await withDebugger(tab.id, async () => {
    const res = await cdp(tab.id, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return res.data;
  });
  await logActivity({ action: "screenshot", target: tab.url, ok: true });
  return { tabId: tab.id, image: "data:image/jpeg;base64," + data };
}

async function cmdSnapshot(params, state) {
  const tab = await resolveTab(params.tabId);
  if (!urlAllowed(tab.url, state.allowlist)) throw new Error("snapshot: site not in allowlist");
  const snap = await withDebugger(tab.id, async () => {
    const res = await cdp(tab.id, "Runtime.evaluate", {
      expression: SNAPSHOT_JS,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error("page script failed");
    return res.result.value;
  });
  await logActivity({ action: "snapshot", target: tab.url, ok: true });
  return { tabId: tab.id, ...snap };
}

async function cmdClick(params, state) {
  const tab = await resolveTab(params.tabId);
  if (!urlAllowed(tab.url, state.allowlist)) throw new Error("click: site not in allowlist");
  const { x, y } = params;
  if (typeof x !== "number" || typeof y !== "number") throw new Error("click: missing x/y");
  await withDebugger(tab.id, async () => {
    const base = { x, y, button: "left", clickCount: 1 };
    await cdp(tab.id, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await cdp(tab.id, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  });
  await logActivity({ action: "click", target: `${tab.url} @${x},${y}`, ok: true });
  return { tabId: tab.id, x, y };
}

async function cmdType(params, state) {
  const tab = await resolveTab(params.tabId);
  if (!urlAllowed(tab.url, state.allowlist)) throw new Error("type: site not in allowlist");
  const { text } = params;
  if (typeof text !== "string" || !text) throw new Error("type: missing text");
  await withDebugger(tab.id, async () => {
    await cdp(tab.id, "Input.insertText", { text });
  });
  await logActivity({ action: "type", target: tab.url, ok: true });
  return { tabId: tab.id, chars: text.length };
}

async function cmdKey(params, state) {
  const tab = await resolveTab(params.tabId);
  if (!urlAllowed(tab.url, state.allowlist)) throw new Error("key: site not in allowlist");
  const { key } = params;
  const code = KEY_CODES[key];
  if (!code) throw new Error("key: unsupported key " + key);
  await withDebugger(tab.id, async () => {
    await cdp(tab.id, "Input.dispatchKeyEvent", {
      type: "keyDown", windowsVirtualKeyCode: code, key, code: key,
    });
    await cdp(tab.id, "Input.dispatchKeyEvent", {
      type: "keyUp", windowsVirtualKeyCode: code, key, code: key,
    });
  });
  await logActivity({ action: "key", target: `${tab.url} [${key}]`, ok: true });
  return { tabId: tab.id, key };
}

async function cmdEval(params, state) {
  if (!state.allowEval) throw new Error("eval: disabled in Options");
  const tab = await resolveTab(params.tabId);
  if (!urlAllowed(tab.url, state.allowlist)) throw new Error("eval: site not in allowlist");
  const { js } = params;
  if (typeof js !== "string" || !js) throw new Error("eval: missing js");
  const value = await withDebugger(tab.id, async () => {
    const res = await cdp(tab.id, "Runtime.evaluate", {
      expression: js,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error("page threw: " + (res.exceptionDetails.text || "exception").slice(0, 200));
    }
    return res.result.value;
  });
  await logActivity({ action: "eval", target: tab.url, ok: true });
  return { tabId: tab.id, value: JSON.parse(JSON.stringify(value ?? null)) };
}

const HANDLERS = {
  ping: cmdPing, tabs: cmdTabs, navigate: cmdNavigate, screenshot: cmdScreenshot,
  snapshot: cmdSnapshot, click: cmdClick, type: cmdType, key: cmdKey, eval: cmdEval,
};

/* ---------- relay I/O ---------- */

async function postResult(deviceToken, id, ok, data, error) {
  try {
    await fetch(JUNO_RELAY_URL + "/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: deviceToken, id, ok, data: data || null, error: error || null }),
    });
  } catch {
    /* Relay unreachable: the command was already consumed from the queue,
       so the driver will see it as pending until it gives up. Either way,
       a failed result-post must never kill the poll loop. */
  }
}

async function handleCommand(cmd, state) {
  const { id, action, params } = cmd;
  let ok = false;
  try {
    const handler = HANDLERS[action];
    if (!handler) {
      await postResult(state.deviceToken, id, false, null, "unknown action: " + action);
    } else {
      const data = await handler(params || {}, state);
      await postResult(state.deviceToken, id, true, data, null);
      ok = true;
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await postResult(state.deviceToken, id, false, null, msg.slice(0, 500));
  }
  try {
    await logActivity({ action, target: "", ok });
  } catch {
    /* local log is best-effort */
  }
}

/* ---------- poll loop ---------- */

let polling = false;

let failStreak = 0;

// Backoff when the relay is unreachable: 2.5s doubling up to 60s, so a
// dead relay doesn't get hammered and the loop stays cheap while down.
function pollDelayMs() {
  return Math.min(POLL_MS * Math.pow(2, Math.min(failStreak, 4)), 60000);
}

async function pollOnce() {
  try {
    await pollOnceInner();
    failStreak = 0;
  } catch {
    // Nothing — not storage, not the network, not a handler bug — is
    // allowed to kill the poll loop. Back off and try again next tick.
    failStreak++;
  }
}

async function pollOnceInner() {
  const state = await getState();
  if (!state.enabled || !state.deviceToken) return;
  let res;
  try {
    // Token travels in the POST body only — never in the URL.
    res = await fetch(JUNO_RELAY_URL + "/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: state.deviceToken }),
    });
  } catch {
    return; // relay unreachable — try again next tick
  }
  if (res.status === 204) return;
  if (!res.ok) return;
  let payload;
  try {
    payload = await res.json();
  } catch {
    return;
  }
  if (payload && payload.cmd) {
    await handleCommand(payload.cmd, state);
  }
}

async function loop() {
  if (polling) return;
  polling = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await pollOnce();
      await new Promise((r) => setTimeout(r, pollDelayMs()));
      const { enabled, deviceToken } = await chrome.storage.local.get({
        enabled: true, deviceToken: null,
      });
      if (!enabled || !deviceToken) break; // go dormant; restarted on toggle/register
    }
  } finally {
    polling = false;
  }
}

function kick() {
  loop();
}

chrome.runtime.onStartup.addListener(kick);
chrome.runtime.onInstalled.addListener(kick);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled || changes.deviceToken) kick();
});

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
