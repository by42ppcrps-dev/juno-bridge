// Mock checks for the extension service worker. They do not load Chrome.

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import vm from "node:vm";

// The extension realm's Uint8Array is not the host's. Fill a host buffer,
// then copy the bytes so getRandomValues accepts the view.
function fillRandom(target) {
  const host = new Uint8Array(target.length);
  webcrypto.getRandomValues(host);
  for (let i = 0; i < host.length; i++) target[i] = host[i];
  return target;
}

const root = path.resolve(import.meta.dirname, "..");
const source = ["config.js", "allowlist.js", "background.js"]
  .map((name) => fs.readFileSync(path.join(root, "extension", name), "utf8"))
  .join("\n");
const prefixed = `
var __junoClock = Date.now();
Date.now = function () { return __junoClock; };
function __setJunoClock(t) { __junoClock = t; }
function __junoClockNow() { return __junoClock; }
if (Date.now() !== __junoClock) throw new Error("Date.now is not writable in this realm");
` + source;

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static latest = null;

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    MockWebSocket.latest = this;
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.OPEN;
      if (typeof this.onopen === "function") this.onopen();
    });
  }

  send(data) {
    this.sent.push(String(data));
    let msg = null;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg && msg.type === "result" && typeof this.onmessage === "function") {
      const ack = JSON.stringify({ type: "result_ack", id: msg.id });
      queueMicrotask(() => {
        if (this.readyState === MockWebSocket.OPEN && typeof this.onmessage === "function") {
          this.onmessage({ data: ack });
        }
      });
    }
  }

  close(code = 1000, reason = "") {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    if (typeof this.onclose === "function") this.onclose({ code, reason });
  }
}
MockWebSocket.OPEN = 1;

let cmdN = 0;

