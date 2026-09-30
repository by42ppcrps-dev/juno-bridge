// Pairing mutations in Options, including requests that overlap across tabs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = ["config.js", "allowlist.js", "options.js"]
  .map((name) => fs.readFileSync(path.join(root, "extension", name), "utf8"))
  .join("\n");
const OLD = "ab".repeat(32);
const NEW = "cd".repeat(32);
const LATER = "ef".repeat(32);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(data = { ok: true }, status = 200) {
  return { ok: status < 400, status, json: async () => data };
}

async function until(predicate) {
  for (let i = 0; i < 40 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true, "expected asynchronous pairing step");
}

function harness(initial = {}, relay = async () => response(), { webLocks = true } = {}) {
  const store = { deviceToken: OLD, enabled: true, deviceName: "Old", ...initial };
  const calls = [];
  const tails = new Map();
  const navigator = { locks: {
    request(name, fn) {
      const result = (tails.get(name) || Promise.resolve()).then(fn);
      tails.set(name, result.catch(() => {}));
      return result;
    },
  } };
  const chrome = { storage: { local: {
    async get(defaults) { return { ...defaults, ...store }; },
    async set(values) { Object.assign(store, values); },
    async remove(keys) { for (const key of keys) delete store[key]; },
  } } };
  const fetch = async (url, init) => {
    const call = { path: new URL(url).pathname, body: JSON.parse(init.body) };
    calls.push(call);
    return relay(call);
  };
  function page() {
    const nodes = new Map();
    const document = { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {
        value: "", checked: false, hidden: false, disabled: false,
        textContent: "", className: "", listeners: new Map(),
        addEventListener(type, listener) { this.listeners.set(type, listener); },
      });
      return nodes.get(id);
    } };
    const context = vm.createContext({
      chrome, document, fetch, URL, ...(webLocks ? { navigator } : {}),
    });
    vm.runInContext(source, context);
    return {
      nodes,
      click(id) { return nodes.get(id).listeners.get("click")(); },
      setCode(code = "SYNTHETIC") { nodes.get("code").value = code; },
      status() { return nodes.get("status"); },
    };
  }
  return { store, calls, page };
}

for (const tabs of [1, 2]) {
  test(`Unregister wins an earlier delayed Register in ${tabs} Options page${tabs === 1 ? "" : "s"}`, async () => {
    const pendingRegister = deferred();
    const env = harness({}, (call) => call.path === "/register"
      ? pendingRegister.promise
      : response(), { webLocks: tabs === 2 });
    const registrationPage = env.page();
    const unregisterPage = tabs === 1 ? registrationPage : env.page();
    registrationPage.setCode();
    const registering = registrationPage.click("registerBtn");
    await until(() => env.calls.some((call) => call.path === "/register"));

    await unregisterPage.click("unregisterBtn");
    assert.equal(env.store.deviceToken, undefined);
    assert.equal(env.store.enabled, false);
    pendingRegister.resolve(response({ device_token: NEW }));
    await registering;

    assert.equal(env.store.deviceToken, undefined);
    assert.equal(env.store.enabled, false);
    assert.deepEqual(env.calls.filter((call) => call.path === "/unregister")
      .map((call) => call.body.token), [OLD, NEW]);
    assert.match(registrationPage.status().textContent,
      tabs === 1 ? /Unregistered and revoked/ : /Registration cancelled/);
  });
}

test("the later Register wins across Options pages and the abandoned token is revoked", async () => {
  const firstResponse = deferred();
  const env = harness({}, (() => {
    let registrations = 0;
    return (call) => {
      if (call.path !== "/register") return response();
      registrations += 1;
      return registrations === 1 ? firstResponse.promise : response({ device_token: LATER });
    };
  })());
  const first = env.page(), second = env.page();
  first.setCode("FIRST");
  second.setCode("SECOND");
  const waiting = first.click("registerBtn");
  await until(() => env.calls.some((call) => call.path === "/register"));
  await second.click("registerBtn");
  firstResponse.resolve(response({ device_token: NEW }));
  await waiting;

  assert.equal(env.store.deviceToken, LATER);
  assert.equal(env.store[`cursor:${LATER}`], 0);
  assert.deepEqual(env.calls.filter((call) => call.path === "/unregister")
    .map((call) => call.body.token), [OLD, NEW]);
});

test("re-pair reports failed revocation of the previous device and gives an exact recovery command", async () => {
  const env = harness({}, (call) => call.path === "/register"
    ? response({ device_token: NEW })
    : response({ error: "relay unavailable" }, 503));
  const options = env.page();
  options.setCode();
  await options.click("registerBtn");

  assert.equal(env.store.deviceToken, NEW);
  assert.equal(env.store.enabled, true);
  assert.equal(options.status().className, "err");
  assert.match(options.status().textContent, /Registered, but the previous device could not be revoked/);
  assert.match(options.status().textContent, /python3 driver\/jb\.py revoke abababab/);
  assert.equal(options.status().textContent.includes(OLD), false);
});

test("a cancelled registration reports a failed revoke of its newly issued token", async () => {
  const pendingRegister = deferred();
  const env = harness({}, (call) => {
    if (call.path === "/register") return pendingRegister.promise;
    if (call.body.token === NEW) return response({ error: "relay unavailable" }, 503);
    return response();
  });
  const options = env.page();
  options.setCode();
  const registering = options.click("registerBtn");
  await until(() => env.calls.some((call) => call.path === "/register"));
  await options.click("unregisterBtn");
  pendingRegister.resolve(response({ device_token: NEW }));
  await registering;

  assert.equal(env.store.deviceToken, undefined);
  assert.equal(env.store.enabled, false);
  assert.equal(options.status().className, "err");
  assert.match(options.status().textContent, /new token could not be revoked/);
  assert.match(options.status().textContent, /python3 driver\/jb\.py revoke cdcdcdcd/);
});

for (const oldRevokeFails of [false, true]) {
  test(`Unregister during old-device revocation ${oldRevokeFails ? "keeps the failure warning" : "does not show stale Registered status"}`, async () => {
    const oldRevoke = deferred();
    const env = harness({}, (call) => {
      if (call.path === "/register") return response({ device_token: NEW });
      if (call.body.token === OLD) return oldRevoke.promise;
      return response();
    });
    const options = env.page();
    options.setCode();
    const registering = options.click("registerBtn");
    await until(() => env.calls.some((call) => call.path === "/unregister" && call.body.token === OLD));

    await options.click("unregisterBtn");
    assert.equal(env.store.deviceToken, undefined);
    oldRevoke.resolve(oldRevokeFails
      ? response({ error: "relay unavailable" }, 503)
      : response());
    await registering;

    assert.equal(env.store.deviceToken, undefined);
    assert.match(options.status().textContent,
      oldRevokeFails ? /previous device could not be revoked/ : /Unregistered and revoked/);
    if (oldRevokeFails) assert.match(options.status().textContent, /revoke abababab/);
  });
}
