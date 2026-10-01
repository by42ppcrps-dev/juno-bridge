// Mock checks for the relay. They do not deploy to Cloudflare.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { timingSafeEqual } from "node:crypto";
import worker, { BridgeHub } from "../relay/worker.js";

const PASSPHRASE = "correct-horse-battery";
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef";
// Workers-only Web Crypto extension; exercise the same native comparison in Node.
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));

class MemoryStorage {
  constructor() {
    this.data = new Map();
  }

  async get(keys) {
    if (Array.isArray(keys)) {
      const out = new Map();
      for (const key of keys) {
        if (this.data.has(key)) out.set(key, structuredClone(this.data.get(key)));
      }
      return out;
    }
    return this.data.has(keys) ? structuredClone(this.data.get(keys)) : undefined;
  }

  async put(key, value) {
    if (typeof key === "string") {
      this.data.set(key, structuredClone(value));
      return;
    }
    for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
  }

  async list({ prefix, limit = Infinity, startAfter } = {}) {
    const out = new Map();
    for (const [key, value] of [...this.data].sort(([a], [b]) => a.localeCompare(b))) {
      if (prefix && !key.startsWith(prefix)) continue;
      if (startAfter && key <= startAfter) continue;
      if (out.size >= limit) break;
      out.set(key, structuredClone(value));
    }
    return out;
  }

  async transaction(fn) {
    const prior = this.data;
    this.data = structuredClone(prior);
    try { return await fn(this); }
    catch (e) { this.data = prior; throw e; }
  }

  async setAlarm(time) { this.data.set("__alarm", time); }
  async getAlarm() { return this.data.get("__alarm") || null; }
  async deleteAlarm() { this.data.delete("__alarm"); }
}

class MockSocket {
  constructor() {
    this.sent = [];
    this.attachment = null;
    this.closed = null;
  }

  serializeAttachment(value) {
    this.attachment = value;
  }

  deserializeAttachment() {
    return this.attachment;
  }

  send(data) {
    if (this.closed) throw new Error("send on closed socket");
    this.sent.push(String(data));
  }

  close(code, reason) {
    this.closed = { code, reason: reason || "" };
  }
}

class WebSocketPair {
  constructor() {
    // Object.values order is insertion order: the worker takes [client, server].
    this.client = new MockSocket();
    this.server = new MockSocket();
  }
}

class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
}

class TestResponse extends Response {
  constructor(body, init = {}) {
    const copy = { ...init };
    const webSocket = copy.webSocket;
    delete copy.webSocket;
    if (copy.status === 101) {
      super(body, { ...copy, status: 200 });
      Object.defineProperty(this, "status", { value: 101 });
    } else {
      super(body, copy);
    }
    if (webSocket) this.webSocket = webSocket;
  }
}

globalThis.Response = TestResponse;
globalThis.WebSocketPair = WebSocketPair;
globalThis.WebSocketRequestResponsePair = WebSocketRequestResponsePair;

function makeCtx(storage) {
  const sockets = [];
  const ctx = {
    storage,
    sockets,
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws) {
      sockets.push(ws);
    },
    getWebSockets() {
      return sockets;
    },
    blockConcurrencyWhile(fn) {
      ctx.ready = Promise.resolve().then(() => fn());
    },
  };
  return ctx;
}