function command(over = {}) {
  cmdN += 1;
  return {
    id: "cmd_" + cmdN.toString(16).padStart(16, "0"),
    seq: cmdN,
    action: "ping",
    params: {},
    ...over,
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(pred) {
  for (let i = 0; i < 40 && !pred(); i++) await tick();
  assert.equal(pred(), true);
}

function mouseTypes(env) {
  return env.debuggerCalls
    .filter((call) => call.method === "Input.dispatchMouseEvent")
    .map((call) => call.params.type);
}

function labeledButton(text, rect) {
  const button = pageButton([rect]);
  button.innerText = text;
  return button;
}

function debuggerUse(env) {
  return {
    attach: methodCalls(env, "attach").length,
    detach: methodCalls(env, "detach").length,
    results: env.fetches.filter((item) => item.url.endsWith("/result")).length,
  };
}

function dropHold(env) {
  vm.runInContext(
    "globalThis.__junoHold = undefined; delete globalThis.__junoHold;",
    env.page.realm,
  );
  assert.equal(vm.runInContext("globalThis.__junoHold == null", env.page.realm), true);
}

// The page can copy these onto a different node. Recovery must ignore them.
function copyCaptureMarks(el, snapshot) {
  el.setAttribute("data-juno-snap", snapshot);
  el.setAttribute("data-juno-ref", "e1");
  el.setAttribute("data-juno-doc", "1000");
}

// Remote objects and backend node ids for one page realm. A backend id is
// assigned when the node is described and follows that object, not its attributes.
function createPageSession(realm) {
  let nextObject = 1;
  let nextBackend = 1;
  const objects = new Map();
  const backends = new Map();
  function track(value) {
    const objectId = "obj_" + nextObject++;
    objects.set(objectId, value);
    return objectId;
  }
  function backendIdFor(el) {
    if (!el || typeof el !== "object") return 0;
    if (!el._backendNodeId) {
      el._backendNodeId = nextBackend++;
      backends.set(el._backendNodeId, el);
    }
    return el._backendNodeId;
  }
  return {
    dropBackend(el) {
      if (el && el._backendNodeId) backends.delete(el._backendNodeId);
    },
    handle(method, params) {
      if (method === "Runtime.evaluate" && params && params.expression !== "location.href") {
        let value;
        try {
          value = vm.runInContext(params.expression, realm);
        } catch (err) {
          return { exceptionDetails: { text: String((err && err.message) || err) } };
        }
        if (params.returnByValue === false) {
          if (value == null) return { result: { type: "object", subtype: "null", value: null } };
          return {
            result: {
              type: "object",
              subtype: Array.isArray(value) ? "array" : "node",
              objectId: track(value),
            },
          };
        }
        return { result: { value } };
      }
      if (method === "Runtime.getProperties" && params) {
        const value = objects.get(params.objectId);
        const result = [];
        if (Array.isArray(value)) {
          value.forEach((el, index) => {
            result.push({
              name: String(index),
              value: el == null
                ? { type: "object", subtype: "null", value: null }
                : { type: "object", subtype: "node", objectId: track(el) },
            });
          });
          result.push({ name: "length", value: { type: "number", value: value.length } });
        }
        return { result };
      }
      if (method === "DOM.describeNode" && params) {
        const el = objects.get(params.objectId);
        const backendNodeId = backendIdFor(el);
        if (!backendNodeId) throw new Error("No node with given id found");
        return { node: { nodeId: backendNodeId, backendNodeId, nodeName: el.tagName || "DIV" } };
      }
      if (method === "DOM.resolveNode" && params) {
        const el = backends.get(params.backendNodeId);
        if (!el) throw new Error("No node with given id found");
        return { object: { type: "object", subtype: "node", objectId: track(el) } };
      }
      if (method === "Runtime.callFunctionOn" && params) {
        const args = (params.arguments || []).map((arg) => {
          if (arg && arg.objectId) return objects.get(arg.objectId);
          return arg && Object.prototype.hasOwnProperty.call(arg, "value") ? arg.value : undefined;
        });
        realm.__callArgs = args;
        realm.__callThis = params.objectId ? objects.get(params.objectId) : realm;
        try {
          const value = vm.runInContext(
            `(function(){ const fn = (${params.functionDeclaration}); return fn.apply(globalThis.__callThis, globalThis.__callArgs); })()`,
            realm,
          );
          return { result: { value } };
        } catch (err) {
          return { exceptionDetails: { text: String((err && err.message) || err) } };
        } finally {
          delete realm.__callArgs;
          delete realm.__callThis;
        }
      }
      return undefined;
    },
  };
}

// Replaces the 30s command timer with a callback the test fires itself.
function captureCommandTimeout(env) {
  const realSet = env.sandbox.setTimeout;
  const realClear = env.sandbox.clearTimeout;
  const pending = new Set();
  env.sandbox.setTimeout = (fn, ms, ...args) => {
    if (ms === env.juno.CMD_TIMEOUT_MS) {
      const id = { junoCommandTimer: true, fn };
      pending.add(id);
      return id;
    }
    return realSet(fn, ms, ...args);
  };
  env.sandbox.clearTimeout = (id) => {
    if (id && id.junoCommandTimer) {
      pending.delete(id);
      return;
    }
    return realClear(id);
  };
  return {
    fire() {
      const ids = [...pending];
      pending.clear();
      for (const id of ids) id.fn();
    },
  };
}

function resultFor(env, id) {
  const found = env.fetches.filter((item) => item.url.endsWith("/result") && item.body && item.body.id === id);
  return found.length ? found[found.length - 1].body : undefined;
}

function element({ tag = "input", attrs = {}, value = "", text = "", label = "" }) {
  return {
    tagName: tag.toUpperCase(),
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() {
      return { x: 10, y: 12, width: 100, height: 20 };
    },
    value,
    innerText: text,
    labels: label ? [{ innerText: label }] : null,
    disabled: false,
  };
}

function boot(options = {}) {
  const store = {
    deviceToken: "ab".repeat(32),
    enabled: true,
    allowlist: ["example.com"],
    allowEval: false,
    cursor: 0,
    log: [],
    ...options.store,
  };
  const tabs = new Map();
  const onChanged = [];
  const debuggerCalls = [];
  const queryCalls = [];
  const created = [];
  const fetches = [];
  const fetchControl = { fn: null };
  let tabGets = 0;
  const detachListeners = [];
  let nextTabId = 50;
  let alarmsCreated = 0;
  let panelOpens = 0;

  const chrome = {
    runtime: {
      getManifest: () => ({ version: "1.3.0" }),
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: {
        get(defaults) {
          const out = typeof defaults === "string" ? { [defaults]: undefined }
            : Array.isArray(defaults) ? Object.fromEntries(defaults.map((key) => [key, undefined]))
            : defaults == null ? { ...store } : { ...defaults };
          for (const key of Object.keys(out)) {
            if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
          }
          return Promise.resolve(out);
        },
        set(obj) {
          const changes = {};
          for (const [key, value] of Object.entries(obj)) {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = value;
          }
          for (const fn of onChanged) fn(changes, "local");
          return Promise.resolve();
        },
        remove(keys) {
          const changes = {};
          for (const key of typeof keys === "string" ? [keys] : keys) {
            if (Object.prototype.hasOwnProperty.call(store, key)) {
              changes[key] = { oldValue: store[key] };
              delete store[key];
            }
          }
          for (const fn of onChanged) fn(changes, "local");
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener(fn) {
          onChanged.push(fn);
        },
      },
    },
    tabs: {
      get(id) {
        tabGets += 1;
        const tab = tabs.get(id);
        if (!tab) return Promise.reject(new Error("No tab with id: " + id));
        if (options.tabsGet) {
          const custom = options.tabsGet(id, tabGets, tab);
          if (custom) return Promise.resolve(custom);
        }
        return Promise.resolve({ ...tab });
      },
      query(info) {
        queryCalls.push(info);
        return Promise.resolve([...tabs.values()].map((tab) => ({ ...tab })));
      },
      create(props) {
        created.push({ ...props });
        const id = nextTabId++;
        const tab = { id, url: props.url, active: !!props.active, pendingUrl: props.url, status: "loading" };
        tabs.set(id, tab);
        return Promise.resolve({ ...tab });
      },
      update(id, props) {
        const tab = tabs.get(id);
        if (!tab) return Promise.reject(new Error("No tab with id: " + id));
        Object.assign(tab, props);
        return Promise.resolve({ ...tab });
      },
      remove(id) {
        tabs.delete(id);
        return Promise.resolve();
      },
      onUpdated: {
        addListener(fn) {
          queueMicrotask(() => {
            for (const tab of tabs.values()) fn(tab.id, { status: "complete" });
          });
        },
        removeListener() {},
      },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    debugger: {
      attach(target, version) {
        debuggerCalls.push({ method: "attach", params: target, version });
        return Promise.resolve();
      },
      detach(target) {
        debuggerCalls.push({ method: "detach", params: target });
        const tabId = target && target.tabId;
        for (const fn of detachListeners) fn({ tabId });
        return Promise.resolve();
      },
      async sendCommand(target, method, params) {
        debuggerCalls.push({ method, params });
        if (options.sendCommand) {
          const custom = await options.sendCommand({ target, method, params, chrome, store, tabs });
          if (custom !== undefined) return custom;
        }
        if (method === "Runtime.evaluate" && params && params.expression === "location.href") {
          const tab = tabs.get(target.tabId);
          return { result: { value: (tab && (tab.href || tab.url)) || "" } };
        }
        if (method === "Page.getFrameTree") {
          const tab = tabs.get(target.tabId);
          const url = new URL((tab && (tab.href || tab.url)) || "https://example.com/page");
          url.hash = "";
          return { frameTree: { frame: { id: "frame-1", url: url.href,
            loaderId: "loader-" + ((tab && tab.timeOrigin) || 1000) } } };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: 4 };
        }
        if (method === "Page.captureScreenshot") return { data: "QUJD" };
        if (method === "Runtime.evaluate" && options.pageEval) {
          return { result: { value: options.pageEval(params.expression, target) } };
        }
        return {};
      },
      onDetach: {
        addListener(fn) {
          detachListeners.push(fn);
        },
      },
    },
    sidePanel: {
      setPanelBehavior() {
        panelOpens += 1;
        return Promise.resolve();
      },
    },
    alarms: {
      create() {
        alarmsCreated += 1;
      },
      onAlarm: { addListener() {} },
    },
  };

  const sandbox = {
    JUNO_TEST: true,
    importScripts() {},
    chrome,
    console,
    URL,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    WebSocket: MockWebSocket,
    crypto: {
      getRandomValues(target) {
        return fillRandom(target);
      },
    },
  };
  sandbox.fetch = async (url, opts) => {
    let body = null;
    if (opts && opts.body) body = JSON.parse(opts.body);
    fetches.push({ url: String(url), body });
    if (fetchControl.fn) return fetchControl.fn(String(url), body, opts);
    if (String(url).endsWith("/ws-ticket")) {
      return { ok: true, status: 200, json: async () => ({ ticket: "cd".repeat(32), expires_in: 30 }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  vm.createContext(sandbox);
  sandbox.JUNO_TEST = true;
  sandbox.WebSocket = MockWebSocket;
  sandbox.crypto = {
    getRandomValues(target) {
      return fillRandom(target);
    },
  };
  sandbox.chrome = chrome;
  sandbox.importScripts = () => {};
  sandbox.fetch = sandbox.fetch;
  let testSource = prefixed;
  for (const [name, value] of Object.entries({ ...options.timeouts, ...options.constants })) {
    testSource = testSource.replace(new RegExp(`const ${name} = [^;]+;`), `const ${name} = ${value};`);
  }
  vm.runInContext(testSource, sandbox, { filename: "extension/background.js" });
  sandbox.WebSocket = MockWebSocket;

  const juno = sandbox.__juno || (sandbox.globalThis && sandbox.globalThis.__juno);
  if (!juno) throw new Error("JUNO_TEST hook missing; the service worker started in production mode");
  if (alarmsCreated !== 0 || panelOpens !== 0) throw new Error("production startup ran under test");
  if (sandbox.WebSocket !== MockWebSocket) throw new Error("mock WebSocket was not installed");
  const probed = sandbox.__junoClockNow();
  sandbox.__setJunoClock(probed + 5);
  if (vm.runInContext("Date.now()", sandbox) !== probed + 5) {
    throw new Error("Date.now patch is not visible to extension code");
  }
  sandbox.__setJunoClock(probed);

  return {
    juno,
    sandbox,
    chrome,
    store,
    tabs,
    debuggerCalls,
    queryCalls,
    created,
    fetches,
    fetchControl,
    now: () => sandbox.__junoClockNow(),
    setClock: (t) => sandbox.__setJunoClock(t),
    addTab(id, url) {
      tabs.set(id, { id, url, active: false, status: "complete" });
    },
    fireDetach(tabId) {
      for (const fn of detachListeners) fn({ tabId });
    },
    cursor() {
      const scoped = store[juno.cursorKey(store.deviceToken)];
      return scoped ?? ((!store.legacyCursorToken || store.legacyCursorToken === store.deviceToken) ? store.cursor : 0);
    },
    state() {
      return {
        deviceToken: store.deviceToken,
        enabled: store.enabled,
        allowlist: store.allowlist.slice(),
        allowEval: !!store.allowEval,
        cursor: this.cursor(),
      };
    },
  };
}

function bootOptions(env, newToken) {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", checked: false, hidden: false, disabled: false,
      textContent: "", className: "", listeners: new Map(),
      addEventListener(type, fn) { this.listeners.set(type, fn); },
    });
    return nodes.get(id);
  } };
  const sandbox = {
    chrome: env.chrome, document, URL,
    fetch: async (url) => ({ ok: true, status: 200, json: async () =>
      String(url).endsWith("/register") ? { device_token: newToken } : { ok: true } }),
  };
  vm.createContext(sandbox);
  const source = ["config.js", "allowlist.js", "options.js"]
    .map((name) => fs.readFileSync(path.join(root, "extension", name), "utf8")).join("\n");
  vm.runInContext(source, sandbox);
  return {
    nodes,
    async register() {
      nodes.get("code").value = "SYNTHETIC";
      await nodes.get("registerBtn").listeners.get("click")();
      assert.equal(nodes.get("status").className, "ok", nodes.get("status").textContent);
    },
  };
}

const FILTER_RECT = { x: 10, y: 20, width: 80, height: 20 };

function pageButton(rects) {
  return {
    tagName: "BUTTON",
    isConnected: true,
    disabled: false,
    innerText: "Filter",
    value: "",
    labels: null,
    href: "",
    _rects: rects,
    _n: 0,
    _attrs: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this._attrs[name];
    },
    getBoundingClientRect() {
      const rect = this._rects[Math.min(this._n, this._rects.length - 1)];
      this._n += 1;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.y,
        left: rect.x,
        bottom: rect.y + rect.height,
        right: rect.x + rect.width,
      };
    },
  };
}

// One document the workflow evaluates in. location.href checks stay on the tab mock.
function bootPage(extra = {}) {
  const button = extra.button || pageButton(extra.rects || [FILTER_RECT]);
  if (extra.disabled) button.disabled = true;
  const nodes = extra.nodes ? extra.nodes.slice() : [button];
  const realm = vm.createContext({
    document: {
      title: "Results",
      body: { innerText: extra.bodyText || "Results for invoices" },
      querySelectorAll(selector) {
        const sel = String(selector || "");
        if (sel === "[data-juno-snap]") {
          return nodes.filter((el) => el.getAttribute && el.getAttribute("data-juno-snap"));
        }
        const snap = sel.match(/\[data-juno-snap="([^"]+)"\]/);
        if (snap) {
          const refMatch = sel.match(/\[data-juno-ref="([^"]+)"\]/);
          const docMatch = sel.match(/\[data-juno-doc="([^"]+)"\]/);
          return nodes.filter((el) => {
            if (!el.getAttribute || el.isConnected === false) return false;
            if (el.getAttribute("data-juno-snap") !== snap[1]) return false;
            if (refMatch && el.getAttribute("data-juno-ref") !== refMatch[1]) return false;
            if (docMatch && el.getAttribute("data-juno-doc") !== docMatch[1]) return false;
            return true;
          });
        }
        return nodes.slice();
      },
    },
    window: {
      innerWidth: 800,
      innerHeight: 600,
      scrolls: [],
      scrollBy(dx, dy) {
        this.scrolls.push([dx, dy]);
      },
    },
    location: { href: "https://example.com/page" },
    performance: { timeOrigin: 1000 },
    scrollX: 0,
    scrollY: 0,
  });
  realm.globalThis = realm;
  const session = createPageSession(realm);
  const page = {
    realm,
    button,
    nodes,
    docReads: 0,
    worlds: [],
    dropBackend(el) {
      session.dropBackend(el);
    },
    setNodes(next) {
      nodes.splice(0, nodes.length, ...next);
    },
  };
  const box = { env: null };
  const env = boot({
    async sendCommand(info) {
      const { method, params } = info;
      if (method === "Page.getFrameTree") {
        const url = new URL(page.realm.location.href);
        url.hash = "";
        return { frameTree: { frame: { id: "frame-1", url: url.href,
          loaderId: "loader-" + page.realm.performance.timeOrigin } } };
      }
      if (method === "Page.createIsolatedWorld") {
        page.worlds.push(params);
        // A new debugger session gets a new isolated world. The previous
        // private mapping does not come with it. preserveWorld keeps the
        // holder so a test can require the extension binding anyway.
        if (!extra.preserveWorld) {
          vm.runInContext(
            "globalThis.__junoHold = undefined; delete globalThis.__junoHold;",
            page.realm,
          );
        }
        return { executionContextId: 4 };
      }
      if (method === "Runtime.evaluate" && params && params.expression === "location.href") {
        return undefined;
      }
      if (method === "Runtime.evaluate" && params && String(params.expression).includes("let hold = globalThis.__junoHold")) {
        page.docReads += 1;
        if (extra.flipOnDocRead && page.docReads === extra.flipOnDocRead) {
          page.realm.performance.timeOrigin += 5000;
        }
      }
      const handled = session.handle(method, params);
      if (handled !== undefined) return handled;
      if (extra.onCommand) {
        const custom = await extra.onCommand(info, page, box);
        if (custom !== undefined) return custom;
      }
      return undefined;
    },
  });
  box.env = env;
  env.addTab(7, "https://example.com/page");
  env.page = page;
  return env;
}

function methodCalls(env, method) {
  return env.debuggerCalls.filter((call) => call.method === method);
}

function runWorkflow(env, steps, snapshot) {
  const params = { tabId: 7, steps };
  if (snapshot) params.snapshot = snapshot;
  const cmd = command({
    action: "workflow",
    issued_at: env.now(),
    params,
  });
  return env.juno.schedule(cmd, env.now()).then(() => cmd);
}

async function takeSnapshot(env) {
  const cmd = command({
    action: "snapshot",
    issued_at: env.now(),
    params: { tabId: 7 },
  });
  await env.juno.schedule(cmd, env.now());
  const body = resultFor(env, cmd.id);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.match(body.data.snapshot, /^snap_[0-9a-f]{32}$/);
  return body.data.snapshot;
}

describe("extension", { concurrency: 1 }, () => {
  test("pause during a click cancels the press and release", async () => {
    const env = boot({
      async sendCommand({ method, params, chrome }) {
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
          await chrome.storage.local.set({ enabled: false });
          return {};
        }
      },
    });
    env.addTab(7, "https://example.com/page");
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: { tabId: 7, x: 12, y: 34 },
    });
    await env.juno.schedule(cmd, env.now());
    const mice = env.debuggerCalls
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => call.params.type);
    assert.deepEqual(mice, ["mouseMoved"]);
    assert.ok(env.debuggerCalls.some((call) => call.method === "detach"));
    assert.equal(env.queryCalls.length, 0);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /cancelled: extension paused/);
    assert.equal(body.data.status, "uncertain");
    assert.equal(body.data.dispatched, true);
    assert.equal(env.cursor(), cmd.seq);
  });

  test("pause drops queued work and resume does not continue it", async () => {
    const env = boot();
    let calls = 0;
    env.juno.HANDLERS.ping = () => {
      calls += 1;
      return { version: "1.3.0" };
    };
    const t = env.now();
    const queued = command({ issued_at: t });
    const pending = env.juno.schedule(queued, t);
    await env.chrome.storage.local.set({ enabled: false });
    await pending;
    assert.equal(calls, 0);
    assert.equal(env.cursor(), 0);
    assert.equal(resultFor(env, queued.id), undefined);

    await env.chrome.storage.local.set({ enabled: true });
    await env.juno.drain();
    assert.equal(calls, 0);
    assert.equal(resultFor(env, queued.id), undefined);

    env.setClock(t + 180_000);
    const stale = command({ issued_at: t });
    await env.juno.schedule(stale, t + 180_000);
    assert.equal(calls, 0);
    assert.match(resultFor(env, stale.id).error, /180s old at execution/);

    const freshAt = env.now();
    const fresh = command({ issued_at: freshAt });
    await env.juno.schedule(fresh, freshAt);
    assert.equal(calls, 1);
    assert.equal(resultFor(env, fresh.id).ok, true);
  });

  test("changing the device token drops a queued command", async () => {
    const env = boot();
    let calls = 0;
    env.juno.HANDLERS.ping = () => {
      calls += 1;
      return { version: "1.3.0" };
    };
    const t = env.now();
    const cmd = command({ issued_at: t });
    const pending = env.juno.schedule(cmd, t);
    await env.chrome.storage.local.set({ deviceToken: "cd".repeat(32) });
    await pending;
    assert.equal(calls, 0);
    assert.equal(env.cursor(), 0);
    assert.equal(resultFor(env, cmd.id), undefined);
  });

  test("existing-tab commands require tabId and do not query the active tab", async () => {
    const env = boot();
    const state = env.state();
    const epoch = env.juno.epoch();
    for (const action of ["click", "screenshot", "snapshot", "text", "type", "key", "scroll", "close"]) {
      await assert.rejects(
        () => env.juno.HANDLERS[action]({}, state, { target: "" }, epoch),
        /tabId required/,
      );
    }
    assert.equal(env.queryCalls.length, 0);
  });

  test("navigate without tabId opens a background tab", async () => {
    const env = boot();
    const result = await env.juno.HANDLERS.navigate(
      { url: "https://example.com/start" },
      env.state(),
      { target: "" },
      env.juno.epoch(),
    );
    assert.equal(env.queryCalls.length, 0);
    assert.equal(env.created.length, 1);
    assert.equal(env.created[0].active, false);
    assert.equal(env.created[0].url, "https://example.com/start");
    assert.equal(result.redirectedOffAllowlist, false);
    assert.equal(result.url, "https://example.com/start");
  });

  test("screenshot aborts when the document url changes before capture", async () => {
    let hrefs = 0;
    const env = boot({
      sendCommand({ method, params }) {
        if (method === "Runtime.evaluate" && params.expression === "location.href") {
          hrefs += 1;
          const value = hrefs >= 2 ? "https://example.com/other-page" : "https://example.com/page";
          return { result: { value } };
        }
      },
    });
    env.addTab(7, "https://example.com/page");
    const cmd = command({
      action: "screenshot",
      issued_at: env.now(),
      params: { tabId: 7 },
    });
    await env.juno.schedule(cmd, env.now());
    assert.ok(env.debuggerCalls.some((call) => call.method === "attach"));
    assert.equal(env.debuggerCalls.some((call) => call.method === "Page.captureScreenshot"), false);
    const body = resultFor(env, cmd.id);
    assert.match(body.error, /screenshot: tab navigated away from the authorized page/);
    assert.equal(body.error.includes("other-page"), false);
  });

  test("screenshot aborts when the tab leaves the allowlist before capture", async () => {
    const env = boot({
      tabsGet(_id, n, tab) {
        if (n >= 3) return { ...tab, url: "https://evil.example/secret-path" };
        return null;
      },
    });
    env.addTab(7, "https://example.com/page");
    const cmd = command({
      action: "screenshot",
      issued_at: env.now(),
      params: { tabId: 7 },
    });
    await env.juno.schedule(cmd, env.now());
    assert.equal(env.debuggerCalls.some((call) => call.method === "Page.captureScreenshot"), false);
    const body = resultFor(env, cmd.id);
    assert.match(body.error, /screenshot: tab navigated away from the authorized page/);
    assert.equal(body.error.includes("evil.example"), false);
    assert.equal(body.error.includes("secret-path"), false);
  });

  test("time waiting behind another command counts toward the two-minute limit", async () => {
    const env = boot();
    let calls = 0;
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    env.juno.HANDLERS.ping = () => {
      calls += 1;
      return calls === 1 ? gate : { version: "1.3.0" };
    };
    let first = Promise.resolve();
    let second = Promise.resolve();
    try {
      const t = env.now();
      const firstCmd = command({ issued_at: t });
      const secondCmd = command({ issued_at: t });
      first = env.juno.schedule(firstCmd, t);
      for (let i = 0; i < 20 && calls === 0; i++) await tick();
      assert.equal(calls, 1);
      second = env.juno.schedule(secondCmd, t);
      env.setClock(t + 180_000);
      release({ version: "1.3.0" });
      await first;
      await second;
      assert.equal(calls, 1);
      assert.equal(resultFor(env, firstCmd.id).ok, true);
      assert.match(resultFor(env, secondCmd.id).error, /180s old at execution, not run/);
    } finally {
      release({ version: "1.3.0" });
      await Promise.allSettled([first, second]);
    }
  });

  test("freshness adds relay age and local wait, and refuses unusable timestamps", async () => {
    const env = boot();
    let calls = 0;
    env.juno.HANDLERS.ping = () => {
      calls += 1;
      return { version: "1.3.0" };
    };
    const now = env.now();
    const both = command({ issued_at: now - 90_000 });
    await env.juno.takeAndRun(both, now, now - 40_000, env.juno.epoch());
    assert.equal(calls, 0);
    assert.match(resultFor(env, both.id).error, /130s old at execution/);

    const relayOnly = command({ issued_at: now - 90_000 });
    await env.juno.takeAndRun(relayOnly, now, now, env.juno.epoch());
    const localOnly = command({ issued_at: now });
    await env.juno.takeAndRun(localOnly, now, now - 40_000, env.juno.epoch());
    const almost = command({ issued_at: now });
    await env.juno.takeAndRun(almost, now, now - 119_000, env.juno.epoch());
    const edge = command({ issued_at: now });
    await env.juno.takeAndRun(edge, now, now - 120_000, env.juno.epoch());
    assert.equal(calls, 4);

    const over = command({ issued_at: now });
    await env.juno.takeAndRun(over, now, now - 121_000, env.juno.epoch());
    assert.equal(calls, 4);
    assert.match(resultFor(env, over.id).error, /121s old at execution/);

    assert.equal(env.juno.commandAgeMs({}, now, now, now), null);
    assert.equal(env.juno.commandAgeMs({ issued_at: now }, "later", now, now), null);
    assert.equal(env.juno.commandAgeMs({ issued_at: now + 6_000 }, now, now, now), null);
    assert.equal(env.juno.commandAgeMs({ issued_at: now }, now, now + 2_000, now), null);
    const broken = command();
    delete broken.issued_at;
    await env.juno.takeAndRun(broken, now, now, env.juno.epoch());
    assert.equal(calls, 4);
    assert.equal(resultFor(env, broken.id).error, "expired: unusable command timestamp, not run");
  });

  test("snapshot redaction is a heuristic and leaves unmarked fields", async () => {
    const href = "https://example.com/page";
    const elements = [
      element({ attrs: { type: "password", name: "password" }, value: "pw-SECRET-alpha" }),
      element({ attrs: { name: "otp" }, value: "otp-SECRET-beta" }),
      element({ attrs: { autocomplete: "cc-number", name: "card" }, value: "cc-SECRET-gamma" }),
      element({ attrs: { name: "field7" }, value: "otp-SECRET-delta", label: "One-time code" }),
      element({ attrs: { type: "hidden", name: "tok" }, value: "hidden-SECRET-eta" }),
      element({ attrs: { autocomplete: "one-time-code", name: "otc" }, value: "otc-SECRET-theta" }),
      element({ attrs: { name: "q", placeholder: "Password" }, value: "pw-SECRET-iota" }),
      element({ attrs: { name: "notes" }, value: "notes-VISIBLE-epsilon" }),
      element({ attrs: { name: "code" }, value: "code-VISIBLE-zeta" }),
      element({ tag: "button", text: "Save draft" }),
    ];
    const realm = vm.createContext({
      document: {
        title: "Example",
        body: { innerText: "" },
        querySelectorAll() {
          return elements;
        },
      },
      window: { innerWidth: 1280, innerHeight: 800 },
      location: { href },
      performance: { timeOrigin: 1000 },
      scrollX: 0,
      scrollY: 0,
    });
    realm.globalThis = realm;
    const session = createPageSession(realm);
    const env = boot({
      sendCommand({ method, params }) {
        if (method === "Runtime.evaluate" && params && params.expression === "location.href") return undefined;
        return session.handle(method, params);
      },
    });
    env.addTab(7, href);
    const result = await env.juno.HANDLERS.snapshot(
      { tabId: 7 },
      env.state(),
      { target: "" },
      env.juno.epoch(),
    );
    assert.equal(result.redaction, "heuristic");
    const raw = JSON.stringify(result);
    for (const secret of [
      "pw-SECRET-alpha",
      "otp-SECRET-beta",
      "cc-SECRET-gamma",
      "otp-SECRET-delta",
      "hidden-SECRET-eta",
      "otc-SECRET-theta",
      "pw-SECRET-iota",
    ]) {
      assert.equal(raw.includes(secret), false, secret);
    }
    assert.ok(raw.includes("notes-VISIBLE-epsilon"));
    assert.ok(raw.includes("code-VISIBLE-zeta"));
    assert.ok(raw.includes("Save draft"));
    assert.ok(result.elements.some((item) => item.redacted === true));
    const notes = result.elements.find((item) => item.text === "notes-VISIBLE-epsilon");
    assert.ok(notes);
    assert.equal(notes.redacted, undefined);
    assert.deepEqual(
      result.elements.map((item) => item.ref),
      result.elements.map((_, index) => "e" + (index + 1)),
    );
  });

  test("a drifted snapshot is not returned", async () => {
    const env = boot({
      pageEval() {
        return {
          url: "https://example.com/elsewhere",
          title: "x",
          elements: [{ text: "LEAKED-SNAPSHOT-VALUE" }],
        };
      },
    });
    env.addTab(7, "https://example.com/page");
    await assert.rejects(
      () => env.juno.HANDLERS.snapshot({ tabId: 7 }, env.state(), { target: "" }, env.juno.epoch()),
      (err) => {
        assert.match(err.message, /snapshot: tab navigated away from the authorized page/);
        assert.equal(err.message.includes("LEAKED-SNAPSHOT-VALUE"), false);
        assert.equal(err.message.includes("elsewhere"), false);
        return true;
      },
    );
  });

  test("screenshots and page text are returned without a sensitive-content filter", async () => {
    const href = "https://example.com/page";
    const visible = "swordfish 4242424242424242";
    const env = boot({
      pageEval(expr) {
        return vm.runInNewContext(expr, {
          document: { title: "Example", body: { innerText: visible } },
          location: { href },
        });
      },
    });
    env.addTab(7, href);
    const state = env.state();
    const epoch = env.juno.epoch();
    const text = await env.juno.HANDLERS.text({ tabId: 7 }, state, { target: "" }, epoch);
    assert.equal(text.redaction, "none");
    assert.equal(text.text, visible);
    const shot = await env.juno.HANDLERS.screenshot({ tabId: 7 }, state, { target: "" }, epoch);
    assert.equal(shot.redaction, "none");
    assert.equal(shot.image, "data:image/jpeg;base64,QUJD");
  });

  test("eval is off by default and returns the page value unfiltered when enabled", async () => {
    const env = boot({
      pageEval() {
        return "pw-SECRET-alpha";
      },
    });
    env.addTab(7, "https://example.com/page");
    const state = env.state();
    const epoch = env.juno.epoch();
    await assert.rejects(
      () => env.juno.HANDLERS.eval({ tabId: 7, js: "document.body.innerText" }, state, { target: "" }, epoch),
      /eval: disabled/,
    );
    await env.chrome.storage.local.set({ allowEval: true });
    state.allowEval = true;
    const result = await env.juno.HANDLERS.eval(
      { tabId: 7, js: "document.body.innerText" },
      state,
      { target: "" },
      env.juno.epoch(),
    );
    assert.equal(result.value, "pw-SECRET-alpha");
    assert.equal(result.redaction, undefined);
  });

  test("a socket send waits for a matching receipt, falls back on timeout, and treats rejection as final", async () => {
    const env = boot();
    env.juno.setResultAckMs(40);
    const id = command().id;
    const ws = {
      readyState: 1,
      sent: [],
      send(data) {
        this.sent.push(String(data));
        const msg = JSON.parse(data);
        env.juno.handleSocketMessage({ type: "result_ack", id: msg.id });
      },
      close() {},
    };
    env.juno.attachSocket(ws, env.store.deviceToken);
    await env.juno.sendResult(env.store.deviceToken, id, { ok: true, data: { n: 1 } });
    assert.equal(env.fetches.some((item) => item.url.endsWith("/result")), false);
    assert.equal(ws.sent.length, 1);

    env.juno.setResultAckMs(30);
    const slow = {
      readyState: 1,
      sent: [],
      send(data) {
        this.sent.push(String(data));
      },
      close() {},
    };
    env.juno.attachSocket(slow, env.store.deviceToken);
    const slowId = command().id;
    const pending = env.juno.sendResult(env.store.deviceToken, slowId, { ok: false, error: "nope" });
    await Promise.resolve();
    assert.equal(env.fetches.some((item) => item.url.endsWith("/result")), false);
    await pending;
    const posted = resultFor(env, slowId);
    assert.equal(posted.ok, false);
    assert.equal(posted.error, "nope");
    assert.equal(posted.token, env.store.deviceToken);

    env.juno.setResultAckMs(200);
    const rejecting = {
      readyState: 1,
      sent: [],
      send(data) {
        this.sent.push(String(data));
        const msg = JSON.parse(data);
        queueMicrotask(() => {
          env.juno.handleSocketMessage({ type: "result_rejected", id: msg.id, error: "not_command_owner" });
        });
      },
      close() {},
    };
    env.juno.attachSocket(rejecting, env.store.deviceToken);
    const before = env.fetches.length;
    assert.equal(await env.juno.sendResult(env.store.deviceToken, command().id, { ok: true, data: { n: 2 } }), false);
    assert.equal(env.fetches.length, before);
  });

  test("HTTP polling delivers a command, posts its result, and a revoked token is refused", async () => {
    const env = boot();
    const now = env.now();
    const cmd = command({ seq: 4, action: "ping", issued_at: now });
    env.fetchControl.fn = (url) => {
      if (url.endsWith("/poll")) {
        return { ok: true, status: 200, json: async () => ({ cmd, now }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const worked = await env.juno.pollOnce();
    assert.equal(worked, true);
    const poll = env.fetches.find((item) => item.url.endsWith("/poll"));
    assert.equal(poll.body.token, env.store.deviceToken);
    assert.equal(poll.body.after, 0);
    assert.equal(env.cursor(), 4);
    assert.equal(resultFor(env, cmd.id).ok, true);

    env.fetches.length = 0;
    env.fetchControl.fn = () => ({ ok: true, status: 204, json: async () => ({}) });
    assert.equal(await env.juno.pollOnce(), false);
    assert.equal(env.fetches[0].body.after, 4);

    env.fetchControl.fn = () => ({ ok: false, status: 403, json: async () => ({ error: "unknown_device" }) });
    await assert.rejects(() => env.juno.pollOnce(), /rejected/);
    assert.equal(env.store.relayStatus.state, "rejected");
  });

  test("reconnection runs only commands past the cursor", async () => {
    const env = boot();
    env.juno.setResultAckMs(1000);
    env.store.cursor = 5;
    let calls = 0;
    env.juno.HANDLERS.ping = () => {
      calls += 1;
      return { version: "1.3.0" };
    };
    const before = MockWebSocket.latest;
    const pending = env.juno.runSocket(env.store.deviceToken, 5);
    await until(() => MockWebSocket.latest !== before);
    const ws = MockWebSocket.latest;
    assert.notEqual(ws, before);
    try {
      await tick();
      assert.match(ws.url, /\/ws$/);
      const hello = JSON.parse(ws.sent[0]);
      assert.equal(hello.type, "hello");
      assert.equal(hello.after, 5);
      assert.equal(hello.token, undefined);
      assert.equal(ws.protocols[0], "juno-bridge-v1");
      assert.equal(ws.protocols[1], "juno-ticket." + "cd".repeat(32));
      assert.equal(hello.version, "1.3.0");
      const now = env.now();
      const old = command({ seq: 5, issued_at: now });
      const newer = command({ seq: 6, issued_at: now });
      ws.onmessage({ data: JSON.stringify({ type: "welcome", now }) });
      ws.onmessage({ data: JSON.stringify({ type: "cmd", cmd: old, now }) });
      ws.onmessage({ data: JSON.stringify({ type: "cmd", cmd: newer, now }) });
      await env.juno.drain();
      assert.equal(calls, 1);
      assert.equal(env.cursor(), 6);
      const sent = ws.sent.map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      });
      const results = sent.filter((msg) => msg && msg.type === "result");
      assert.equal(results.length, 1);
      assert.equal(results[0].id, newer.id);
      assert.equal(results[0].ok, true);
      // The open socket acknowledged the result, so it was not posted over HTTP.
      assert.equal(resultFor(env, old.id), undefined);
      assert.equal(resultFor(env, newer.id), undefined);
    } finally {
      ws.close();
      await pending;
    }
  });

  test("a WebSocket that cannot be constructed does not open a session", async () => {
    const env = boot();
    const before = MockWebSocket.latest;
    env.sandbox.WebSocket = class {
      constructor() {
        throw new Error("blocked");
      }
    };
    const outcome = await env.juno.runSocket(env.store.deviceToken, 0);
    assert.equal(outcome.opened, false);
    assert.equal(outcome.welcomed, false);
    assert.equal(outcome.rejected, false);
    assert.equal(MockWebSocket.latest, before);
  });

  test("reused-tab navigate does not run after pause", async () => {
    let release = null;
    const env = boot({
      tabsGet(_id, n, tab) {
        if (n !== 2) return null;
        return new Promise((resolve) => {
          release = () => resolve({ ...tab });
        });
      },
    });
    const updates = [];
    const origUpdate = env.chrome.tabs.update.bind(env.chrome.tabs);
    env.chrome.tabs.update = (id, props) => {
      updates.push({ id, props });
      return origUpdate(id, props);
    };
    env.addTab(7, "https://example.com/page");
    const t = env.now();
    const cmd = command({
      action: "navigate",
      issued_at: t,
      params: { tabId: 7, url: "https://example.com/next" },
    });
    const pending = env.juno.schedule(cmd, t);
    try {
      await until(() => release !== null);
      await env.chrome.storage.local.set({ enabled: false });
      assert.equal(env.store.enabled, false);
      release();
      release = null;
      await pending;
      assert.deepEqual(updates, []);
      assert.equal(env.tabs.get(7).url, "https://example.com/page");
      const body = resultFor(env, cmd.id);
      assert.equal(body.ok, false);
      assert.match(body.error, /cancelled: extension paused/);
    } finally {
      if (release) release();
      await pending;
    }
  });

  test("a timed-out command does not act when its tab lookup resolves", async () => {
    let release = null;
    const env = boot({
      tabsGet(_id, n, tab) {
        if (n !== 1) return null;
        return new Promise((resolve) => {
          release = () => resolve({ ...tab });
        });
      },
    });
    const timers = captureCommandTimeout(env);
    env.addTab(7, "https://example.com/page");
    const t = env.now();
    const first = command({
      action: "click",
      issued_at: t,
      params: { tabId: 7, x: 1, y: 2 },
    });
    const pending = env.juno.schedule(first, t);
    try {
      await until(() => release !== null);
      timers.fire();
      await pending;
      const failed = resultFor(env, first.id);
      assert.equal(failed.ok, false);
      assert.match(failed.error, /command timed out after 30s/);
      assert.equal(failed.data.status, "cancelled");
      assert.equal(failed.data.dispatched, false);
      assert.deepEqual(mouseTypes(env), []);
      assert.equal(env.debuggerCalls.some((call) => call.method === "attach"), false);

      const later = command({
        action: "click",
        issued_at: env.now(),
        params: { tabId: 7, x: 3, y: 4 },
      });
      await env.juno.schedule(later, env.now());
      assert.equal(resultFor(env, later.id).ok, true);
      assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);

      const resume = release;
      release = null;
      resume();
      await tick();
      await tick();
      assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);
      assert.equal(resultFor(env, first.id).ok, false);
    } finally {
      if (release) release();
      await pending;
    }
  });

  test("a timed-out command does not act when debugger attach resolves", async () => {
    const env = boot();
    const timers = captureCommandTimeout(env);
    let release = null;
    let holdAttach = true;
    env.chrome.debugger.attach = (target, version) => {
      env.debuggerCalls.push({ method: "attach", params: target, version });
      if (holdAttach) {
        holdAttach = false;
        return new Promise((resolve) => {
          release = () => resolve();
        });
      }
      return Promise.resolve();
    };
    env.addTab(7, "https://example.com/page");
    const t = env.now();
    const first = command({
      action: "click",
      issued_at: t,
      params: { tabId: 7, x: 1, y: 2 },
    });
    const pending = env.juno.schedule(first, t);
    try {
      await until(() => release !== null);
      timers.fire();
      await pending;
      const failed = resultFor(env, first.id);
      assert.equal(failed.ok, false);
      assert.match(failed.error, /command timed out after 30s/);
      assert.equal(failed.data.status, "cancelled");
      assert.equal(failed.data.dispatched, false);
      assert.deepEqual(mouseTypes(env), []);

      const later = command({
        action: "click",
        issued_at: env.now(),
        params: { tabId: 7, x: 8, y: 9 },
      });
      await env.juno.schedule(later, env.now());
      assert.equal(resultFor(env, later.id).ok, true);
      assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);

      const resume = release;
      release = null;
      resume();
      await tick();
      await tick();
      assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);
      assert.equal(resultFor(env, first.id).ok, false);
    } finally {
      if (release) release();
      await pending;
    }
  });

  test("a click without after still returns only the point", async () => {
    const env = boot();
    env.addTab(7, "https://example.com/page");
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: { tabId: 7, x: 4, y: 5 },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data, { tabId: 7, x: 4, y: 5 });
    assert.equal(methodCalls(env, "attach").length, 1);
    assert.equal(methodCalls(env, "detach").length, 1);
  });

  test("an allowlisted failure carries no outcome data", async () => {
    const env = boot();
    env.addTab(7, "https://not-allowed.example/");
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: { tabId: 7, x: 1, y: 2 },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /not in allowlist/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, 0);
  });

  test("one click and its snapshot share one attachment", async () => {
    const env = bootPage();
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 4,
        y: 5,
        after: { observe: "snapshot", ready: { type: "text", text: "Results", timeoutMs: 0 } },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.x, 4);
    assert.equal(body.data.y, 5);
    assert.equal(body.data.dispatched, true);
    assert.equal(body.data.observed, true);
    assert.equal(body.data.observation.observe, "snapshot");
    assert.equal(body.data.observation.redaction, "heuristic");
    assert.equal(body.data.observation.url, "https://example.com/page");
    assert.equal(body.data.observation.elements[0].ref, "e1");
    assert.equal(body.data.observation.elements[0].text, "Filter");
    assert.equal(methodCalls(env, "attach").length, 1);
    assert.equal(methodCalls(env, "detach").length, 1);
    assert.equal(env.fetches.filter((item) => item.url.endsWith("/result")).length, 1);
  });

  test("a missed readiness condition is unobserved after the click was sent", async () => {
    const env = bootPage();
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 4,
        y: 5,
        after: { observe: "snapshot", ready: { type: "text", text: "NOT-HERE", timeoutMs: 0 } },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /observation was not ready/);
    assert.equal(body.data.status, "unobserved");
    assert.equal(body.data.dispatched, true);
    assert.equal(body.data.observed, false);
    assert.equal(methodCalls(env, "attach").length, 1);
    assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  test("an unsupported readiness condition attaches nothing", async () => {
    const env = boot();
    env.addTab(7, "https://example.com/page");
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 1,
        y: 2,
        after: { observe: "snapshot", ready: { type: "javascript" } },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /ready: unsupported/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, 0);
    assert.deepEqual(mouseTypes(env), []);
  });

  test("navigation after a click does not return the destination", async () => {
    const env = bootPage({
      async onCommand({ method, params, tabs, target }) {
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
          tabs.get(target.tabId).url = "https://evil.example/secret-destination";
        }
      },
    });
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 4,
        y: 5,
        after: { observe: "snapshot" },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /navigated away from the authorized page/);
    assert.equal(body.error.includes("secret-destination"), false);
    assert.equal(body.error.includes("evil.example"), false);
    assert.equal(JSON.stringify(body).includes("secret-destination"), false);
    assert.equal(body.data.status, "uncertain");
    assert.equal(body.data.dispatched, true);
    assert.equal(body.data.observation, undefined);
    assert.equal(methodCalls(env, "attach").length, 1);
  });

  test("a three-step workflow uses one attachment", async () => {
    const env = bootPage();
    const snapshot = await takeSnapshot(env);
    const before = debuggerUse(env);
    const cmd = await runWorkflow(env, [
      { op: "click", ref: "e1", expect: { tag: "button", text: "Filter" } },
      { op: "type", text: "invoices" },
      { op: "key", key: "Enter" },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.status, "completed");
    assert.equal(body.data.dispatched, true);
    assert.deepEqual(body.data.steps.map((step) => step.status), ["completed", "completed", "completed"]);
    assert.equal(body.data.steps[0].result.x, 50);
    assert.equal(body.data.steps[0].result.y, 30);
    assert.equal(body.data.before.redaction, "heuristic");
    assert.equal(body.data.before.elements[0].ref, "e1");
    assert.equal(body.data.before.elements[0].text, "Filter");
    assert.equal(env.page.worlds.length, before.attach + 1);
    assert.equal(env.page.worlds[0].worldName, "juno-bridge");
    assert.equal(env.page.worlds[0].frameId, "frame-1");
    assert.equal(env.page.worlds[0].grantUniveralAccess, true);
    assert.equal(env.page.worlds[1].worldName, "juno-bridge");
    assert.equal(env.page.worlds[1].frameId, "frame-1");
    assert.equal(env.page.worlds[1].grantUniveralAccess, true);
    assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);
    const typed = methodCalls(env, "Input.insertText");
    assert.equal(typed.length, 1);
    assert.equal(typed[0].params.text, "invoices");
    assert.equal(methodCalls(env, "Input.dispatchKeyEvent").length, 2);
    assert.equal(methodCalls(env, "attach").length, before.attach + 1);
    assert.equal(methodCalls(env, "detach").length, before.detach + 1);
    assert.equal(env.fetches.filter((item) => item.url.endsWith("/result")).length, before.results + 1);
  });

  test("a workflow stops on the first mismatched step", async () => {
    const env = bootPage();
    const snapshot = await takeSnapshot(env);
    const before = debuggerUse(env);
    const cmd = await runWorkflow(env, [
      { op: "click", ref: "e1" },
      { op: "click", ref: "e1", expect: { tag: "a" } },
      { op: "key", key: "Enter" },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /did not match/);
    assert.equal(body.error.includes("http"), false);
    assert.equal(body.data.status, "failed");
    assert.deepEqual(body.data.steps.map((step) => step.status), ["completed", "failed", "unstarted"]);
    assert.equal(mouseTypes(env).length, 3);
    assert.equal(methodCalls(env, "Input.dispatchKeyEvent").length, 0);
    assert.equal(methodCalls(env, "attach").length, before.attach + 1);
    assert.equal(methodCalls(env, "detach").length, before.detach + 1);
  });

  test("a disabled element is refused before dispatch", async () => {
    const env = bootPage({ disabled: true });
    const snapshot = await takeSnapshot(env);
    const before = debuggerUse(env);
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /is disabled/);
    assert.equal(body.data.status, "failed");
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "failed");
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(methodCalls(env, "attach").length, before.attach + 1);
    assert.equal(methodCalls(env, "detach").length, before.detach + 1);
  });

  test("an enabled element can be observed inside the workflow", async () => {
    const env = bootPage();
    const snapshot = await takeSnapshot(env);
    const before = debuggerUse(env);
    const cmd = await runWorkflow(env, [
      { op: "wait", ready: { type: "element_enabled", ref: "e1", timeoutMs: 0 } },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.status, "completed");
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "completed");
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(methodCalls(env, "attach").length, before.attach + 1);
  });

  test("a workflow pauses after input already sent and leaves the rest unstarted", async () => {
    const env = bootPage({
      async onCommand({ method, params, chrome }) {
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
          await chrome.storage.local.set({ enabled: false });
          return {};
        }
      },
    });
    const snapshot = await takeSnapshot(env);
    const cmd = await runWorkflow(env, [
      { op: "click", ref: "e1" },
      { op: "key", key: "Enter" },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /cancelled: extension paused/);
    assert.equal(body.data.status, "uncertain");
    assert.equal(body.data.dispatched, true);
    assert.equal(body.data.steps[0].status, "uncertain");
    assert.equal(body.data.steps[1].status, "unstarted");
    assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed"]);
  });

  test("the user detaching the debugger stops the workflow as uncertain", async () => {
    const env = bootPage({
      onCommand({ method, params, target }, _page, box) {
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
          box.env.fireDetach(target.tabId);
          return {};
        }
      },
    });
    const snapshot = await takeSnapshot(env);
    const cmd = await runWorkflow(env, [
      { op: "click", ref: "e1" },
      { op: "key", key: "Enter" },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /debugger detached/);
    assert.equal(body.data.status, "uncertain");
    assert.equal(body.data.steps[0].status, "uncertain");
    assert.equal(body.data.steps[1].status, "unstarted");
    assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed"]);
  });

  test("a timed-out workflow does not dispatch the rest of the click", async () => {
    let release = null;
    const env = bootPage({
      async onCommand({ method, params }) {
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
          await new Promise((resolve) => {
            release = resolve;
          });
        }
      },
    });
    const snapshot = await takeSnapshot(env);
    const timers = captureCommandTimeout(env);
    const cmd = command({
      action: "workflow",
      issued_at: env.now(),
      params: {
        tabId: 7,
        snapshot,
        steps: [
          { op: "click", ref: "e1" },
          { op: "key", key: "Enter" },
        ],
      },
    });
    const pending = env.juno.schedule(cmd, env.now());
    try {
      await until(() => release !== null);
      timers.fire();
      await pending;
      const body = resultFor(env, cmd.id);
      assert.equal(body.ok, false);
      assert.match(body.error, /command timed out after 30s/);
      assert.equal(body.data.status, "uncertain");
      assert.equal(body.data.dispatched, true);
      assert.equal(body.data.steps[0].status, "running");
      assert.equal(body.data.steps[1].status, "unstarted");
      assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed"]);
      release();
      release = null;
      await tick();
      await tick();
      assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed"]);
      const later = command({ action: "ping", issued_at: env.now() });
      await env.juno.schedule(later, env.now());
      assert.equal(resultFor(env, later.id).ok, true);
      assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed"]);
    } finally {
      if (release) release();
      await pending;
    }
  });

  test("a same-url reload invalidates the remaining steps", async () => {
    const env = bootPage({ flipOnDocRead: 4 });
    const snapshot = await takeSnapshot(env);
    const cmd = await runWorkflow(env, [
      { op: "click", ref: "e1" },
      { op: "click", ref: "e1" },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /the document changed/);
    assert.equal(body.error.includes("http"), false);
    assert.equal(body.data.status, "uncertain");
    assert.equal(body.data.steps[0].status, "completed");
    assert.equal(body.data.steps[1].status, "unstarted");
    assert.equal(mouseTypes(env).length, 3);
    assert.equal(env.page.docReads, 4);
  });

  test("a moved element is clicked at its fresh center", async () => {
    const env = bootPage({
      rects: [
        { x: 10, y: 20, width: 80, height: 20 },
        { x: 400, y: 20, width: 80, height: 20 },
      ],
    });
    const snapshot = await takeSnapshot(env);
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.steps[0].result.x, 440);
    assert.equal(body.data.steps[0].result.y, 30);
    const mice = env.debuggerCalls.filter((call) => call.method === "Input.dispatchMouseEvent");
    assert.equal(mice.length, 3);
    for (const call of mice) {
      assert.equal(call.params.x, 440);
      assert.equal(call.params.y, 30);
    }
  });

  test("eleven steps are rejected before the debugger attaches", async () => {
    const env = boot();
    env.addTab(7, "https://example.com/page");
    const steps = Array.from({ length: 11 }, () => ({
      op: "wait",
      ready: { type: "text", text: "Results", timeoutMs: 0 },
    }));
    const cmd = await runWorkflow(env, steps);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /need 1 to 10 steps/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, 0);
  });

  test("a workflow click without a snapshot attaches nothing", async () => {
    const env = bootPage();
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }]);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /snapshot required/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, 0);
    assert.deepEqual(mouseTypes(env), []);
  });

  test("a workflow keeps the selected element after a node is inserted", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    env.page.setNodes([
      labeledButton("Delete account", { x: 10, y: 20, width: 80, height: 20 }),
      invoices,
    ]);
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.before.elements.length, 1);
    assert.equal(body.data.before.elements[0].ref, "e1");
    assert.equal(body.data.before.elements[0].text, "Invoices");
    assert.equal(body.data.steps[0].result.x, 50);
    assert.equal(body.data.steps[0].result.y, 90);
    const mice = env.debuggerCalls.filter((call) => call.method === "Input.dispatchMouseEvent");
    assert.equal(mice.length, 3);
    for (const call of mice) {
      assert.equal(call.params.x, 50);
      assert.equal(call.params.y, 90);
    }
    assert.equal(JSON.stringify(body).includes("Delete account"), false);
  });

  test("consecutive workflows on one snapshot do not retarget", async () => {
    const invoices = labeledButton("Invoices", { x: 30, y: 40, width: 20, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    env.page.setNodes([
      labeledButton("Delete account", { x: 0, y: 0, width: 10, height: 10 }),
      invoices,
    ]);
    const commands = [
      await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot),
      await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot),
    ];
    for (const cmd of commands) {
      const body = resultFor(env, cmd.id);
      assert.equal(body.ok, true, JSON.stringify(body));
      assert.equal(body.data.before.elements[0].text, "Invoices");
      assert.equal(body.data.steps[0].result.x, 40);
      assert.equal(body.data.steps[0].result.y, 50);
    }
    const mice = env.debuggerCalls.filter((call) => call.method === "Input.dispatchMouseEvent");
    assert.equal(mice.length, 6);
    for (const call of mice) {
      assert.equal(call.params.x, 40);
      assert.equal(call.params.y, 50);
    }
  });

  test("a replaced node is refused instead of clicking the new element", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 20, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    invoices.isConnected = false;
    env.page.setNodes([
      labeledButton("Delete account", { x: 10, y: 20, width: 80, height: 20 }),
    ]);
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /element e1 is gone/);
    assert.equal(body.error.includes("Delete account"), false);
    assert.equal(body.data.status, "failed");
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "failed");
    assert.equal(body.data.before.elements[0].missing, true);
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(JSON.stringify(body).includes("Delete account"), false);
  });

  test("a newer snapshot makes the previous ref stale", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const first = await takeSnapshot(env);
    const remove = labeledButton("Delete account", { x: 10, y: 20, width: 80, height: 20 });
    env.page.setNodes([remove, invoices]);
    const second = await takeSnapshot(env);
    assert.notEqual(first, second);
    const stale = await runWorkflow(env, [{ op: "click", ref: "e1" }], first);
    const staleBody = resultFor(env, stale.id);
    assert.equal(staleBody.ok, false, JSON.stringify(staleBody));
    assert.match(staleBody.error, /snapshot is stale/);
    assert.equal(staleBody.error.includes("http"), false);
    assert.equal(staleBody.data.dispatched, false);
    assert.deepEqual(staleBody.data.steps.map((step) => step.status), ["unstarted"]);
    assert.deepEqual(mouseTypes(env), []);
    const fresh = await runWorkflow(env, [
      { op: "click", ref: "e1", expect: { text: "Delete account" } },
    ], second);
    const freshBody = resultFor(env, fresh.id);
    assert.equal(freshBody.ok, true, JSON.stringify(freshBody));
    assert.equal(freshBody.data.before.elements[0].text, "Delete account");
    assert.equal(freshBody.data.before.elements[1].text, "Invoices");
    assert.equal(freshBody.data.steps[0].result.x, 50);
    assert.equal(freshBody.data.steps[0].result.y, 30);
  });

  test("a restarted worker does not reuse a snapshot id for a new capture", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const first = await takeSnapshot(env);
    assert.equal(env.juno.simulateWorkerRestart(), 0);
    const settings = labeledButton("Settings", { x: 10, y: 20, width: 80, height: 20 });
    env.page.setNodes([settings]);
    const second = await takeSnapshot(env);
    assert.notEqual(first, second);
    const stale = await runWorkflow(env, [{ op: "click", ref: "e1" }], first);
    const staleBody = resultFor(env, stale.id);
    assert.equal(staleBody.ok, false, JSON.stringify(staleBody));
    assert.match(staleBody.error, /snapshot is stale/);
    assert.equal(staleBody.error.includes("http"), false);
    assert.equal(staleBody.data.status, "failed");
    assert.equal(staleBody.data.dispatched, false);
    assert.deepEqual(staleBody.data.steps.map((step) => step.status), ["unstarted"]);
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(JSON.stringify(staleBody).includes("Settings"), false);
    const fresh = await runWorkflow(env, [{ op: "click", ref: "e1" }], second);
    const freshBody = resultFor(env, fresh.id);
    assert.equal(freshBody.ok, true, JSON.stringify(freshBody));
    assert.equal(freshBody.data.before.elements[0].text, "Settings");
    assert.equal(freshBody.data.steps[0].result.x, 50);
    assert.equal(freshBody.data.steps[0].result.y, 30);
    const mice = env.debuggerCalls.filter((call) => call.method === "Input.dispatchMouseEvent");
    assert.equal(mice.length, 3);
    for (const call of mice) {
      assert.equal(call.params.x, 50);
      assert.equal(call.params.y, 30);
    }
  });

  test("a same-url reload before a workflow refuses the snapshot", async () => {
    const env = bootPage();
    const snapshot = await takeSnapshot(env);
    env.page.realm.performance.timeOrigin += 5000;
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /snapshot is stale/);
    assert.equal(body.error.includes("http"), false);
    assert.equal(body.data.status, "failed");
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "unstarted");
    assert.deepEqual(mouseTypes(env), []);
  });

  test("a cleared page world still resolves the captured element", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    const decoy = labeledButton("Delete account", { x: 10, y: 20, width: 80, height: 20 });
    copyCaptureMarks(decoy, snapshot);
    dropHold(env);
    env.page.setNodes([decoy, invoices]);
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.before.elements[0].text, "Invoices");
    assert.equal(body.data.steps[0].result.x, 50);
    assert.equal(body.data.steps[0].result.y, 90);
    const mice = env.debuggerCalls.filter((call) => call.method === "Input.dispatchMouseEvent");
    assert.equal(mice.length, 3);
    for (const call of mice) {
      assert.equal(call.params.y, 90);
    }
    assert.equal(JSON.stringify(body).includes("Delete account"), false);
  });

  test("a cloned node that copies the capture marks is refused after reconnect", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    const settings = labeledButton("Settings", { x: 10, y: 20, width: 80, height: 20 });
    copyCaptureMarks(settings, snapshot);
    invoices.isConnected = false;
    env.page.setNodes([settings]);
    dropHold(env);
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /element e1 is gone/);
    assert.equal(body.error.includes("Settings"), false);
    assert.equal(body.data.status, "failed");
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "failed");
    assert.equal(body.data.before.elements[0].missing, true);
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(JSON.stringify(body).includes("Settings"), false);
  });

  test("a replacement with the same tag and label is refused after reconnect", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    const clone = labeledButton("Invoices", { x: 10, y: 20, width: 80, height: 20 });
    copyCaptureMarks(clone, snapshot);
    invoices.isConnected = false;
    env.page.setNodes([clone]);
    dropHold(env);
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /element e1 is gone/);
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "failed");
    assert.equal(body.data.before.elements[0].missing, true);
    assert.deepEqual(mouseTypes(env), []);
  });

  test("a lost extension capture is not rebuilt from page marks", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    const settings = labeledButton("Settings", { x: 10, y: 20, width: 80, height: 20 });
    copyCaptureMarks(settings, snapshot);
    invoices.isConnected = false;
    env.page.setNodes([settings]);
    dropHold(env);
    env.juno.forgetSnapshots();
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /snapshot is stale/);
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "unstarted");
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(JSON.stringify(body).includes("Settings"), false);
  });

  test("a page holder is refused when the extension binding is gone", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ preserveWorld: true, button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    env.juno.forgetSnapshots();
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /snapshot is stale/);
    assert.equal(body.error.includes("http"), false);
    assert.equal(body.data.status, "failed");
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "unstarted");
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(JSON.stringify(body).includes("Invoices"), false);
    const held = vm.runInContext(
      "globalThis.__junoHold ? globalThis.__junoHold.snapshot : null",
      env.page.realm,
    );
    assert.equal(held, snapshot);
  });

  test("a node id the browser cannot resolve is refused", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    const settings = labeledButton("Settings", { x: 10, y: 20, width: 80, height: 20 });
    copyCaptureMarks(settings, snapshot);
    invoices.isConnected = false;
    env.page.setNodes([settings]);
    env.page.dropBackend(invoices);
    dropHold(env);
    const cmd = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /snapshot is stale/);
    assert.equal(body.data.dispatched, false);
    assert.equal(body.data.steps[0].status, "unstarted");
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(JSON.stringify(body).includes("Settings"), false);
  });

  test("a snapshot step does not retarget the authorized ref", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    env.page.setNodes([
      labeledButton("Delete account", { x: 10, y: 20, width: 80, height: 20 }),
      invoices,
    ]);
    const cmd = await runWorkflow(env, [
      { op: "snapshot" },
      { op: "click", ref: "e1" },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.before.elements[0].text, "Invoices");
    assert.equal(body.data.observation.elements[0].text, "Delete account");
    assert.equal(body.data.steps[1].result.x, 50);
    assert.equal(body.data.steps[1].result.y, 90);
    const mice = env.debuggerCalls.filter((call) => call.method === "Input.dispatchMouseEvent");
    assert.equal(mice.length, 3);
    for (const call of mice) {
      assert.equal(call.params.y, 90);
    }
  });

  test("a workflow does not replace its snapshot until the steps that use it are done", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    env.page.setNodes([
      labeledButton("Download", { x: 10, y: 20, width: 80, height: 20 }),
      invoices,
    ]);
    const cmd = await runWorkflow(env, [
      { op: "click", ref: "e1", after: { observe: "snapshot" } },
      { op: "click", ref: "e1", expect: { text: "Invoices" } },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.steps[0].result.y, 90);
    assert.equal(body.data.steps[1].result.y, 90);
    const next = body.data.observation;
    assert.match(next.snapshot, /^snap_[0-9a-f]{32}$/);
    assert.notEqual(next.snapshot, snapshot);
    assert.equal(next.url, "https://example.com/page");
    assert.equal(next.elements[0].text, "Download");
    assert.equal(next.elements[0].snapshot, undefined);
    assert.equal(next.redaction, "heuristic");
    dropHold(env);
    const stale = await runWorkflow(env, [{ op: "click", ref: "e1" }], snapshot);
    const staleBody = resultFor(env, stale.id);
    assert.equal(staleBody.ok, false, JSON.stringify(staleBody));
    assert.match(staleBody.error, /snapshot is stale/);
    assert.equal(staleBody.data.dispatched, false);
    assert.deepEqual(staleBody.data.steps.map((step) => step.status), ["unstarted"]);
  });

  test("the observation after a click is a new snapshot the next action can use", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({
      button: invoices,
      nodes: [invoices],
      async onCommand(info, page) {
        if (info.method === "Input.dispatchMouseEvent" && info.params && info.params.type === "mouseReleased") {
          page.setNodes([
            page.button,
            labeledButton("Download", { x: 10, y: 40, width: 80, height: 20 }),
          ]);
        }
      },
    });
    const first = await takeSnapshot(env);
    const cmd = await runWorkflow(env, [
      { op: "click", ref: "e1", expect: { text: "Invoices" }, after: { observe: "snapshot" } },
    ], first);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    const next = body.data.observation;
    assert.match(next.snapshot, /^snap_[0-9a-f]{32}$/);
    assert.notEqual(next.snapshot, first);
    assert.equal(next.url, "https://example.com/page");
    assert.equal(next.redaction, "heuristic");
    const download = next.elements.find((el) => el.text === "Download");
    assert.ok(download, JSON.stringify(next.elements));
    assert.equal(download.snapshot, undefined);
    assert.notEqual(download.ref, undefined);
    for (const el of next.elements) assert.equal(el.snapshot, undefined);

    const described = methodCalls(env, "DOM.describeNode").length;
    dropHold(env);
    const stale = await runWorkflow(env, [{ op: "click", ref: "e1" }], first);
    const staleBody = resultFor(env, stale.id);
    assert.equal(staleBody.ok, false, JSON.stringify(staleBody));
    assert.match(staleBody.error, /snapshot is stale/);
    assert.equal(staleBody.data.dispatched, false);
    assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);

    dropHold(env);
    const missing = await runWorkflow(env, [{ op: "click", ref: "e9" }], next.snapshot);
    const missingBody = resultFor(env, missing.id);
    assert.equal(missingBody.ok, false, JSON.stringify(missingBody));
    assert.match(missingBody.error, /element e9 is gone/);
    assert.equal(missingBody.data.dispatched, false);
    assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);

    dropHold(env);
    const again = await runWorkflow(env, [
      { op: "click", ref: download.ref, expect: { text: "Download" } },
    ], next.snapshot);
    const againBody = resultFor(env, again.id);
    assert.equal(againBody.ok, true, JSON.stringify(againBody));
    assert.equal(againBody.data.before.snapshot, next.snapshot);
    assert.equal(againBody.data.steps[0].result.x, 50);
    assert.equal(againBody.data.steps[0].result.y, 50);
    assert.equal(methodCalls(env, "DOM.describeNode").length, described);

    env.page.realm.performance.timeOrigin += 5000;
    const reloaded = await runWorkflow(env, [{ op: "click", ref: download.ref }], next.snapshot);
    const reloadedBody = resultFor(env, reloaded.id);
    assert.equal(reloadedBody.ok, false, JSON.stringify(reloadedBody));
    assert.match(reloadedBody.error, /snapshot is stale/);
    assert.equal(reloadedBody.error.includes("http"), false);
    assert.equal(reloadedBody.data.dispatched, false);
    assert.deepEqual(reloadedBody.data.steps.map((step) => step.status), ["unstarted"]);
  });

  test("element readiness uses the snapshot taken before the click", async () => {
    const env = bootPage();
    const snapshot = await takeSnapshot(env);
    for (const type of ["element_visible", "element_enabled"]) {
      const cmd = command({
        action: "click",
        issued_at: env.now(),
        params: {
          tabId: 7,
          x: 4,
          y: 5,
          after: {
            observe: "text",
            ready: { type, ref: "e1", snapshot, timeoutMs: 0 },
          },
        },
      });
      await env.juno.schedule(cmd, env.now());
      const body = resultFor(env, cmd.id);
      assert.equal(body.ok, true, type + " " + JSON.stringify(body));
      assert.equal(body.data.dispatched, true);
      assert.equal(body.data.observed, true);
      assert.equal(body.data.observation.observe, "text");
      assert.equal(body.data.observation.text.includes("Results"), true);
    }
    assert.equal(mouseTypes(env).length, 6);
  });

  test("type, key, and scroll wait on the stored element before input", async () => {
    const env = bootPage();
    const snapshot = await takeSnapshot(env);
    const typed = command({
      action: "type",
      issued_at: env.now(),
      params: {
        tabId: 7,
        text: "hi",
        after: {
          observe: "text",
          ready: { type: "element_visible", ref: "e1", snapshot, timeoutMs: 0 },
        },
      },
    });
    await env.juno.schedule(typed, env.now());
    assert.equal(resultFor(env, typed.id).ok, true, JSON.stringify(resultFor(env, typed.id)));
    assert.equal(methodCalls(env, "Input.insertText").length, 1);
    const keyed = command({
      action: "key",
      issued_at: env.now(),
      params: {
        tabId: 7,
        key: "Enter",
        after: {
          observe: "text",
          ready: { type: "element_enabled", ref: "e1", snapshot, timeoutMs: 0 },
        },
      },
    });
    await env.juno.schedule(keyed, env.now());
    const body = resultFor(env, keyed.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(methodCalls(env, "Input.dispatchKeyEvent").length, 2);
    const scrolled = command({
      action: "scroll",
      issued_at: env.now(),
      params: {
        tabId: 7,
        dy: 40,
        after: {
          observe: "text",
          ready: { type: "element_visible", ref: "e1", snapshot, timeoutMs: 0 },
        },
      },
    });
    await env.juno.schedule(scrolled, env.now());
    const scrollBody = resultFor(env, scrolled.id);
    assert.equal(scrollBody.ok, true, JSON.stringify(scrollBody));
    assert.deepEqual(env.page.realm.window.scrolls, [[0, 40]]);
  });

  test("element readiness refuses a cloned marker before input", async () => {
    const invoices = labeledButton("Invoices", { x: 10, y: 80, width: 80, height: 20 });
    const env = bootPage({ button: invoices, nodes: [invoices] });
    const snapshot = await takeSnapshot(env);
    const settings = labeledButton("Settings", { x: 10, y: 20, width: 80, height: 20 });
    copyCaptureMarks(settings, snapshot);
    invoices.isConnected = false;
    env.page.setNodes([settings]);
    dropHold(env);
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 50,
        y: 30,
        after: {
          observe: "text",
          ready: { type: "element_enabled", ref: "e1", snapshot, timeoutMs: 0 },
        },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /element e1 is gone/);
    assert.equal(body.data, null);
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(JSON.stringify(body).includes("Settings"), false);
  });

  test("element readiness restores a cleared snapshot before the click", async () => {
    const env = bootPage();
    const snapshot = await takeSnapshot(env);
    dropHold(env);
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 4,
        y: 5,
        after: {
          observe: "text",
          ready: { type: "element_enabled", ref: "e1", snapshot, timeoutMs: 0 },
        },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.data.observed, true);
    assert.deepEqual(mouseTypes(env), ["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  test("element readiness without a snapshot attaches nothing", async () => {
    const env = bootPage();
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 4,
        y: 5,
        after: {
          observe: "snapshot",
          ready: { type: "element_visible", ref: "e1", timeoutMs: 0 },
        },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /ready: snapshot required/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, 0);
    assert.deepEqual(mouseTypes(env), []);
  });

  test("a forged snapshot is refused before the click", async () => {
    const env = bootPage();
    await takeSnapshot(env);
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 4,
        y: 5,
        after: {
          observe: "text",
          ready: { type: "element_visible", ref: "e1", snapshot: "snap_" + "9".repeat(32), timeoutMs: 0 },
        },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /snapshot is stale/);
    assert.equal(body.data, null);
    assert.deepEqual(mouseTypes(env), []);
    assert.equal(methodCalls(env, "attach").length, 2);
  });

  test("an eight-digit snapshot id is refused before attach", async () => {
    const env = bootPage();
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 4,
        y: 5,
        after: {
          observe: "text",
          ready: { type: "element_visible", ref: "e1", snapshot: "snap_00000001", timeoutMs: 0 },
        },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(body.error, /ready: snapshot required/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, 0);
    assert.deepEqual(mouseTypes(env), []);
  });

  test("an out of range timeout is refused before input", async () => {
    const env = bootPage();
    const cmd = command({
      action: "click",
      issued_at: env.now(),
      params: {
        tabId: 7,
        x: 4,
        y: 5,
        after: { observe: "text", ready: { type: "text", text: "Results", timeoutMs: 15001 } },
      },
    });
    await env.juno.schedule(cmd, env.now());
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /timeoutMs must be between 0 and 15000/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, 0);
    assert.deepEqual(mouseTypes(env), []);
  });

  test("a workflow rejects an out of range timeout before attaching", async () => {
    const env = bootPage();
    const snapshot = await takeSnapshot(env);
    const before = debuggerUse(env);
    const cmd = await runWorkflow(env, [
      {
        op: "click",
        ref: "e1",
        after: { observe: "text", ready: { type: "text", text: "Results", timeoutMs: 15001 } },
      },
    ], snapshot);
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /timeoutMs must be between 0 and 15000/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, before.attach);
    assert.deepEqual(mouseTypes(env), []);
  });

  test("a text workflow rejects a malformed snapshot before attaching", async () => {
    const env = boot();
    env.addTab(7, "https://example.com/page");
    const cmd = await runWorkflow(env, [
      { op: "wait", ready: { type: "text", text: "Results", timeoutMs: 0 } },
    ], "not-a-snapshot");
    const body = resultFor(env, cmd.id);
    assert.equal(body.ok, false);
    assert.match(body.error, /snapshot required/);
    assert.equal(body.data, null);
    assert.equal(methodCalls(env, "attach").length, 0);
  });
});


