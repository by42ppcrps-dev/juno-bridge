// Mock checks for the extension service worker. They do not load Chrome.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import vm from "node:vm";

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

  constructor(url) {
    this.url = url;
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
  };
  const tabs = new Map();
  const onChanged = [];
  const debuggerCalls = [];
  const queryCalls = [];
  const created = [];
  const fetches = [];
  const fetchControl = { fn: null };
  let tabGets = 0;
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
          const out = { ...(defaults || {}) };
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
        if (method === "Page.captureScreenshot") return { data: "QUJD" };
        if (method === "Runtime.evaluate" && options.pageEval) {
          return { result: { value: options.pageEval(params.expression, target) } };
        }
        return {};
      },
      onDetach: { addListener() {} },
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    WebSocket: MockWebSocket,
  };
  sandbox.fetch = async (url, opts) => {
    let body = null;
    if (opts && opts.body) body = JSON.parse(opts.body);
    fetches.push({ url: String(url), body });
    if (fetchControl.fn) return fetchControl.fn(String(url), body, opts);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  vm.createContext(sandbox);
  sandbox.JUNO_TEST = true;
  sandbox.WebSocket = MockWebSocket;
  sandbox.chrome = chrome;
  sandbox.importScripts = () => {};
  sandbox.fetch = sandbox.fetch;
  vm.runInContext(prefixed, sandbox, { filename: "extension/background.js" });
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
    state() {
      return {
        deviceToken: store.deviceToken,
        enabled: store.enabled,
        allowlist: store.allowlist.slice(),
        allowEval: !!store.allowEval,
        cursor: store.cursor,
      };
    },
  };
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
    assert.equal(env.store.cursor, cmd.seq);
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
    assert.equal(env.store.cursor, 0);
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
    assert.equal(env.store.cursor, 0);
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
    const env = boot({
      pageEval(expr) {
        return vm.runInNewContext(expr, {
          document: {
            title: "Example",
            body: { innerText: "" },
            querySelectorAll() {
              return elements;
            },
          },
          window: { innerWidth: 1280, innerHeight: 800 },
          location: { href },
          scrollX: 0,
          scrollY: 0,
        });
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
    state.allowEval = true;
    const result = await env.juno.HANDLERS.eval(
      { tabId: 7, js: "document.body.innerText" },
      state,
      { target: "" },
      epoch,
    );
    assert.equal(result.value, "pw-SECRET-alpha");
    assert.equal(result.redaction, undefined);
  });

  test("a socket send waits for result_ack and falls back only on timeout", async () => {
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
    env.juno.attachSocket(ws);
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
    env.juno.attachSocket(slow);
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
    env.juno.attachSocket(rejecting);
    const before = env.fetches.length;
    await env.juno.sendResult(env.store.deviceToken, command().id, { ok: true, data: { n: 2 } });
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
    assert.equal(env.store.cursor, 4);
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
    const ws = MockWebSocket.latest;
    assert.notEqual(ws, before);
    try {
      await tick();
      assert.match(ws.url, /\/ws$/);
      const hello = JSON.parse(ws.sent[0]);
      assert.equal(hello.type, "hello");
      assert.equal(hello.after, 5);
      assert.equal(hello.token, env.store.deviceToken);
      assert.equal(hello.version, "1.3.0");
      const now = env.now();
      const old = command({ seq: 5, issued_at: now });
      const newer = command({ seq: 6, issued_at: now });
      ws.onmessage({ data: JSON.stringify({ type: "welcome", now }) });
      ws.onmessage({ data: JSON.stringify({ type: "cmd", cmd: old, now }) });
      ws.onmessage({ data: JSON.stringify({ type: "cmd", cmd: newer, now }) });
      await env.juno.drain();
      assert.equal(calls, 1);
      assert.equal(env.store.cursor, 6);
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
});
