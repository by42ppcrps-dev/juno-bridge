// Mock checks for the relay. They do not deploy to Cloudflare.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import worker, { BridgeHub } from "../relay/worker.js";

const PASSPHRASE = "correct-horse-battery";

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

  async list({ prefix } = {}) {
    const out = new Map();
    for (const [key, value] of this.data) {
      if (prefix && !key.startsWith(prefix)) continue;
      out.set(key, structuredClone(value));
    }
    return out;
  }
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

function wsReq(origin) {
  const headers = { upgrade: "websocket" };
  if (origin !== undefined) headers.origin = origin;
  return new Request("https://relay.example/ws", { headers });
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

    const opened = await read(await hub.fetch(wsReq("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef")));
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
    const web = await read(await hub.fetch(wsReq("https://evil.example")));
    assert.equal(web.status, 403);
    assert.equal(web.data.error, "forbidden_origin");
    const extension = await read(await hub.fetch(wsReq("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef")));
    assert.equal(extension.status, 101);
    const omitted = await read(await hub.fetch(wsReq()));
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
      const opened = await hub.fetch(wsReq("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef"));
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
    assert.equal(stillPending.data.pending, true);

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

    const opened = await read(await hub.fetch(wsReq("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef")));
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

    const other = await read(await hub.fetch(wsReq("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef")));
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

    const opened = await read(await hub.fetch(wsReq("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef")));
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

    const again = await read(await hub.fetch(wsReq("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef")));
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
});