async function bootHub(env = {}, storage = new MemoryStorage()) {
  const ctx = makeCtx(storage);
  const hub = new BridgeHub(ctx, env);
  if (!ctx.ready) throw new Error("Durable Object did not start loading");
  await ctx.ready;
  return { hub, ctx, storage };
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bomb() {
  const hub = {
    calls: 0,
    idFromName() {
      hub.calls += 1;
      throw new Error("woke idFromName");
    },
    get() {
      hub.calls += 1;
      throw new Error("woke get");
    },
  };
  return hub;
}

function admin(path, { method = "GET", body, passphrase = PASSPHRASE } = {}) {
  const headers = { authorization: "Bearer " + passphrase };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return new Request("https://relay.example" + path, { method, headers, body: payload });
}

function post(path, body) {
  return new Request("https://relay.example" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function wsReq(origin, ticket) {
  const headers = { upgrade: "websocket" };
  if (origin !== undefined) headers.origin = origin;
  if (ticket) headers["sec-websocket-protocol"] = "juno-bridge-v1, juno-ticket." + ticket;
  return new Request("https://relay.example/ws", { headers });
}

async function authWsReq(hub, token, origin = EXTENSION_ORIGIN) {
  const req = post("/ws-ticket", { token });
  if (origin) req.headers.set("origin", origin);
  const minted = await read(await hub.fetch(req));
  assert.equal(minted.status, 200, JSON.stringify(minted.data));
  return wsReq(origin || undefined, minted.data.ticket);
}

async function read(res) {
  if (res.status === 101) return { status: 101, data: null, webSocket: res.webSocket };
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }
  }
  return { status: res.status, data };
}

async function pairAndRegister(hub, name) {
  const created = await read(await hub.fetch(admin("/admin/pair", { method: "POST", body: {} })));
  assert.equal(created.status, 200);
  assert.match(created.data.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  const reg = await read(await hub.fetch(post("/register", { code: created.data.code, name })));
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  assert.match(reg.data.device_token, /^[0-9a-f]{64}$/);
  return { code: created.data.code, token: reg.data.device_token };
}

class StrictStorage extends MemoryStorage {
  constructor() { super(); this.deleteSizes = []; this.listLimits = []; this.failPut = null; }
  async put(key, value) {
    const keys = typeof key === "string" ? [key] : Object.keys(key);
    assert.ok(keys.length <= 128, "storage put batch exceeds the documented limit");
    if (typeof key === "string" && key.startsWith("chunk:")) assert.ok(value.byteLength <= 100 * 1024);
    await super.put(key, value);
    if (this.failPut && keys.some(this.failPut)) { this.failPut = null; throw new Error("injected write failure"); }
  }
  async delete(keys) {
    const size = Array.isArray(keys) ? keys.length : 1;
    this.deleteSizes.push(size); assert.ok(size <= 128, "storage delete batch exceeds the documented limit");
    return super.delete(keys);
  }
  async list(options) {
    this.listLimits.push(options);
    return super.list(options);
  }
}

async function enqueue(hub, token, requestId = "req_audit_01") {
  const res = await read(await hub.fetch(admin("/admin/cmd", {
    method: "POST", body: { action: "ping", device: token, request_id: requestId },
  })));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.id;
}

function streamingRequest(path, stream, authenticated = false) {
  return new Request("https://relay.example" + path, {
    method: "POST", body: stream, duplex: "half",
    headers: authenticated ? { authorization: "Bearer " + PASSPHRASE } : {},
  });
}

describe("relay", { concurrency: 1 }, () => {
  test("GET / reports configuration and does not wake the hub", async () => {
    const asleep = bomb();
    const plain = await read(await worker.fetch(new Request("https://relay.example/"), { HUB: asleep }));
    assert.deepEqual(plain.data, { service: "juno-bridge", ok: true, configured: false });
    assert.equal(asleep.calls, 0);

    const upper = bomb();
    const hash = (await sha256(PASSPHRASE)).toUpperCase();
    const ready = await read(await worker.fetch(new Request("https://relay.example/"), {
      ADMIN_PSK_SHA256: hash,
      HUB: upper,
    }));
    assert.equal(ready.data.configured, true);
    assert.equal(ready.data.ok, true);
    assert.equal(upper.calls, 0);

    const junk = bomb();
    const raw = await read(await worker.fetch(new Request("https://relay.example/"), {
      ADMIN_PSK_SHA256: PASSPHRASE,
      HUB: junk,
    }));
    assert.equal(raw.data.configured, false);
    assert.equal(junk.calls, 0);
  });

  test("operational routes stay dark until ADMIN_PSK_SHA256 is a hex digest", async () => {
    for (const secret of [undefined, PASSPHRASE, "abcd"]) {
      const asleep = bomb();
      const env = { HUB: asleep };
      if (secret !== undefined) env.ADMIN_PSK_SHA256 = secret;
      const res = await read(await worker.fetch(admin("/admin/pair", { method: "POST", body: {} }), env));
      assert.equal(res.status, 503);
      assert.equal(res.data.error, "admin_not_configured");
      assert.equal(asleep.calls, 0);
    }

    const hash = await sha256(PASSPHRASE);
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: hash });
    let calls = 0;
    const env = {
      ADMIN_PSK_SHA256: hash,
      HUB: {
        idFromName(name) {
          calls += 1;
          assert.equal(name, "juno-bridge");
          return "hub";
        },
        get(id) {
          assert.equal(id, "hub");
          return hub;
        },
      },
    };
    const opened = await read(await worker.fetch(admin("/admin/pair", { method: "POST", body: {} }), env));
    assert.equal(opened.status, 200);
    assert.equal(calls, 1);
    assert.match(opened.data.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  test("bootstrap is disabled and cannot store a passphrase", async () => {
    const hash = await sha256(PASSPHRASE);
    for (const secret of [undefined, hash]) {
      const asleep = bomb();
      const env = { HUB: asleep };
      if (secret !== undefined) env.ADMIN_PSK_SHA256 = secret;
      const res = await read(await worker.fetch(new Request("https://relay.example/admin/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "attacker-passphrase-value" }),
      }), env));
      assert.equal(res.status, 410);
      assert.equal(res.data.error, "bootstrap_disabled");
      assert.equal(asleep.calls, 0);
    }

    const { hub } = await bootHub({ ADMIN_PSK_SHA256: hash });
    const direct = await read(await hub.fetch(new Request("https://relay.example/admin/bootstrap", {
      method: "POST",
      body: "{}",
    })));
    assert.equal(direct.status, 410);
    const ping = await read(await hub.fetch(admin("/admin/ping")));
    assert.equal(ping.status, 200);
    assert.equal(ping.data.ok, true);
  });

  test("a stored or imported admin hash does not authenticate", async () => {
    const oldPass = "old-passphrase-value";
    const storage = new MemoryStorage();
    await storage.put({
      admin_hash: await sha256(oldPass),
      devices: new Map(),
      order: [],
      pairs: new Map(),
      migrated: true,
    });

    const dark = await bootHub({}, storage);
    const refused = await read(await dark.hub.fetch(admin("/admin/ping", { passphrase: oldPass })));
    assert.equal(refused.status, 503);
    assert.equal(refused.data.error, "admin_not_configured");

    const live = await bootHub({ ADMIN_PSK_SHA256: (await sha256(PASSPHRASE)).toUpperCase() }, storage);
    const stale = await read(await live.hub.fetch(admin("/admin/ping", { passphrase: oldPass })));
    assert.equal(stale.status, 403);
    assert.equal(stale.data.error, "bad_auth");
    const current = await read(await live.hub.fetch(admin("/admin/ping")));
    assert.equal(current.status, 200);

    const token = "ab".repeat(32);
    const importedHash = await sha256("imported-passphrase-xx");
    const kv = {
      async get(key, type) {
        if (key === "cfg:admin_hash") return importedHash;
        if (key === "devices:index" && type === "json") return [token];
        if (key === "device:" + token && type === "json") return { name: "Old laptop", created: 1 };
        return null;
      },
    };
    const imported = await bootHub({
      ADMIN_PSK_SHA256: await sha256(PASSPHRASE),
      BRIDGE: kv,
    });
    const oldKey = await read(await imported.hub.fetch(admin("/admin/ping", { passphrase: "imported-passphrase-xx" })));
    assert.equal(oldKey.status, 403);
    const listed = await read(await imported.hub.fetch(admin("/admin/devices")));
    assert.equal(listed.data.devices.length, 1);
    assert.equal(listed.data.devices[0].name, "Old laptop");
    assert.equal(listed.data.devices[0].id, token.slice(0, 8));
  });

  test("pairing codes are single-use and revocation closes the live socket", async () => {
    const { hub, ctx } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const device = await pairAndRegister(hub, "Work laptop");
    const reuse = await read(await hub.fetch(post("/register", { code: device.code, name: "second" })));
    assert.equal(reuse.status, 403);
    assert.equal(reuse.data.error, "bad_or_expired_code");
    const bad = await read(await hub.fetch(post("/register", { code: "AAAAAAAA" })));
    assert.equal(bad.status, 403);
    assert.equal(bad.data.error, "bad_or_expired_code");

    const listed = await read(await hub.fetch(admin("/admin/devices")));
    assert.equal(listed.data.devices.length, 1);
    assert.equal(listed.data.devices[0].name, "Work laptop");
    assert.equal(listed.data.devices[0].connected, false);
    const empty = await hub.fetch(post("/poll", { token: device.token, after: 0 }));
    assert.equal(empty.status, 204);

    const opened = await read(await hub.fetch(await authWsReq(hub, device.token)));
    assert.equal(opened.status, 101);
    const server = ctx.sockets.at(-1);
    await hub.webSocketMessage(server, JSON.stringify({
      type: "hello", token: device.token, after: 0, version: "1.3.0",
    }));
    assert.equal(JSON.parse(server.sent[0]).type, "welcome");

    const revoked = await read(await hub.fetch(admin("/admin/revoke", {
      method: "POST",
      body: { device: device.token.slice(0, 8) },
    })));
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.ok, true);
    assert.equal(server.closed && server.closed.code, 4003);
    const poll = await read(await hub.fetch(post("/poll", { token: device.token, after: 0 })));
    assert.equal(poll.status, 403);
    assert.equal(poll.data.error, "unknown_device");
  });

  test("a websocket origin, when sent, must be an extension", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const web = await read(await hub.fetch(wsReq("https://evil.example")));
    assert.equal(web.status, 403);
    assert.equal(web.data.error, "forbidden_origin");
    const extension = await read(await hub.fetch(await authWsReq(hub, token)));
    assert.equal(extension.status, 101);
    const omitted = await read(await hub.fetch(await authWsReq(hub, token, null)));
    assert.equal(omitted.status, 101);
  });

  test("the hello timeout does not keep the process alive", async () => {
    const orig = globalThis.setTimeout;
    const handles = [];
    globalThis.setTimeout = (fn, ms, ...args) => {
      const handle = orig(fn, ms, ...args);
      handles.push({ handle, ms });
      return handle;
    };
    try {
      const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
      const { token } = await pairAndRegister(hub, "A");
      const opened = await hub.fetch(await authWsReq(hub, token));
      assert.equal(opened.status, 101);
      const hello = handles.filter((item) => item.ms === 10_000);
      assert.ok(hello.length >= 1);
      assert.equal(hello[0].handle.hasRef(), false);
    } finally {
      globalThis.setTimeout = orig;
      for (const { handle } of handles) clearTimeout(handle);
    }
  });

  test("HTTP poll returns a command and its result, and ownership survives the ack", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const enq = await read(await hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: token, params: {} },
    })));
    assert.equal(enq.status, 200);
    const polled = await read(await hub.fetch(post("/poll", { token, after: 0 })));
    assert.equal(polled.status, 200);
    assert.equal(polled.data.cmd.id, enq.data.id);
    assert.equal(polled.data.cmd.action, "ping");
    assert.equal(typeof polled.data.now, "number");
    const acked = await hub.fetch(post("/poll", { token, after: polled.data.cmd.seq }));
    assert.equal(acked.status, 204);
    const posted = await read(await hub.fetch(post("/result", {
      token, id: enq.data.id, ok: true, data: { pong: 1 },
    })));
    assert.equal(posted.status, 200);
    assert.equal(posted.data.ok, true);
    const got = await read(await hub.fetch(admin("/admin/result?id=" + enq.data.id + "&wait=0")));
    assert.equal(got.data.pending, false);
    assert.equal(got.data.result.data.pong, 1);
  });

  test("a legacy poll keeps command ownership", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const enq = await read(await hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: token, params: {} },
    })));
    const polled = await read(await hub.fetch(post("/poll", { token })));
    assert.equal(polled.data.cmd.id, enq.data.id);
    const posted = await read(await hub.fetch(post("/result", {
      token, id: enq.data.id, ok: true, data: { legacy: true },
    })));
    assert.equal(posted.status, 200);
    assert.equal(posted.data.ok, true);
  });

  test("transport diagnostics distinguish delivery, cursor acknowledgement and result without secrets", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const original = console.info;
    const logs = [];
    console.info = (...args) => { logs.push(args); };
    const privateText = "synthetic-private-page-content";
    try {
      const enq = await read(await hub.fetch(admin("/admin/cmd", { method: "POST",
        body: { action: "ping", device: token, params: { privateText } } })));
      const delivered = await read(await hub.fetch(post("/poll", { token, after: 0 })));
      await hub.fetch(post("/poll", { token, after: delivered.data.cmd.seq }));
      await hub.fetch(post("/result", { token, id: enq.data.id, ok: true, data: { privateText } }));
      const events = logs.filter(([prefix]) => prefix === "juno-bridge: transport").map(([, data]) => JSON.parse(data));
      assert.equal(events.find((e) => e.phase === "command_admitted").id, enq.data.id);
      assert.equal(events.find((e) => e.phase === "http_poll").returned_id, enq.data.id);
      assert.equal(events.find((e) => e.phase === "queue_acknowledged").first_seq, delivered.data.cmd.seq);
      assert.equal(events.find((e) => e.phase === "result_committed").id, enq.data.id);
      const encoded = JSON.stringify(logs);
      for (const secret of [token, PASSPHRASE, privateText]) assert.equal(encoded.includes(secret), false);
      assert.ok(events.every((e) => e.device === token.slice(0, 8) && Number.isSafeInteger(e.at)));
    } finally { console.info = original; }
  });

  test("an ahead cursor and invalid socket handshake produce bounded nonsecret diagnostics", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const original = console.info;
    const logs = [];
    console.info = (...args) => { logs.push(args); };
    try {
      const enq = await read(await hub.fetch(admin("/admin/cmd", { method: "POST",
        body: { action: "ping", device: token, params: {} } })));
      const admitted = JSON.parse(logs.find(([prefix]) => prefix === "juno-bridge: transport")[1]);
      const poll = await hub.fetch(post("/poll", { token, after: admitted.seq + 1 }));
      assert.equal(poll.status, 204);
      const ws = await read(await hub.fetch(new Request("https://relay.test/ws?token=" + token, {
        headers: { Upgrade: "websocket", Origin: "chrome-extension://" + "a".repeat(32) },
      })));
      assert.equal(ws.status, 403);
      assert.equal(ws.data.error, "bad_or_expired_ticket");
      const events = logs.map(([, data]) => JSON.parse(data));
      const acknowledged = events.find((e) => e.phase === "queue_acknowledged");
      assert.equal(acknowledged.first_id, enq.data.id);
      assert.ok(acknowledged.after > acknowledged.first_seq);
      const empty = events.find((e) => e.phase === "http_poll");
      assert.equal(empty.first_pending_id, enq.data.id);
      assert.equal(empty.returned_id, null);
      assert.equal(events.some((e) => e.phase === "result_committed"), false);
      const rejected = events.find((e) => e.phase === "ws_rejected");
      assert.equal(rejected.reason, "invalid_handshake");
      assert.equal(rejected.origin, "chrome-extension://" + "a".repeat(32));
      assert.equal(rejected.query_present, true);
      assert.equal(JSON.stringify(logs).includes(token), false);
    } finally { console.info = original; }
  });

  test("ownership survives acknowledgement and a hub reload", async () => {
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE) };
    const storage = new MemoryStorage();
    const first = await bootHub(env, storage);
    const { token } = await pairAndRegister(first.hub, "A");
    const enq = await read(await first.hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: token, params: {} },
    })));
    const polled = await read(await first.hub.fetch(post("/poll", { token, after: 0 })));
    const acked = await first.hub.fetch(post("/poll", { token, after: polled.data.cmd.seq }));
    assert.equal(acked.status, 204);
    const second = await bootHub(env, storage);
    const posted = await read(await second.hub.fetch(post("/result", {
      token, id: enq.data.id, ok: true, data: { from: "hibernated" },
    })));
    assert.equal(posted.status, 200);
    assert.equal(posted.data.ok, true);
    assert.equal(posted.data.duplicate, undefined);
  });

  test("results are accepted only from the device a command was issued to", async () => {
    const { hub, ctx } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const a = await pairAndRegister(hub, "A");
    const b = await pairAndRegister(hub, "B");
    const missing = "cmd_0123456789abcdef";
    const unknown = await read(await hub.fetch(post("/result", {
      token: a.token, id: missing, ok: true, data: { n: 1 },
    })));
    assert.equal(unknown.status, 403);
    assert.equal(unknown.data.error, "unknown_command");
    const stillPending = await read(await hub.fetch(admin("/admin/result?id=" + missing + "&wait=0")));
    assert.equal(stillPending.status, 404);
    assert.equal(stillPending.data.error, "unknown_command");

    const enq = await read(await hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: a.token, params: {} },
    })));
    const stolen = await read(await hub.fetch(post("/result", {
      token: b.token, id: enq.data.id, ok: true, data: { from: "b" },
    })));
    assert.equal(stolen.status, 403);
    assert.equal(stolen.data.error, "not_command_owner");
    const untouched = await read(await hub.fetch(admin("/admin/result?id=" + enq.data.id + "&wait=0")));
    assert.equal(untouched.data.pending, true);
    const owner = await read(await hub.fetch(post("/result", {
      token: a.token, id: enq.data.id, ok: true, data: { from: "a" },
    })));
    assert.equal(owner.status, 200);
    assert.equal(owner.data.ok, true);

    const opened = await read(await hub.fetch(await authWsReq(hub, b.token)));
    const server = ctx.sockets.at(-1);
    await hub.webSocketMessage(server, JSON.stringify({ type: "hello", token: b.token, after: 0 }));
    await hub.webSocketMessage(server, JSON.stringify({
      type: "result", id: missing, ok: true, data: {},
    }));
    const rejected = JSON.parse(server.sent.at(-1));
    assert.equal(rejected.type, "result_rejected");
    assert.equal(rejected.error, "unknown_command");
    assert.equal(rejected.id, missing);
  });

  test("the first result wins and a later post does not recreate it", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const enq = await read(await hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: token, params: {} },
    })));
    const id = enq.data.id;
    const first = await read(await hub.fetch(post("/result", { token, id, ok: true, data: { v: 1 } })));
    assert.deepEqual(first.data, { ok: true });
    const second = await read(await hub.fetch(post("/result", { token, id, ok: true, data: { v: 2 } })));
    assert.deepEqual(second.data, { ok: true, duplicate: true });
    const got = await read(await hub.fetch(admin("/admin/result?id=" + id + "&wait=0")));
    assert.equal(got.data.pending, false);
    assert.equal(got.data.result.data.v, 1);
    const third = await read(await hub.fetch(post("/result", { token, id, ok: false, error: "later" })));
    assert.deepEqual(third.data, { ok: true, duplicate: true });
    const gone = await read(await hub.fetch(admin("/admin/result?id=" + id + "&wait=0")));
    assert.equal(gone.data.pending, true);
  });

  test("a live socket acks the owner's result and does not redeliver an acked command", async () => {
    const { hub, ctx } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const a = await pairAndRegister(hub, "A");
    const b = await pairAndRegister(hub, "B");
    const enq = await read(await hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: a.token, params: {} },
    })));

    const other = await read(await hub.fetch(await authWsReq(hub, b.token)));
    assert.equal(other.status, 101);
    const intruder = ctx.sockets.at(-1);
    await hub.webSocketMessage(intruder, JSON.stringify({ type: "hello", token: b.token, after: 0 }));
    await hub.webSocketMessage(intruder, JSON.stringify({
      type: "result", id: enq.data.id, ok: true, data: { from: "b" },
    }));
    const rejection = JSON.parse(intruder.sent.at(-1));
    assert.equal(rejection.type, "result_rejected");
    assert.equal(rejection.error, "not_command_owner");
    const pending = await read(await hub.fetch(admin("/admin/result?id=" + enq.data.id + "&wait=0")));
    assert.equal(pending.data.pending, true);

    const opened = await read(await hub.fetch(await authWsReq(hub, a.token)));
    const server = ctx.sockets.at(-1);
    await hub.webSocketMessage(server, JSON.stringify({
      type: "hello", token: a.token, after: 0, version: "1.3.0",
    }));
    const pushed = server.sent.map((line) => JSON.parse(line));
    assert.equal(pushed[0].type, "welcome");
    const cmdMsg = pushed.find((msg) => msg.type === "cmd" && msg.cmd.id === enq.data.id);
    assert.ok(cmdMsg);
    await hub.webSocketMessage(server, JSON.stringify({
      type: "result", id: enq.data.id, ok: true, data: { via: "ws" },
    }));
    const ack = JSON.parse(server.sent.at(-1));
    assert.equal(ack.type, "result_ack");
    assert.equal(ack.id, enq.data.id);
    await hub.webSocketMessage(server, JSON.stringify({ type: "ack", seq: cmdMsg.cmd.seq }));

    const again = await read(await hub.fetch(await authWsReq(hub, a.token)));
    const server2 = ctx.sockets.at(-1);
    await hub.webSocketMessage(server2, JSON.stringify({
      type: "hello", token: a.token, after: cmdMsg.cmd.seq, version: "1.3.0",
    }));
    const replay = server2.sent.map((line) => JSON.parse(line));
    assert.equal(replay[0].type, "welcome");
    assert.equal(replay.some((msg) => msg.type === "cmd"), false);

    const got = await read(await hub.fetch(admin("/admin/result?id=" + enq.data.id + "&wait=0")));
    assert.equal(got.data.result.data.via, "ws");
  });

  test("a missing request id does not pretend to be idempotent", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const enq = await read(await hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: token, params: {} },
    })));
    assert.equal(enq.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(enq.data, "duplicate"), false);
    const first = await read(await hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: token, params: {}, request_id: "req_one_aaa" },
    })));
    const second = await read(await hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: token, params: {}, request_id: "req_two_bbb" },
    })));
    assert.equal(Object.prototype.hasOwnProperty.call(first.data, "duplicate"), false);
    assert.notEqual(first.data.id, second.data.id);
  });

  test("a bad request id is refused and enqueues nothing", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    for (const requestId of ["short", "bad id!!", "x".repeat(65)]) {
      const bad = await read(await hub.fetch(admin("/admin/cmd", {
        method: "POST",
        body: { action: "ping", device: token, params: {}, request_id: requestId },
      })));
      assert.equal(bad.status, 400, requestId);
      assert.equal(bad.data.error, "bad_request_id");
    }
    const poll = await hub.fetch(post("/poll", { token, after: 0 }));
    assert.equal(poll.status, 204);
  });

  test("overlapping runs with one request id share one command", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const body = {
      action: "ping",
      device: token,
      params: {},
      request_id: "req_shared1",
      wait: 5,
    };
    const first = hub.fetch(admin("/admin/run", { method: "POST", body }));
    const second = hub.fetch(admin("/admin/run", { method: "POST", body }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const polled = await read(await hub.fetch(post("/poll", { token, after: 0 })));
    assert.equal(polled.status, 200, JSON.stringify(polled.data));
    const id = polled.data.cmd.id;
    const posted = await read(await hub.fetch(post("/result", {
      token, id, ok: true, data: { shared: true },
    })));
    assert.deepEqual(posted.data, { ok: true });
    const [a, b] = await Promise.all([first.then(read), second.then(read)]);
    for (const res of [a, b]) {
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.id, id);
      assert.equal(res.data.pending, false);
      assert.equal(res.data.result.data.shared, true);
    }
    const duplicates = [a, b].filter((res) => res.data.duplicate === true);
    assert.equal(duplicates.length, 1);
    const acked = await hub.fetch(post("/poll", { token, after: polled.data.cmd.seq }));
    assert.equal(acked.status, 204);
  });

  test("a repeated request id returns the stored result after it was consumed", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A");
    const requestId = "req_keep_01";
    const pending = hub.fetch(admin("/admin/run", {
      method: "POST",
      body: { action: "ping", device: token, params: {}, request_id: requestId, wait: 5 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const polled = await read(await hub.fetch(post("/poll", { token, after: 0 })));
    const id = polled.data.cmd.id;
    await read(await hub.fetch(post("/result", { token, id, ok: true, data: { kept: true } })));
    const first = await read(await pending);
    assert.equal(first.data.pending, false);
    assert.equal(first.data.id, id);
    assert.equal(Object.prototype.hasOwnProperty.call(first.data, "duplicate"), false);
    assert.equal(first.data.result.data.kept, true);
    const again = await read(await hub.fetch(admin("/admin/run", {
      method: "POST",
      body: { action: "ping", device: token, params: { again: true }, request_id: requestId, wait: 0 },
    })));
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.id, id);
    assert.equal(again.data.pending, false);
    assert.equal(again.data.result.data.kept, true);
    const gone = await read(await hub.fetch(admin("/admin/result?id=" + id + "&wait=0")));
    assert.equal(gone.data.pending, true);
    const quiet = await hub.fetch(post("/poll", { token, after: polled.data.cmd.seq }));
    assert.equal(quiet.status, 204);
  });

  test("a hub reload still answers a repeated request id", async () => {
    const storage = new MemoryStorage();
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE) };
    const first = await bootHub(env, storage);
    const { token } = await pairAndRegister(first.hub, "A");
    const requestId = "req_reload1";
    const enq = await read(await first.hub.fetch(admin("/admin/cmd", {
      method: "POST",
      body: { action: "ping", device: token, params: {}, request_id: requestId },
    })));
    const id = enq.data.id;
    const polled = await read(await first.hub.fetch(post("/poll", { token, after: 0 })));
    assert.equal(polled.data.cmd.id, id);
    await read(await first.hub.fetch(post("/result", { token, id, ok: true, data: { kept: true } })));
    const acked = await first.hub.fetch(post("/poll", { token, after: polled.data.cmd.seq }));
    assert.equal(acked.status, 204);

    const second = await bootHub(env, storage);
    const replay = await read(await second.hub.fetch(admin("/admin/run", {
      method: "POST",
      body: { action: "click", device: token, params: { x: 1 }, request_id: requestId, wait: 0 },
    })));
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.equal(replay.data.duplicate, true);
    assert.equal(replay.data.id, id);
    assert.equal(replay.data.pending, false);
    assert.equal(replay.data.result.data.kept, true);
    const poll = await second.hub.fetch(post("/poll", { token, after: polled.data.cmd.seq }));
    assert.equal(poll.status, 204);
  });

  test("ping, device list and socket welcome advertise idempotency and workflow", async () => {
    const { hub, ctx } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const ping = await read(await hub.fetch(admin("/admin/ping")));
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.data.capabilities, ["idempotency", "workflow"]);
    const { token } = await pairAndRegister(hub, "A");
    const listed = await read(await hub.fetch(admin("/admin/devices")));
    assert.equal(listed.status, 200);
    assert.equal(listed.data.default, token.slice(0, 8));
    assert.deepEqual(listed.data.capabilities, ["idempotency", "workflow"]);
    const opened = await read(await hub.fetch(await authWsReq(hub, token)));
    assert.equal(opened.status, 101);
    const server = ctx.sockets.at(-1);
    await hub.webSocketMessage(server, JSON.stringify({
      type: "hello", token, after: 0, version: "1.3.0",
    }));
    const welcome = JSON.parse(server.sent[0]);
    assert.equal(welcome.type, "welcome");
    assert.deepEqual(welcome.capabilities, ["idempotency", "workflow"]);
    assert.equal(typeof welcome.now, "number");
  });
});

