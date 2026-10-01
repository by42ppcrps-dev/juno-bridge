// UI-state checks only; this harness does not launch Chrome.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/panel.js", import.meta.url), "utf8");

async function boot(status, settings = {}) {
  let now = 200000;
  const store = { deviceToken: "ab".repeat(32), enabled: true, allowlist: ["*"],
    log: [], relayStatus: status, ...settings };
  const nodes = new Map();
  const listeners = [];
  const timers = [];
  const sandbox = {
    Date: class extends Date { static now() { return now; } },
    JUNO_RELAY_URL: "https://example-relay.workers.dev",
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, appendChild() {} });
      return nodes.get(id);
    } },
    chrome: { storage: {
      local: { get: async (defaults) => ({ ...defaults, ...store }) },
      onChanged: { addListener(fn) { listeners.push(fn); } },
    } },
    setInterval(fn, delay) { timers.push({ fn, delay }); },
  };
  vm.runInNewContext(source, sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    nodes, store, timers,
    async advance(value) {
      now = value;
      for (const timer of timers) await timer.fn();
    },
    async changed() {
      for (const fn of listeners) fn({}, "local");
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

for (const via of ["live", "polling"]) {
  test(`an open panel ages out ${via} evidence and recovers on a fresh update`, async () => {
    const env = await boot({ state: "ok", via, at: 200000 });
    assert.match(env.nodes.get("statusText").textContent, /Active — (live connection|connected by polling)/);
    await env.advance(270000);
    assert.match(env.nodes.get("statusText").textContent, /has not been confirmed recently/);
    assert.equal(env.nodes.get("dot").className, "dot warn");
    env.store.relayStatus = { state: "ok", via, at: 270000 };
    await env.changed();
    assert.equal(env.nodes.get("dot").className, "dot");
  });
}

test("missing, invalid and future timestamps cannot claim a confirmed connection", async () => {
  for (const at of [undefined, null, "200000", NaN, 210000]) {
    const env = await boot({ state: "ok", via: "polling", at });
    assert.match(env.nodes.get("statusText").textContent, /has not been confirmed recently/);
  }
});

test("stale connection evidence does not override pause or missing registration", async () => {
  const paused = await boot({ state: "ok", via: "polling", at: 0 }, { enabled: false });
  assert.match(paused.nodes.get("statusText").textContent, /^Paused/);
  assert.equal(paused.nodes.get("toggleBtn").textContent, "Resume");
  const unpaired = await boot({ state: "ok", via: "live", at: 0 }, { deviceToken: null });
  assert.match(unpaired.nodes.get("statusText").textContent, /^Not registered/);
  assert.equal(unpaired.nodes.get("toggleBtn").hidden, true);
});