describe("device-scoped cursor regressions", { concurrency: 1 }, () => {
  test("a delayed old-device save cannot overwrite Options pairing or new-device progress", async () => {
    const env = boot();
    const oldToken = env.store.deviceToken;
    const newToken = "ef".repeat(32);
    const oldKey = env.juno.cursorKey(oldToken);
    const newKey = env.juno.cursorKey(newToken);
    await env.juno.getState();
    const writes = [];
    const normalSet = env.chrome.storage.local.set;
    let release;
    env.chrome.storage.local.set = (obj) => {
      writes.push({ ...obj });
      if (obj[oldKey] === 91) return new Promise((resolve) => {
        release = async () => { await normalSet(obj); resolve(); };
      });
      return normalSet(obj);
    };
    let calls = 0;
    env.juno.HANDLERS.ping = () => { calls++; return {}; };
    const old = command({ seq: 91, issued_at: env.now() });
    const pending = env.juno.takeAndRun(old, env.now(), env.now(), env.juno.epoch(), oldToken);
    await until(() => !!release);
    await bootOptions(env, newToken).register();
    assert.ok(writes.some((obj) => obj.deviceToken === newToken && obj[newKey] === 0));
    assert.equal((await env.juno.getState()).cursor, 0);
    await env.juno.schedule(command({ seq: 4, issued_at: env.now() }), env.now(), newToken);
    await env.juno.schedule(command({ seq: 3, issued_at: env.now() }), env.now(), newToken);
    assert.equal(calls, 1);
    await release();
    await pending;
    assert.equal(env.store.deviceToken, newToken);
    assert.equal(env.store[newKey], 4);
    assert.equal(env.store[oldKey], 91);
    assert.equal(env.store.cursor, 0, "active commands never save a shared cursor");
    assert.equal(calls, 1, "the old command is cancelled after its save");
    assert.equal(resultFor(env, old.id).token, oldToken);
    assert.match(resultFor(env, old.id).error, /cancelled/);
    const restarted = boot({ store: structuredClone(env.store) });
    let restartedCalls = 0;
    restarted.juno.HANDLERS.ping = () => { restartedCalls++; return {}; };
    await restarted.juno.schedule(command({ seq: 4, issued_at: restarted.now() }), restarted.now(), newToken);
    assert.equal(restartedCalls, 0);
    await restarted.juno.schedule(command({ seq: 5, issued_at: restarted.now() }), restarted.now(), newToken);
    assert.equal(restartedCalls, 1);
    assert.equal(restarted.store[newKey], 5);
  });

  test("legacy progress migrates before execution and survives a worker restart", async () => {
    const env = boot({ store: { cursor: 7 } });
    const token = env.store.deviceToken;
    const key = env.juno.cursorKey(token);
    let calls = 0;
    env.juno.HANDLERS.ping = () => { calls++; return {}; };
    await env.juno.schedule(command({ seq: 7, issued_at: env.now() }), env.now());
    assert.equal(calls, 0);
    assert.equal(env.store[key], 7);
    assert.equal(env.store.legacyCursorToken, token);
    await env.juno.schedule(command({ seq: 8, issued_at: env.now() }), env.now());
    assert.equal(calls, 1);
    assert.equal(env.store[key], 8);
    assert.equal(env.store.cursor, 7);
    const restarted = boot({ store: structuredClone(env.store) });
    restarted.juno.HANDLERS.ping = () => { calls++; return {}; };
    await restarted.juno.schedule(command({ seq: 8, issued_at: restarted.now() }), restarted.now());
    assert.equal(calls, 1);
    restarted.fetchControl.fn = () => ({ ok: true, status: 204, json: async () => ({}) });
    await restarted.juno.pollOnce();
    assert.equal(restarted.fetches[0].body.after, 8);
  });

  for (const heldOperation of ["scoped read", "migration write"]) {
    test(`concurrent migration waits for a delayed ${heldOperation} before taking a command`, async () => {
      const env = boot({ store: { cursor: 7 } });
      const key = env.juno.cursorKey(env.store.deviceToken);
      const normalGet = env.chrome.storage.local.get;
      const normalSet = env.chrome.storage.local.set;
      let release;
      let migrationWrites = 0;
      env.chrome.storage.local.set = (obj) => {
        if (obj[key] === 7) {
          migrationWrites++;
          if (heldOperation === "migration write") return new Promise((resolve) => {
            release = async () => { await normalSet(obj); resolve(); };
          });
        }
        return normalSet(obj);
      };
      env.chrome.storage.local.get = (defaults) => {
        if (heldOperation === "scoped read" && defaults[key] === null && !release) {
          const snapshot = normalGet(defaults);
          return new Promise((resolve) => { release = async () => resolve(await snapshot); });
        }
        return normalGet(defaults);
      };
      let calls = 0;
      env.juno.HANDLERS.ping = () => { calls++; return {}; };
      const firstRead = env.juno.getState();
      await until(() => !!release);
      const secondRead = env.juno.getState();
      const cmd = command({ seq: 10, issued_at: env.now() });
      const taking = env.juno.schedule(cmd, env.now());
      await tick();
      assert.equal(calls, 0);
      assert.equal(migrationWrites, heldOperation === "migration write" ? 1 : 0);
      await release();
      await Promise.all([firstRead, secondRead, taking]);
      assert.equal(migrationWrites, 1);
      assert.equal(env.store[key], 10);
      assert.equal(env.store.cursor, 7);
      assert.equal(calls, 1);
      await env.juno.schedule(cmd, env.now());
      assert.equal(calls, 1);
      const restarted = boot({ store: structuredClone(env.store) });
      restarted.juno.HANDLERS.ping = () => { calls++; return {}; };
      await restarted.juno.schedule(cmd, restarted.now());
      assert.equal(calls, 1);
    });
  }

  test("a stale outer state snapshot cannot restart migration after command progress", async () => {
    const env = boot({ store: { cursor: 7 } });
    const key = env.juno.cursorKey(env.store.deviceToken);
    const normalGet = env.chrome.storage.local.get;
    const normalSet = env.chrome.storage.local.set;
    let release;
    let migrationWrites = 0;
    env.chrome.storage.local.get = (defaults) => {
      if (Object.hasOwn(defaults, "deviceToken") && !release) {
        const snapshot = normalGet(defaults);
        return new Promise((resolve) => { release = async () => resolve(await snapshot); });
      }
      return normalGet(defaults);
    };
    env.chrome.storage.local.set = (obj) => {
      if (obj[key] === 7) migrationWrites++;
      return normalSet(obj);
    };
    const stale = env.juno.getState();
    await until(() => !!release);
    let calls = 0;
    env.juno.HANDLERS.ping = () => { calls++; return {}; };
    const cmd = command({ seq: 10, issued_at: env.now() });
    await env.juno.schedule(cmd, env.now());
    assert.equal(env.store[key], 10);
    await release();
    assert.equal((await stale).cursor, 10);
    assert.equal(env.store[key], 10);
    assert.equal(migrationWrites, 1);
    await env.juno.schedule(cmd, env.now());
    assert.equal(calls, 1);
  });

  test("a new device without a scoped cursor cannot import another device's legacy progress", async () => {
    const env = boot({ store: { cursor: 7 } });
    const oldToken = env.store.deviceToken;
    await env.juno.getState();
    const token = "ef".repeat(32);
    await env.chrome.storage.local.set({ deviceToken: token });
    assert.equal((await env.juno.getState()).cursor, 0);
    assert.equal(env.store[env.juno.cursorKey(token)], 0);
    assert.equal(env.store.legacyCursorToken, oldToken);
    let calls = 0;
    env.juno.HANDLERS.ping = () => { calls++; return {}; };
    await env.juno.schedule(command({ seq: 4, issued_at: env.now() }), env.now(), token);
    assert.equal(calls, 1);
    assert.equal(env.store[env.juno.cursorKey(token)], 4);
    assert.equal(env.store.cursor, 7);
  });

  test("a delayed legacy migration cannot change a pairing initialized by Options", async () => {
    const env = boot({ store: { cursor: 91 } });
    const oldToken = env.store.deviceToken;
    const oldKey = env.juno.cursorKey(oldToken);
    const token = "ef".repeat(32);
    const key = env.juno.cursorKey(token);
    const normalSet = env.chrome.storage.local.set;
    let release;
    env.chrome.storage.local.set = (obj) => {
      if (obj[oldKey] === 91) return new Promise((resolve) => {
        release = async () => { await normalSet(obj); resolve(); };
      });
      return normalSet(obj);
    };
    const migrating = env.juno.getState();
    await until(() => !!release);
    await bootOptions(env, token).register();
    assert.equal((await env.juno.getState()).cursor, 0);
    await env.juno.schedule(command({ seq: 3, issued_at: env.now() }), env.now(), token);
    await release();
    await migrating;
    assert.equal(env.store.deviceToken, token);
    assert.equal(env.store[key], 3);
    assert.equal(env.store[oldKey], 91);
    assert.equal((await env.juno.getState()).cursor, 3);
  });

  for (const failedOperation of ["migration", "command save"]) {
    test(`a failed ${failedOperation} does not execute or acknowledge a command`, async () => {
      const env = boot({ store: { cursor: 7 } });
      const token = env.store.deviceToken;
      const key = env.juno.cursorKey(token);
      if (failedOperation === "command save") await env.juno.getState();
      const normalSet = env.chrome.storage.local.set;
      env.chrome.storage.local.set = (obj) => Object.hasOwn(obj, key)
        ? Promise.reject(new Error("synthetic storage failure")) : normalSet(obj);
      const ws = new MockWebSocket("wss://synthetic.invalid/ws");
      env.juno.attachSocket(ws, token);
      await tick();
      let calls = 0;
      env.juno.HANDLERS.ping = () => { calls++; return {}; };
      const cmd = command({ seq: 10, issued_at: env.now() });
      try {
        await assert.rejects(() => env.juno.takeAndRun(cmd, env.now(), env.now(), env.juno.epoch(), token, ws),
          /synthetic storage failure/);
        assert.equal(calls, 0);
        assert.equal(ws.sent.length, 0);
        assert.equal(env.store[key], failedOperation === "migration" ? undefined : 7);
        assert.equal(env.store.cursor, 7);
        assert.equal(resultFor(env, cmd.id), undefined);
      } finally { ws.close(); }
    });
  }
});