describe("relay audit regressions", { concurrency: 1 }, () => {
  test("anonymous upgrades cannot occupy slots; a ticket is bound, durable and single-use", async () => {
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE) };
    const { hub, ctx, storage } = await bootHub(env);
    for (let i = 0; i < 20; i++) assert.equal((await hub.fetch(wsReq(EXTENSION_ORIGIN))).status, 403);
    assert.equal(ctx.sockets.length, 0);
    const { token } = await pairAndRegister(hub, "A");
    const mintedRequest = post("/ws-ticket", { token }); mintedRequest.headers.set("origin", EXTENSION_ORIGIN);
    const { data } = await read(await hub.fetch(mintedRequest));
    assert.match(data.ticket, /^[0-9a-f]{64}$/); assert.equal(data.expires_in, 30);
    const restarted = await bootHub(env, storage);
    const wrongOrigin = await read(await restarted.hub.fetch(wsReq("chrome-extension://another-extension", data.ticket)));
    assert.equal(wrongOrigin.status, 403);
    const raced = await Promise.all([restarted.hub.fetch(wsReq(EXTENSION_ORIGIN, data.ticket)), restarted.hub.fetch(wsReq(EXTENSION_ORIGIN, data.ticket))]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [101, 403]);
    assert.equal(raced.find((r) => r.status === 101).headers.get("sec-websocket-protocol"), "juno-bridge-v1");
    assert.equal(restarted.ctx.sockets.length, 1);
    const server = restarted.ctx.sockets[0];
    await restarted.hub.webSocketMessage(server, JSON.stringify({ type: "hello", after: 0 }));
    assert.equal(JSON.parse(server.sent[0]).type, "welcome");
    assert.equal(server.attachment.token, token);
    assert.equal(storage.data.has("ticket:" + data.ticket), false);
    assert.equal((await restarted.hub.fetch(wsReq(EXTENSION_ORIGIN, data.ticket))).status, 403);
  });

  test("admin authorization happens before reading bodies and errors do not log credentials", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const denied = { url: "https://relay.example/admin/cmd", method: "POST", headers: new Headers(), get body() { throw new Error("read unauthenticated body"); } };
    assert.equal((await hub.fetch(denied)).status, 401);
    denied.headers.set("authorization", "Bearer wrong");
    assert.equal((await hub.fetch(denied)).status, 403);
    const badJson = await read(await hub.fetch(new Request("https://relay.example/admin/cmd", {
      method: "POST", headers: { authorization: "Bearer " + PASSPHRASE }, body: "{DEVICE_SECRET_SYNTHETIC",
    })));
    assert.deepEqual(badJson, { status: 400, data: { error: "bad_json" } });
    const logs = [], originalError = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    try {
      const stream = new ReadableStream({ start(controller) { controller.error(new Error("DEVICE_SECRET_SYNTHETIC")); } });
      assert.equal((await hub.fetch(streamingRequest("/admin/cmd", stream, true))).status, 500);
      assert.ok(logs.length); assert.ok(logs.every((message) => !message.includes("DEVICE_SECRET_SYNTHETIC")));
    } finally { console.error = originalError; }
  });

  test("the edge rejects unauthenticated admin headers before waking the hub or touching an incomplete body", async () => {
    const asleep = bomb(), env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE), HUB: asleep };
    const incomplete = { url: "https://relay.example/admin/cmd", method: "POST", headers: new Headers({ "content-length": String(100 * 1024 * 1024) }), get body() { throw new Error("read unauthenticated edge body"); } };
    assert.deepEqual(await read(await worker.fetch(incomplete, env)), { status: 401, data: { error: "missing_auth" } });
    incomplete.headers.set("authorization", "Bearer wrong");
    assert.deepEqual(await read(await worker.fetch(incomplete, env)), { status: 403, data: { error: "bad_auth" } });
    assert.equal(asleep.calls, 0);
  });

  test("streamed byte limits cancel early, while a stalled result read times out and releases its slot", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    let cancelled = false, sent = 0;
    const oversized = new ReadableStream({
      pull(controller) { sent++; controller.enqueue(new Uint8Array(16 * 1024).fill(65)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const rejected = await read(await hub.fetch(streamingRequest("/admin/cmd", oversized, true)));
    assert.deepEqual(rejected, { status: 413, data: { error: "body_too_large" } });
    assert.ok(cancelled); assert.ok(sent <= 5);
    const { token } = await pairAndRegister(hub, "A"), id = await enqueue(hub, token);
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => originalTimeout(fn, delay === 15_000 ? 20 : delay, ...args);
    try {
      const unfinished = new ReadableStream({ cancel() { cancelled = true; } });
      const first = hub.fetch(streamingRequest("/result", unfinished));
      assert.equal((await hub.fetch(post("/result", { token, id, ok: true }))).status, 429);
      assert.deepEqual(await read(await first), { status: 408, data: { error: "body_timeout" } });
      assert.equal(hub.bodyReaders, 0); assert.equal(hub.resultBodyReaders, 0); assert.equal(hub.legacyResultBodyReaders, 0);
      assert.equal((await hub.fetch(post("/result", { token, id, ok: true }))).status, 200);
    } finally { globalThis.setTimeout = originalTimeout; }
  });

  test("anonymous slow uploads cannot starve verified HTTP or WebSocket results", async () => {
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE) };
    const { hub, ctx } = await bootHub(env);
    env.HUB = { idFromName() { return "juno-bridge"; }, get() { return hub; } };
    const { token } = await pairAndRegister(hub, "A");
    const httpId = await enqueue(hub, token, "req_protected_http");
    const socketId = await enqueue(hub, token, "req_protected_socket");
    assert.equal((await worker.fetch(await authWsReq(hub, token), env)).status, 101);
    const server = ctx.sockets.at(-1);
    await hub.webSocketMessage(server, JSON.stringify({ type: "hello", after: 0 }));

    let resultController;
    const slowResult = new ReadableStream({ start(controller) { resultController = controller; } });
    const stalledResult = worker.fetch(streamingRequest("/result", slowResult), env);
    const pollControllers = [];
    const stalledPolls = Array.from({ length: 8 }, () => {
      const stream = new ReadableStream({ start(controller) { pollControllers.push(controller); } });
      return worker.fetch(streamingRequest("/poll", stream), env);
    });
    const started = Date.now();
    while ((hub.legacyResultBodyReaders !== 1 || hub.bodyReaders !== 8) && Date.now() - started < 1000) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(hub.legacyResultBodyReaders, 1);
    assert.equal(hub.bodyReaders, 8);
    assert.equal(hub.postRequests, 8);
    assert.equal(hub.resultBodyReaders, 0);

    const preflight = await worker.fetch(new Request("https://relay.example/result", {
      method: "OPTIONS", headers: { origin: EXTENSION_ORIGIN },
    }), env);
    assert.match(preflight.headers.get("access-control-allow-headers"), /x-juno-device-token/);
    const invalid = {
      url: "https://relay.example/result", method: "POST",
      headers: new Headers({ "x-juno-device-token": "f".repeat(64) }),
      get body() { throw new Error("read invalid token body"); },
    };
    assert.deepEqual(await read(await worker.fetch(invalid, env)), { status: 403, data: { error: "unknown_device" } });

    let verifiedController;
    const verifiedStream = new ReadableStream({ start(controller) { verifiedController = controller; } });
    const verifiedRequest = streamingRequest("/result", verifiedStream);
    verifiedRequest.headers.set("x-juno-device-token", token);
    verifiedRequest.headers.set("origin", EXTENSION_ORIGIN);
    const stalledVerified = worker.fetch(verifiedRequest, env);
    while (hub.resultBodyReaders !== 1 && Date.now() - started < 1000) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(hub.resultBodyReaders, 1);
    await hub.webSocketMessage(server, JSON.stringify({ type: "result", id: socketId, ok: true }));
    assert.equal(server.closed, null);
    assert.ok(server.sent.some((message) => {
      const parsed = JSON.parse(message);
      return parsed.type === "result_ack" && parsed.id === socketId;
    }));
    assert.equal(hub.owners.get(socketId).done, true);
    verifiedController.close();
    assert.deepEqual(await read(await stalledVerified), { status: 401, data: { error: "missing_device_token" } });
    assert.equal(hub.resultBodyReaders, 0);

    const completed = post("/result", { token, id: httpId, ok: true, data: { protected: true } });
    completed.headers.set("x-juno-device-token", token);
    completed.headers.set("origin", EXTENSION_ORIGIN);
    assert.deepEqual(await read(await worker.fetch(completed, env)), { status: 200, data: { ok: true } });
    assert.equal(hub.owners.get(httpId).done, true);
    assert.equal(hub.resultBodyReaders, 0);
    assert.equal(hub.legacyResultBodyReaders, 1);
    resultController.close();
    for (const controller of pollControllers) controller.close();
    assert.deepEqual(await read(await stalledResult), { status: 401, data: { error: "missing_device_token" } });
    for (const response of await Promise.all(stalledPolls)) {
      assert.deepEqual(await read(response), { status: 401, data: { error: "missing_device_token" } });
    }
    assert.equal(hub.legacyResultBodyReaders, 0);
    assert.equal(hub.bodyReaders, 0);
    assert.equal(hub.postRequests, 0);
    assert.equal(hub.resultCommitters, 0);
  });

  test("a result header must match the body token", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token: first } = await pairAndRegister(hub, "A");
    const { token: second } = await pairAndRegister(hub, "B");
    const id = await enqueue(hub, second, "req_header_mismatch");
    const request = post("/result", { token: second, id, ok: true });
    request.headers.set("x-juno-device-token", first);
    assert.deepEqual(await read(await hub.fetch(request)), { status: 403, data: { error: "token_mismatch" } });
    assert.equal(hub.owners.get(id).done, false);
    assert.equal(hub.resultBodyReaders, 0);
    assert.equal((await hub.fetch(post("/result", { token: second, id, ok: true }))).status, 200);
  });

  test("one paired device's stalled result upload does not block another device", async () => {
    const { hub, ctx } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token: first } = await pairAndRegister(hub, "A");
    const { token: second } = await pairAndRegister(hub, "B");
    const { token: third } = await pairAndRegister(hub, "C");
    const secondId = await enqueue(hub, second, "req_device_b_result");
    const thirdId = await enqueue(hub, third, "req_device_c_result");
    const startUpload = (token) => {
      let controller;
      const stream = new ReadableStream({ start(value) { controller = value; } });
      const request = streamingRequest("/result", stream);
      request.headers.set("x-juno-device-token", token);
      return { controller, response: hub.fetch(request) };
    };
    const slowFirst = startUpload(first);
    assert.equal(hub.resultBodyReaders, 1);
    const result = post("/result", { token: second, id: secondId, ok: true });
    result.headers.set("x-juno-device-token", second);
    assert.deepEqual(await read(await hub.fetch(result)), { status: 200, data: { ok: true } });
    assert.equal(hub.owners.get(secondId).done, true);
    assert.equal(hub.resultBodyReaders, 1);

    const duplicateFirst = post("/result", { token: first, id: secondId, ok: true });
    duplicateFirst.headers.set("x-juno-device-token", first);
    assert.deepEqual(await read(await hub.fetch(duplicateFirst)), { status: 429, data: { error: "too_many_body_readers" } });
    const slowSecond = startUpload(second);
    assert.equal(hub.resultBodyReaders, 2);
    assert.deepEqual([...hub.resultBodyReaderTokens].sort(), [first, second].sort());
    // A third verified upload gets a retryable 429; the socket path remains available.
    const limitedThird = post("/result", { token: third, id: thirdId, ok: true });
    limitedThird.headers.set("x-juno-device-token", third);
    assert.deepEqual(await read(await hub.fetch(limitedThird)), { status: 429, data: { error: "too_many_body_readers" } });
    await hub.fetch(await authWsReq(hub, third));
    const server = ctx.sockets.at(-1);
    await hub.webSocketMessage(server, JSON.stringify({ type: "hello", after: 0 }));
    await hub.webSocketMessage(server, JSON.stringify({ type: "result", id: thirdId, ok: true }));
    assert.equal(server.closed, null);
    assert.ok(server.sent.some((message) => {
      const parsed = JSON.parse(message);
      return parsed.type === "result_ack" && parsed.id === thirdId;
    }));
    slowFirst.controller.close();
    slowSecond.controller.close();
    assert.deepEqual(await read(await slowFirst.response), { status: 401, data: { error: "missing_device_token" } });
    assert.deepEqual(await read(await slowSecond.response), { status: 401, data: { error: "missing_device_token" } });
    assert.equal(hub.resultBodyReaders, 0);
    assert.equal(hub.resultBodyReaderTokens.size, 0);
    assert.equal(hub.resultCommitters, 0);
  });

  test("failed enqueue transaction creates neither ownership nor an idempotency receipt", async () => {
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }, storage = new StrictStorage();
    const { hub } = await bootHub(env, storage), { token } = await pairAndRegister(hub, "A");
    storage.failPut = (key) => key.startsWith("idem:");
    const originalError = console.error; console.error = () => {};
    try {
      const failed = await read(await hub.fetch(admin("/admin/cmd", { method: "POST", body: { action: "ping", device: token, request_id: "req_failed_01" } })));
      assert.equal(failed.status, 500);
    } finally { console.error = originalError; }
    assert.equal(hub.owners.size, 0); assert.equal(hub.idem.size, 0); assert.equal(hub.pending(token).length, 0);
    assert.equal([...storage.data.keys()].some((key) => /^(own:|idem:|queue:)/.test(key)), false);
    const restarted = await bootHub(env, storage);
    const id = await enqueue(restarted.hub, token, "req_failed_01");
    assert.equal(restarted.hub.owners.has(id), true); assert.equal(restarted.hub.pending(token).length, 1);
  });

  test("a failed chunk commit emits no done receipt or socket ack, and retry survives restart", async () => {
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }, storage = new StrictStorage();
    const { hub, ctx } = await bootHub(env, storage), { token } = await pairAndRegister(hub, "A");
    await hub.fetch(await authWsReq(hub, token));
    const server = ctx.sockets[0]; await hub.webSocketMessage(server, JSON.stringify({ type: "hello", after: 0 }));
    const id = await enqueue(hub, token), data = { image: "x".repeat(400_000) };
    storage.failPut = (key) => key === `chunk:${id}:2`;
    await assert.rejects(hub.webSocketMessage(server, JSON.stringify({ type: "result", id, ok: true, data })), /injected write failure/);
    assert.equal(server.sent.some((message) => JSON.parse(message).type === "result_ack"), false);
    assert.equal(hub.owners.get(id).done, false); assert.equal(hub.payloads.size, 0);
    assert.equal([...storage.data.keys()].some((key) => key.startsWith("chunk:")), false);
    const restarted = await bootHub(env, storage);
    assert.equal(restarted.hub.owners.get(id).done, false);
    assert.equal((await restarted.hub.fetch(post("/result", { token, id, ok: true, data }))).status, 200);
    const result = await read(await restarted.hub.fetch(admin(`/admin/result?id=${id}&wait=0`)));
    assert.equal(result.data.result.data.image, data.image);
  });

  test("large screenshots and replay share durable chunks across restart, consumption and revocation", async () => {
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }, storage = new StrictStorage();
    let { hub } = await bootHub(env, storage);
    const { token } = await pairAndRegister(hub, "A"), requestId = "req_large_01", id = await enqueue(hub, token, requestId);
    const data = { image: "x".repeat(1_200_000) };
    assert.equal((await hub.fetch(post("/result", { token, id, ok: true, data }))).status, 200);
    assert.ok(hub.payloads.get(id).chunks > 10);
    assert.equal(storage.data.get("res:" + id).record, undefined);
    assert.equal(storage.data.get(`idem:${token}:${requestId}`).result, undefined);
    assert.equal(storage.data.get(`idem:${token}:${requestId}`).resultId, id);
    ({ hub } = await bootHub(env, storage));
    const primary = await read(await hub.fetch(admin(`/admin/result?id=${id}&wait=0`)));
    assert.equal(primary.data.result.data.image, data.image);
    ({ hub } = await bootHub(env, storage));
    const replay = await read(await hub.fetch(admin("/admin/run", { method: "POST", body: { action: "ping", device: token, request_id: requestId, wait: 0 } })));
    assert.equal(replay.data.result.data.image, data.image); assert.equal(replay.data.duplicate, true);
    assert.equal((await read(await hub.fetch(admin(`/admin/result?id=${id}&wait=0`)))).data.pending, true);
    const owner = { ...hub.owners.get(id), expires: Date.now() - 1 }; hub.owners.set(id, owner); await storage.put("own:" + id, owner);
    await hub.alarm(); assert.equal(hub.owners.has(id), false);
    await hub.removeDevice(token);
    assert.equal([...storage.data.keys()].some((key) => /^(res:|payload:|chunk:|idem:|own:)/.test(key)), false);
    for (const options of storage.listLimits) if (/^(res:|idem:|queue:)$/.test(options.prefix)) assert.equal(options.limit, 1);
  });

  test("UTF8 result size produces a durable explicit failure, and websocket UTF8 limits apply before JSON parse", async () => {
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }, { hub, ctx } = await bootHub(env);
    const { token } = await pairAndRegister(hub, "A"), id = await enqueue(hub, token);
    // Fits the10MiB upload bound in bytes, but exceeds the8MiB retained record.
    assert.equal((await hub.fetch(post("/result", { token, id, ok: true, data: "😀".repeat(2_100_000) }))).status, 200);
    const failed = await read(await hub.fetch(admin(`/admin/result?id=${id}&wait=0`)));
    assert.equal(failed.data.result.ok, false); assert.equal(failed.data.result.error, "result_too_large");
    assert.equal(hub.owners.get(id).done, true);
    await hub.fetch(await authWsReq(hub, token)); const server = ctx.sockets[0];
    await hub.webSocketMessage(server, "😀".repeat(240_000));
    assert.deepEqual(server.closed, { code: 1009, reason: "message_too_large" });
    const huge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); } });
    assert.equal((await hub.fetch(streamingRequest("/result", huge))).status, 413);
  });

  test("a failed KV import remains retryable and does not publish partial devices", async () => {
    const a = "a".repeat(64), b = "b".repeat(64), storage = new MemoryStorage();
    let fail = true;
    const kv = { async get(key) {
      if (key === "cfg:admin_hash") return "c".repeat(64);
      if (key === "devices:index") return [a, b];
      if (key === "device:" + b && fail) throw new Error("KV read unavailable");
      return { name: "imported", created: 1 };
    } };
    const env = { ADMIN_PSK_SHA256: await sha256(PASSPHRASE), BRIDGE: kv };
    await assert.rejects(bootHub(env, storage), /KV read unavailable/);
    assert.equal(storage.data.has("migrated"), false); assert.equal(storage.data.has("devices"), false);
    fail = false;
    const { hub } = await bootHub(env, storage);
    assert.equal(hub.devices.size, 2); assert.equal(storage.data.get("migrated"), true);
    assert.equal((await hub.fetch(admin("/admin/ping"))).status, 200);
  });

  test("startup removes expired legacy state before caps and never deletes more than128 keys", async () => {
    const storage = new StrictStorage(), token = "a".repeat(64), now = Date.now();
    await storage.put({ devices: new Map([[token, { name: "A" }]]), order: [token], migrated: true, pairs: new Map(Array.from({ length: 65 }, (_, i) => ["expired" + i, now - 1])) });
    for (let i = 0; i < 1001; i++) {
      const id = "cmd_" + i.toString(16).padStart(16, "0"), cmd = { id, seq: i, action: "ping", params: {}, issued_at: now - 700_000 };
      await storage.put("own:" + id, { token, expires: now - 1, done: false });
      await storage.put(`idem:${token}:req_expired_${i}`, { cmd, expires: now - 1, result: { ok: true } });
      await storage.put("res:" + id, { record: "{}", expires: now - 1 });
      await storage.put("ticket:" + i.toString(16).padStart(64, "0"), { token, expires: now - 1 });
    }
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }, storage);
    assert.equal(hub.owners.size, 0); assert.equal(hub.idem.size, 0); assert.equal(hub.results.size, 0); assert.equal(hub.tickets.size, 0); assert.equal(hub.pairs.size, 0);
    assert.equal([...storage.data.keys()].some((key) => /^(own:|idem:|res:|ticket:)/.test(key)), false);
    assert.ok(storage.deleteSizes.includes(128)); assert.ok(storage.deleteSizes.every((size) => size <= 128));
  });

  test("legacy queue ownership and raw result/replay migrate compatibly; lost old payloads fail explicitly", async () => {
    const storage = new StrictStorage(), token = "a".repeat(64), now = Date.now(), id = "cmd_0000000000000001", missingId = "cmd_0000000000000002";
    const cmd = { id, seq: now, action: "ping", params: {}, issued_at: now };
    const result = { ok: true, data: { legacy: true }, error: null, finished_at: now };
    await storage.put({ devices: new Map([[token, { name: "A" }]]), order: [token], migrated: true,
      ["queue:" + token]: { last: now, items: [cmd] },
      ["res:" + id]: { record: JSON.stringify(result), expires: now + 60_000 },
      [`idem:${token}:req_legacy_01`]: { cmd, result, expires: now + 60_000 },
      ["own:" + missingId]: { token, expires: now + 60_000, done: true },
    });
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }, storage);
    assert.equal(hub.owners.get(id).token, token); assert.equal(hub.payloads.get(id).token, token);
    assert.equal((await read(await hub.fetch(admin(`/admin/result?id=${id}&wait=0`)))).data.result.data.legacy, true);
    assert.equal((await read(await hub.fetch(admin(`/admin/result?id=${missingId}&wait=0`)))).data.result.error, "result_unavailable_after_upgrade");
    await hub.removeDevice(token); assert.equal(hub.payloads.size, 0);
    assert.equal([...storage.data.keys()].some((key) => key.startsWith("chunk:")), false);
  });

  test("TTL cleanup preserves an already-started stream until completion, cancellation releases its pin", async () => {
    const { hub, storage } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A"), id = await enqueue(hub, token), data = "x".repeat(300_000);
    await hub.acceptResult(token, id, { ok: true, data });
    const response = await hub.resultResponse({ pending: false }, { id, consume: true }, {});
    const reader = response.body.getReader(), first = await reader.read();
    const meta = { ...hub.payloads.get(id), expires: Date.now() - 1 }; hub.payloads.set(id, meta); await storage.put("payload:" + id, meta);
    await hub.alarm(); assert.equal(hub.payloads.has(id), true);
    const chunks = [first.value];
    while (true) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); }
    assert.equal(JSON.parse(Buffer.concat(chunks)).result.data, data); assert.equal(hub.resultStreams, 0); assert.equal(hub.resultPins.size, 0);
    await hub.alarm(); assert.equal(hub.payloads.has(id), false);
    const another = await enqueue(hub, token, "req_cancel_01"); await hub.acceptResult(token, another, { ok: true });
    const cancelled = await hub.resultResponse({}, { id: another, consume: false }, {});
    assert.equal(hub.resultStreams, 1); await cancelled.body.cancel();
    assert.equal(hub.resultStreams, 0); assert.equal(hub.resultPins.size, 0);
  });

  test("alarm and revocation wake long polls, and unknown commands allocate no waiter", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) });
    const { token } = await pairAndRegister(hub, "A"), id = await enqueue(hub, token);
    const primary = hub.waitForResult(id, 30), replay = hub.waitForIdem(token + ":req_audit_01", 30);
    await Promise.resolve(); assert.equal(hub.waiterCount, 2);
    const unknown = await read(await hub.fetch(admin("/admin/result?id=cmd_ffffffffffffffff&wait=60")));
    assert.equal(unknown.status, 404); assert.equal(hub.waiterCount, 2);
    await hub.removeDevice(token); assert.deepEqual(await Promise.all([primary, replay]), [null, null]); assert.equal(hub.waiterCount, 0);
    const { token: next } = await pairAndRegister(hub, "B"), expiring = await enqueue(hub, next, "req_expiry_01");
    const waiting = hub.waitForResult(expiring, 30); hub.owners.get(expiring).expires = Date.now() - 1;
    await hub.alarm(); assert.equal(await waiting, null); assert.equal(hub.waiterCount, 0);
  });

  test("legacy revoked results are deleted before bounded admission, including blobs without a token", async () => {
    const storage = new StrictStorage(), revoked = "a".repeat(64), expires = Date.now() + 60_000;
    await storage.put({ devices: new Map(), order: [], migrated: true });
    for (let i = 0; i < 129; i++) {
      const id = "cmd_" + i.toString(16).padStart(16, "0");
      await storage.put("own:" + id, { token: revoked, expires, done: true });
      await storage.put("res:" + id, { record: '{"ok":true}', expires });
    }
    const blobId = "cmd_ffffffffffffffff";
    await storage.put({ ["own:" + blobId]: { token: revoked, expires, done: true },
      ["res:" + blobId]: { expires }, ["payload:" + blobId]: { bytes: 11, chunks: 1, expires, token: null },
      [`chunk:${blobId}:0`]: new TextEncoder().encode('{"ok":true}'),
    });
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }, storage);
    assert.equal(hub.owners.size, 0); assert.equal(hub.payloads.size, 0); assert.equal(hub.results.size, 0);
    assert.equal([...storage.data.keys()].some((key) => /^(own:|res:|payload:|chunk:)/.test(key)), false);
  });

  test("aggregate queue and waiter caps reject work without adding an execution", async () => {
    const { hub } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }), { token } = await pairAndRegister(hub, "A");
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      const res = await read(await hub.fetch(admin("/admin/cmd", { method: "POST", body: { action: "ping", device: token, params: { text: "x".repeat(60_000) }, request_id: "req_bound_" + i } })));
      if (res.status === 429) { assert.equal(res.data.error, "queue_full"); assert.equal(hub.idem.has(token + ":req_bound_" + i), false); break; }
      assert.equal(res.status, 200); accepted++;
    }
    assert.ok(accepted > 1 && accepted < 100); assert.ok(hub.queueBytes() <= 1024 * 1024);
    assert.equal(hub.owners.size, accepted); assert.equal(hub.pending(token).length, accepted);
    const id = hub.pending(token)[0].id;
    const waiters = Array.from({ length: 256 }, () => hub.waitForResult(id, 30));
    assert.equal(hub.waiterCount, 256);
    const limited = await read(await hub.fetch(admin(`/admin/result?id=${id}&wait=30`)));
    assert.deepEqual(limited, { status: 429, data: { error: "too_many_waiters" } });
    await hub.removeDevice(token); await Promise.all(waiters); assert.equal(hub.waiterCount, 0);
  });

  test("bounded request admissions release before long polling, with a separate result completion slot", async () => {
    const { hub, ctx } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }), { token } = await pairAndRegister(hub, "A");
    const controllers = [], reads = Array.from({ length: 8 }, () => {
      const stream = new ReadableStream({ start(controller) { controllers.push(controller); } });
      return hub.fetch(streamingRequest("/admin/ping", stream, true));
    });
    const started = Date.now();
    while (hub.bodyReaders < 8 && Date.now() - started < 1000) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hub.bodyReaders, 8); assert.equal(hub.postRequests, 8);
    assert.equal((await hub.fetch(post("/poll", { token, after: 0 }))).status, 429);
    for (const controller of controllers) controller.close(); await Promise.all(reads);
    assert.equal(hub.bodyReaders, 0); assert.equal(hub.postRequests, 0);
    const pendingRun = hub.fetch(admin("/admin/run", { method: "POST", body: { action: "ping", device: token, request_id: "req_waitslot_01", wait: 30 } }));
    while (!hub.waiterCount) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hub.postRequests, 0);
    const polled = await read(await hub.fetch(post("/poll", { token, after: 0 })));
    assert.equal(polled.status, 200);
    await hub.fetch(await authWsReq(hub, token)); const server = ctx.sockets[0];
    await hub.webSocketMessage(server, JSON.stringify({ type: "hello", after: 0 }));
    // A busy commit slot defers another result; an incomplete HTTP body does not.
    hub.resultCommitters = 1;
    await hub.webSocketMessage(server, JSON.stringify({ type: "result", id: polled.data.cmd.id, ok: true }));
    assert.deepEqual(server.closed, { code: 1013, reason: "result_busy" });
    assert.equal(hub.owners.get(polled.data.cmd.id).done, false);
    hub.resultCommitters = 0;
    assert.equal((await hub.fetch(post("/result", { token, id: polled.data.cmd.id, ok: true }))).status, 200);
    assert.equal((await read(await pendingRun)).data.result.ok, true);
    assert.equal(hub.postRequests, 0); assert.equal(hub.resultBodyReaders, 0); assert.equal(hub.resultCommitters, 0);
  });

  test("stream concurrency is bounded and every completion, cancellation or read failure releases capacity", async () => {
    const { hub, storage } = await bootHub({ ADMIN_PSK_SHA256: await sha256(PASSPHRASE) }), { token } = await pairAndRegister(hub, "A"), id = await enqueue(hub, token);
    await hub.acceptResult(token, id, { ok: true, data: "x".repeat(300_000) });
    const responses = [];
    for (let i = 0; i < 16; i++) responses.push(await hub.resultResponse({}, { id, consume: false }, {}));
    await assert.rejects(hub.resultResponse({}, { id, consume: false }, {}), (error) => error.message === "too_many_result_readers" && error.status === 429);
    await Promise.all(responses.map((r) => r.body.cancel()));
    assert.equal(hub.resultStreams, 0); assert.equal(hub.resultPins.size, 0);
    const broken = await hub.resultResponse({}, { id, consume: false }, {});
    await storage.delete(`chunk:${id}:1`);
    await assert.rejects(broken.text(), /missing durable result chunk/);
    assert.equal(hub.resultStreams, 0); assert.equal(hub.resultPins.size, 0);
  });
});