describe("extension audit regressions", { concurrency: 1 }, () => {
  for (const mode of ["command", "empty", "rejected", "network error"]) {
    test(`a delayed old-device poll ${mode} cannot change the new pairing`, async () => {
      const env = boot();
      const oldToken = env.store.deviceToken;
      const cmd = command({ seq: 91, issued_at: env.now() });
      let reply;
      env.fetchControl.fn = (url) => {
        if (url.endsWith("/poll")) return new Promise((resolve, reject) => { reply = { resolve, reject }; });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };
      let ran = false;
      env.juno.HANDLERS.ping = () => { ran = true; return {}; };
      const pending = env.juno.pollOnce();
      await until(() => !!reply);
      await env.chrome.storage.local.set({ deviceToken: "ef".repeat(32), [env.juno.cursorKey("ef".repeat(32))]: 3,
        relayStatus: { state: "new pairing" } });
      if (mode === "network error") reply.reject(new Error("old request failed"));
      else reply.resolve({ ok: mode !== "rejected", status: mode === "empty" ? 204 : mode === "rejected" ? 403 : 200,
        json: async () => ({ cmd, now: env.now() }) });
      assert.equal(await pending, false);
      assert.equal(ran, false);
      assert.equal(env.cursor(), 3);
      assert.equal(env.store.relayStatus.state, "new pairing");
      assert.equal(env.fetches.filter((entry) => entry.url.endsWith("/result")).length, 0);
      assert.equal(env.fetches[0].body.token, oldToken);
    });
  }

  for (const setting of ["enabled", "allowlist", "allowEval", "delayed permission notification"]) {
    test(`a policy epoch change during poll JSON drops ${setting} work`, async () => {
      const env = boot();
      const cmd = command({ seq: 99, issued_at: env.now() });
      let release;
      env.fetchControl.fn = () => ({ ok: true, status: 200,
        json: () => new Promise((resolve) => { release = () => resolve({ cmd, now: env.now() }); }) });
      const pending = env.juno.pollOnce();
      await until(() => !!release);
      if (setting === "enabled") {
        await env.chrome.storage.local.set({ enabled: false });
        await env.chrome.storage.local.set({ enabled: true });
      } else if (setting === "delayed permission notification") env.store.allowlist = [];
      else await env.chrome.storage.local.set({ [setting]: setting === "allowlist" ? [] : true });
      release();
      assert.equal(await pending, false);
      assert.equal(env.cursor(), 0);
      assert.equal(env.store.relayStatus, undefined);
    });
  }

  test("allowlist changes invalidate queued and active commands", async () => {
    const env = boot();
    let release;
    let count = 0;
    env.juno.HANDLERS.ping = () => {
      count++;
      if (count === 1) return new Promise((resolve) => { release = resolve; });
      return {};
    };
    const first = command({ issued_at: env.now() });
    const second = command({ issued_at: env.now() });
    const running = env.juno.schedule(first, env.now());
    const queued = env.juno.schedule(second, env.now());
    await until(() => !!release);
    await env.chrome.storage.local.set({ allowlist: [] });
    release({});
    await Promise.all([running, queued]);
    assert.equal(count, 1);
    assert.equal(resultFor(env, first.id).ok, false);
    assert.equal(resultFor(env, second.id), undefined);
    assert.equal(env.cursor(), first.seq);
  });

  for (const mode of ["allowlist", "eval permission", "notification delayed"]) {
    test(`permission change during mouseMoved (${mode}) prevents further input`, async () => {
      const env = boot({
        async sendCommand({ method, params, chrome, store }) {
          if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
            if (mode === "notification delayed") store.allowlist = [];
            else await chrome.storage.local.set(mode === "allowlist" ? { allowlist: [] } : { allowEval: false });
          }
        },
      });
      if (mode === "eval permission") await env.chrome.storage.local.set({ allowEval: true });
      env.addTab(7, "https://example.com/page");
      const cmd = command({ action: "click", issued_at: env.now(), params: { tabId: 7, x: 1, y: 2 } });
      await env.juno.schedule(cmd, env.now());
      assert.deepEqual(mouseTypes(env), ["mouseMoved"]);
      assert.equal(resultFor(env, cmd.id).ok, false);
      assert.match(resultFor(env, cmd.id).error, /cancelled/);
    });
  }

  for (const drift of ["url", "pending navigation", "same-url reload", "permission"]) {
    test(`screenshot output is discarded on ${drift} during capture`, async () => {
      const env = boot({
        async sendCommand({ method, tabs, store }) {
          if (method !== "Page.captureScreenshot") return;
          const tab = tabs.get(7);
          if (drift === "url") tab.url = "https://private.invalid/secret";
          if (drift === "pending navigation") tab.pendingUrl = "https://private.invalid/secret";
          if (drift === "same-url reload") tab.timeOrigin = 5000;
          if (drift === "permission") store.allowlist = [];
          return { data: "PRIVATE-PIXELS" };
        },
      });
      env.addTab(7, "https://example.com/page");
      const cmd = command({ action: "screenshot", issued_at: env.now(), params: { tabId: 7 } });
      await env.juno.schedule(cmd, env.now());
      const result = resultFor(env, cmd.id);
      assert.equal(result.ok, false);
      assert.equal(result.data, null);
      assert.equal(JSON.stringify(result).includes("PRIVATE-PIXELS"), false);
      assert.equal(JSON.stringify(result).includes("private.invalid"), false);
    });
  }

  test("text output is discarded after a same-URL reload during evaluation", async () => {
    const env = boot({
      async sendCommand({ method, params, tabs }) {
        if (method === "Runtime.evaluate" && params.expression.includes("document.body ? document.body.innerText")) {
          tabs.get(7).timeOrigin = 5000;
          return { result: { value: { url: "https://example.com/page", text: "PRIVATE-TEXT" } } };
        }
      },
    });
    env.addTab(7, "https://example.com/page");
    const cmd = command({ action: "text", issued_at: env.now(), params: { tabId: 7 } });
    await env.juno.schedule(cmd, env.now());
    const result = resultFor(env, cmd.id);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("PRIVATE-TEXT"), false);
  });

  test("disabling eval while its response is pending discards the value", async () => {
    let release;
    const env = boot({
      async sendCommand({ method, params }) {
        if (method === "Runtime.evaluate" && params.expression === "secretValue") {
          return await new Promise((resolve) => { release = () => resolve({ result: { value: "PRIVATE-EVAL" } }); });
        }
      },
    });
    await env.chrome.storage.local.set({ allowEval: true });
    env.addTab(7, "https://example.com/page");
    const cmd = command({ action: "eval", issued_at: env.now(), params: { tabId: 7, js: "secretValue" } });
    const pending = env.juno.schedule(cmd, env.now());
    await until(() => !!release);
    await env.chrome.storage.local.set({ allowEval: false });
    release();
    await pending;
    const result = resultFor(env, cmd.id);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("PRIVATE-EVAL"), false);
  });

  for (const stalled of ["fetch", "JSON body"]) {
    test(`a stalled poll ${stalled} aborts on the whole-request deadline`, async () => {
      const env = boot({ timeouts: { POLL_TIMEOUT_MS: 25 } });
      let signal;
      env.fetchControl.fn = (_url, _body, opts) => {
        signal = opts.signal;
        if (stalled === "fetch") return new Promise(() => {});
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      };
      await assert.rejects(() => env.juno.pollOnce(), /timed out/);
      assert.equal(signal.aborted, true);
      assert.equal(env.cursor(), 0);
      assert.equal(env.store.relayStatus.state, "unreachable");
    });

    test(`a stalled result ${stalled} aborts, logs delivery failure, and releases the queue`, async () => {
      const env = boot({ timeouts: { RESULT_TIMEOUT_MS: 25, RESULT_RETRY_MS: 1 } });
      const signals = [];
      let firstId;
      env.fetchControl.fn = (url, body, opts) => {
        assert.ok(url.endsWith("/result"));
        if (body.id !== firstId) return { ok: true, status: 200, json: async () => ({ ok: true }) };
        signals.push(opts.signal);
        if (stalled === "fetch") return new Promise(() => {});
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      };
      const first = command({ issued_at: env.now() });
      firstId = first.id;
      const second = command({ issued_at: env.now() });
      let runs = 0;
      env.juno.HANDLERS.ping = () => { runs++; return {}; };
      await Promise.all([env.juno.schedule(first, env.now()), env.juno.schedule(second, env.now())]);
      assert.equal(runs, 2);
      assert.equal(signals.length, 2);
      assert.ok(signals.every((signal) => signal.aborted));
      assert.equal(env.store.log[0].ok, true);
      assert.equal(env.store.log[0].resultDelivered, false);
      assert.match(env.store.log[0].deliveryError, /will not be retried/);
      assert.equal(env.store.log[1].resultDelivered, true);
    });
  }

  test("HTTP delivery retries 429 but refuses a terminal ownership error", async () => {
    const env = boot({ timeouts: { RESULT_RETRY_MS: 1 } });
    let posts = 0;
    env.fetchControl.fn = () => ({ ok: ++posts > 1, status: posts === 1 ? 429 : 200,
      json: async () => ({ ok: true }) });
    assert.equal(await env.juno.sendResult(env.store.deviceToken, command().id, { ok: true }), true);
    assert.equal(posts, 2);
    env.fetchControl.fn = () => { posts++; return { ok: false, status: 403 }; };
    assert.equal(await env.juno.sendResult(env.store.deviceToken, command().id, { ok: true }), false);
    assert.equal(posts, 3);
  });

  test("old-pairing results use the original token over HTTP and never the new socket", async () => {
    const env = boot();
    const oldToken = env.store.deviceToken;
    await env.chrome.storage.local.set({ deviceToken: "ef".repeat(32) });
    const ws = { readyState: 1, sent: [], send(data) { this.sent.push(data); }, close() {} };
    env.juno.attachSocket(ws, env.store.deviceToken);
    const id = command().id;
    await env.juno.sendResult(oldToken, id, { ok: true, data: {} });
    assert.equal(ws.sent.length, 0);
    assert.equal(resultFor(env, id).token, oldToken);
  });

  for (const receipt of ["result_ack", "result_rejected"]) {
    test(`a ${receipt} from a different socket cannot settle the originating result`, async () => {
      const env = boot();
      env.juno.setResultAckMs(30);
      const old = { readyState: 1, send() {}, close() {} };
      const newer = { readyState: 1, send() {}, close() {} };
      env.juno.attachSocket(old, env.store.deviceToken);
      const id = command().id;
      const pending = env.juno.sendResult(env.store.deviceToken, id, { ok: true }, old);
      env.juno.attachSocket(newer, env.store.deviceToken);
      env.juno.handleSocketMessage({ type: receipt, id }, newer, env.store.deviceToken);
      await pending;
      assert.ok(resultFor(env, id));
    });
  }

  test("the originating socket can acknowledge after a newer same-device socket appears", async () => {
    const env = boot();
    env.juno.setResultAckMs(100);
    const old = { readyState: 1, send() {}, close() {} };
    const newer = { readyState: 1, send() {}, close() {} };
    env.juno.attachSocket(old, env.store.deviceToken);
    const id = command().id;
    const pending = env.juno.sendResult(env.store.deviceToken, id, { ok: true }, old);
    env.juno.attachSocket(newer, env.store.deviceToken);
    env.juno.handleSocketMessage({ type: "result_ack", id }, old, env.store.deviceToken);
    assert.equal(await pending, true);
    assert.equal(resultFor(env, id), undefined);
  });

  test("socket and HTTP caps count encoded UTF-8 bytes", async () => {
    const env = boot({ constants: { MAX_RESULT_BYTES: 1400, WS_MAX_MSG: 1000 } });
    const ws = { readyState: 1, sent: [], send(data) { this.sent.push(data); }, close() {} };
    env.juno.attachSocket(ws, env.store.deviceToken);
    const socketId = command().id;
    const outcome = { ok: true, data: "é".repeat(550) };
    assert.ok(JSON.stringify(outcome).length < 1000);
    await env.juno.sendResult(env.store.deviceToken, socketId, outcome);
    assert.equal(ws.sent.length, 0);
    assert.equal(resultFor(env, socketId).data, outcome.data);
    const httpId = command().id;
    await env.juno.sendResult(env.store.deviceToken, httpId, { ok: true, data: "é".repeat(800) });
    assert.equal(resultFor(env, httpId).ok, false);
    assert.equal(resultFor(env, httpId).error, "result too large to relay");
  });

  test("the full HTTP envelope has an eight-MiB byte cap with a bounded error at the boundary", async () => {
    const env = boot();
    const id = command().id;
    const limit = 8 * 1024 * 1024;
    const envelope = { token: env.store.deviceToken, id, ok: true, data: "", error: null };
    const overhead = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    const fitting = "x".repeat(limit - overhead);
    await env.juno.sendResult(env.store.deviceToken, id, { ok: true, data: fitting });
    const accepted = resultFor(env, id);
    assert.equal(accepted.ok, true);
    assert.equal(new TextEncoder().encode(JSON.stringify(accepted)).byteLength, limit);
    assert.ok(new TextEncoder().encode(JSON.stringify({ ok: true, data: accepted.data,
      error: null, finished_at: env.now() })).byteLength < limit);
    const tooLargeId = command().id;
    await env.juno.sendResult(env.store.deviceToken, tooLargeId, { ok: true, data: fitting + "x" });
    const rejected = resultFor(env, tooLargeId);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.data, null);
    assert.equal(rejected.error, "result too large to relay");
  });

  test("each socket attempt mints a fresh ticket, keeps credentials out of URL and hello, and gates commands", async () => {
    const env = boot();
    let mints = 0;
    env.fetchControl.fn = (url) => {
      assert.ok(url.endsWith("/ws-ticket"));
      mints++;
      return { ok: true, status: 200, json: async () => ({ ticket: mints.toString(16).padStart(64, "0"), expires_in: 30 }) };
    };
    let calls = 0;
    env.juno.HANDLERS.ping = () => { calls++; return {}; };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const previousCursor = env.cursor();
      const before = MockWebSocket.latest;
      const pending = env.juno.runSocket(env.store.deviceToken, env.cursor());
      await until(() => MockWebSocket.latest !== before);
      const ws = MockWebSocket.latest;
      try {
        await tick();
        assert.ok(ws.url.endsWith("/ws"));
        assert.equal(ws.url.includes(env.store.deviceToken), false);
        assert.equal(ws.url.includes("?"), false);
        assert.equal(ws.protocols[0], "juno-bridge-v1");
        assert.equal(ws.protocols[1], "juno-ticket." + attempt.toString(16).padStart(64, "0"));
        const hello = JSON.parse(ws.sent[0]);
        assert.equal(hello.token, undefined);
        const cmd = command({ issued_at: env.now() });
        ws.onmessage({ data: "null" });
        ws.onmessage({ data: JSON.stringify({ type: "cmd", cmd, now: env.now() }) });
        await env.juno.drain();
        assert.equal(env.cursor(), previousCursor);
        assert.equal(calls, attempt - 1);
        ws.onmessage({ data: JSON.stringify({ type: "welcome" }) });
        ws.onmessage({ data: JSON.stringify({ type: "cmd", cmd, now: env.now() }) });
        await env.juno.drain();
        assert.equal(calls, attempt);
        assert.equal(env.cursor(), cmd.seq);
      } finally { ws.close(); await pending; }
    }
    assert.equal(mints, 2);
    assert.ok(env.fetches.every((entry) => entry.body.token === env.store.deviceToken));
  });

  for (const change of ["pause and resume", "re-pair", "permissions"]) {
    test(`ticket issuance followed by ${change} constructs no stale socket`, async () => {
      const env = boot();
      let release;
      env.fetchControl.fn = () => ({ ok: true, status: 200,
        json: () => new Promise((resolve) => { release = () => resolve({ ticket: "cd".repeat(32) }); }) });
      const before = MockWebSocket.latest;
      const pending = env.juno.runSocket(env.store.deviceToken, 0);
      await until(() => !!release);
      if (change === "pause and resume") {
        await env.chrome.storage.local.set({ enabled: false });
        await env.chrome.storage.local.set({ enabled: true });
      } else await env.chrome.storage.local.set(change === "re-pair" ? { deviceToken: "ef".repeat(32) } : { allowlist: [] });
      release();
      const result = await pending;
      assert.equal(result.opened, false);
      assert.equal(MockWebSocket.latest, before);
    });
  }

  for (const failure of ["malformed ticket", "malformed JSON", "old relay", "rate limited", "network", "stalled fetch", "stalled JSON", "revoked"]) {
    test(`ticket ${failure} refuses the upgrade and selects the fallback outcome`, async () => {
      const env = boot({ timeouts: { SOCKET_TICKET_TIMEOUT_MS: 25 } });
      let signal;
      env.fetchControl.fn = (_url, _body, opts) => {
        signal = opts.signal;
        if (failure === "network") throw new Error("offline");
        if (failure === "stalled fetch") return new Promise(() => {});
        const status = failure === "old relay" ? 404 : failure === "rate limited" ? 429 : failure === "revoked" ? 403 : 200;
        return { ok: status === 200, status, json: async () => {
          if (failure === "malformed JSON") throw new Error("JSON error");
          if (failure === "stalled JSON") return await new Promise(() => {});
          return { ticket: failure === "malformed ticket" ? "not-a-ticket" : "cd".repeat(32) };
        } };
      };
      const before = MockWebSocket.latest;
      const result = await env.juno.runSocket(env.store.deviceToken, 0);
      assert.equal(result.opened, false);
      assert.equal(result.rejected, failure === "revoked");
      assert.equal(MockWebSocket.latest, before);
      if (failure.startsWith("stalled")) assert.equal(signal.aborted, true);
    });
  }

  test("pongs do not extend a socket's absolute welcome deadline", async () => {
    const env = boot({ timeouts: { SOCKET_WELCOME_TIMEOUT_MS: 30 } });
    const before = MockWebSocket.latest;
    const pending = env.juno.runSocket(env.store.deviceToken, 0);
    await until(() => MockWebSocket.latest !== before);
    const ws = MockWebSocket.latest;
    await tick();
    ws.onmessage({ data: "pong" });
    const result = await pending;
    assert.equal(result.opened, true);
    assert.equal(result.welcomed, false);
    assert.equal(ws.readyState, MockWebSocket.CLOSED);
  });
});
