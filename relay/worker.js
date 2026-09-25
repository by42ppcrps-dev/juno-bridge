/* Juno Bridge relay — Cloudflare Worker + one Durable Object.
 *
 * Message bus between the Juno driver CLI and the Chrome extension. Built for fast, reliable control:
 *
 * - All state lives in ONE Durable Object (BridgeHub). A Durable Object is a
 *   single strongly-consistent instance, so a command is visible the instant
 *   it's enqueued — no KV propagation delay between Cloudflare locations.
 * - The extension holds a WebSocket to the hub; commands are PUSHED to it the
 *   moment the driver enqueues them. The socket uses the hibernation API and
 *   an auto-responded "ping", so an idle connection costs almost nothing.
 * - The driver gets results the moment they land: /admin/result waits (up to
 *   `wait` seconds, default 10) instead of answering "pending", and
 *   /admin/run enqueues + waits in a single request.
 * - HTTP /poll + /result remain as a fallback for the extension (older
 *   versions, or networks that block WebSockets).
 *
 * Auth:
 * - Admin: Authorization: Bearer <psk>. Only SHA-256(psk) is stored: either
 *   the ADMIN_PSK_SHA256 secret, or a value set once via POST /admin/bootstrap.
 * - Device: per-device token issued at registration. It travels only in a
 *   POST body or the first WebSocket message — never in a URL.
 *
 * Delivery is at-most-once per command: each has a monotonically increasing
 * `seq`; the extension records the highest seq it has taken BEFORE running it
 * and acknowledges it. Unacknowledged commands are re-sent on reconnect, and
 * the extension skips anything at or below its cursor.
 *
 * Migration: on first boot, if the old KV namespace is still bound as BRIDGE,
 * the admin hash and paired devices are imported so nothing needs re-pairing.
 */

const enc = new TextEncoder();

const PAIR_TTL_MS = 600_000;
const QUEUE_KEEP_MS = 180_000; // the extension refuses commands older than 2 min anyway
const QUEUE_MAX = 100;
const RESULT_TTL_MS = 600_000;
const RESULT_PERSIST_MAX = 1_000_000; // Durable Object storage values cap at 2 MB
const MAX_RESULT_BYTES = 20 * 1024 * 1024;
const RESULT_WAIT_DEFAULT_S = 10;
const RUN_WAIT_DEFAULT_S = 30;
const WAIT_MAX_S = 60;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_SOCKETS = 16;
const NAME_MAX = 64;

const PAIR_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIR_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const CMD_ID_RE = /^cmd_[0-9a-f]{16}$/;

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function pairCode() {
  // 8 unambiguous chars, human-typable. Rejection sampling keeps every
  // character equally likely (plain `% 31` over a byte favours the first 8).
  const limit = 256 - (256 % PAIR_ALPHA.length);
  let out = "";
  while (out.length < 8) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    for (const x of b) {
      if (x < limit && out.length < 8) out += PAIR_ALPHA[x % PAIR_ALPHA.length];
    }
  }
  return out;
}

function normalizePairCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// CORS is only meaningful for the extension (a browser). Admin endpoints are
// curl-only and get no CORS headers at all. Only extension origins are
// reflected, so ordinary web pages can't script the device endpoints.
const DEVICE_PATHS = new Set(["/register", "/poll", "/result", "/unregister"]);

function corsHeaders(path, origin) {
  if (!DEVICE_PATHS.has(path)) return {};
  if (!origin || !origin.startsWith("chrome-extension://")) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function bearer(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Constant-time string compare (no timingSafeEqual in Workers runtime).
function ctEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientIp(req) {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for") ||
    "unknown"
  ).split(",")[0].trim().slice(0, 45);
}

function waitSeconds(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), WAIT_MAX_S) : fallback;
}

/* ---------- entry point: thin front door, everything else in the hub ---------- */

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    const origin = req.headers.get("origin");
    try {
      if (path === "/") return jsonResponse({ service: "juno-bridge", ok: true });
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(path, origin) });
      }
      // Optional: bind a Rate Limiting API binding named REGISTER_LIMITER for
      // a per-IP limit on pairing attempts.
      if (path === "/register" && env.REGISTER_LIMITER) {
        const { success } = await env.REGISTER_LIMITER.limit({ key: clientIp(req) });
        if (!success) return jsonResponse({ error: "rate_limited" }, 429, corsHeaders(path, origin));
      }
      const hub = env.HUB.get(env.HUB.idFromName("juno-bridge"));
      return await hub.fetch(req);
    } catch (e) {
      console.error("juno-bridge:", path, e && e.stack ? e.stack : e);
      return jsonResponse({ error: "relay_unavailable" }, 503, corsHeaders(path, origin));
    }
  },
};

/* ---------- the hub ---------- */

export class BridgeHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.waiters = new Map(); // cmd id → Set of wake-up functions (in-flight /admin/result waits)
    // The runtime answers the extension's keepalive without waking the hub.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(() => this.load());
  }

  /* ----- state ----- */

  async load() {
    const s = this.ctx.storage;
    const reg = await s.get(["admin_hash", "devices", "order", "pairs", "migrated"]);
    this.adminHash = reg.get("admin_hash") || null;
    this.devices = reg.get("devices") || new Map(); // token → { name, created }
    this.order = reg.get("order") || []; // tokens, oldest first; last is "default"
    this.pairs = reg.get("pairs") || new Map(); // code → expiresAt
    if (!reg.get("migrated")) await this.importFromKv();
    this.queues = new Map(); // token → { last, items: [cmd] }
    for (const [k, v] of await s.list({ prefix: "queue:" })) this.queues.set(k.slice(6), v);
    this.results = new Map(); // id → { record: string, expires }
    for (const [k, v] of await s.list({ prefix: "res:" })) this.results.set(k.slice(4), v);
  }

  async importFromKv() {
    const kv = this.env.BRIDGE;
    if (kv) {
      try {
        const h = await kv.get("cfg:admin_hash");
        if (h && !this.adminHash) this.adminHash = h;
        for (const t of (await kv.get("devices:index", "json")) || []) {
          if (!TOKEN_RE.test(t) || this.devices.has(t)) continue;
          const d = await kv.get("device:" + t, "json");
          if (!d) continue;
          this.devices.set(t, { name: d.name || "chrome", created: d.created || Date.now() });
          this.order.push(t);
        }
      } catch (e) {
        console.error("juno-bridge: KV import failed; will retry on next boot", e);
        return;
      }
    }
    await this.saveRegistry();
  }

  async saveRegistry() {
    await this.ctx.storage.put({
      admin_hash: this.adminHash,
      devices: this.devices,
      order: this.order,
      pairs: this.pairs,
      migrated: true,
    });
  }

  adminHashValue() {
    if (this.env.ADMIN_PSK_SHA256) return String(this.env.ADMIN_PSK_SHA256).trim().toLowerCase();
    return this.adminHash;
  }

  // "default"/absent → most recently registered device; a full token; or a
  // unique prefix of at least 8 chars (as /admin/devices shows).
  resolveDevice(selector) {
    if (!selector || selector === "default") {
      return this.order.length ? { token: this.order[this.order.length - 1] } : { error: "no_device", status: 404 };
    }
    if (typeof selector !== "string") return { error: "bad_device", status: 400 };
    const sel = selector.trim().toLowerCase().replace(/…$/, "");
    if (TOKEN_RE.test(sel)) return this.devices.has(sel) ? { token: sel } : { error: "no_device", status: 404 };
    if (sel.length < 8) return { error: "device_prefix_too_short", status: 400 };
    const hits = this.order.filter((t) => t.startsWith(sel));
    if (hits.length > 1) return { error: "ambiguous_device", status: 409 };
    return hits.length ? { token: hits[0] } : { error: "no_device", status: 404 };
  }

  async removeDevice(token) {
    this.devices.delete(token);
    this.order = this.order.filter((t) => t !== token);
    this.queues.delete(token);
    await this.ctx.storage.delete("queue:" + token);
    await this.saveRegistry();
    for (const ws of this.socketsFor(token)) {
      try {
        ws.close(4003, "revoked");
      } catch {
        /* already closed */
      }
    }
  }

  /* ----- queue ----- */

  // Unacknowledged commands for a device, minus any too old to run.
  pending(token) {
    const q = this.queues.get(token);
    if (!q) return [];
    const now = Date.now();
    return q.items.filter((c) => now - c.issued_at < QUEUE_KEEP_MS);
  }

  async saveQueue(token, q) {
    this.queues.set(token, q);
    await this.ctx.storage.put("queue:" + token, q);
  }

  async enqueue(token, action, params) {
    const q = this.queues.get(token) || { last: 0, items: [] };
    const items = this.pending(token);
    if (items.length >= QUEUE_MAX) return null;
    const now = Date.now();
    const cmd = {
      id: "cmd_" + randHex(8),
      seq: Math.max(now, q.last + 1),
      action,
      params: params && typeof params === "object" ? params : {},
      issued_at: now,
    };
    items.push(cmd);
    await this.saveQueue(token, { last: cmd.seq, items });
    this.push(token, [cmd]);
    return cmd;
  }

  // The extension has taken everything up to `seq`.
  async ack(token, seq) {
    const q = this.queues.get(token);
    if (!q) return;
    const items = q.items.filter((c) => c.seq > seq);
    if (items.length !== q.items.length) await this.saveQueue(token, { last: q.last, items });
  }

  /* ----- results ----- */

  async storeResult(id, body) {
    let record = JSON.stringify({
      ok: !!body.ok,
      data: body.data ?? null,
      error: body.error == null ? null : String(body.error).slice(0, 1000),
      finished_at: Date.now(),
    });
    if (record.length > MAX_RESULT_BYTES) {
      record = JSON.stringify({ ok: false, data: null, error: "result_too_large", finished_at: Date.now() });
    }
    const entry = { record, expires: Date.now() + RESULT_TTL_MS };
    this.results.set(id, entry);
    const waiting = this.waiters.get(id);
    if (waiting) {
      this.waiters.delete(id);
      for (const wake of waiting) wake();
    }
    // Big results (screenshots) live in memory only; a waiting driver takes
    // them immediately, so persisting them would only cost storage writes.
    if (record.length <= RESULT_PERSIST_MAX) await this.ctx.storage.put("res:" + id, entry);
    await this.purgeResults();
  }

  async purgeResults() {
    const now = Date.now();
    const dead = [];
    for (const [id, r] of this.results) if (r.expires < now) dead.push(id);
    for (const id of dead) this.results.delete(id);
    if (dead.length) await this.ctx.storage.delete(dead.map((id) => "res:" + id));
  }

  async takeResult(id) {
    const r = this.results.get(id);
    if (!r) return null;
    this.results.delete(id);
    await this.ctx.storage.delete("res:" + id);
    return r.expires < Date.now() ? null : JSON.parse(r.record);
  }

  async waitForResult(id, seconds) {
    if (!this.results.has(id) && seconds > 0) {
      await new Promise((resolve) => {
        const set = this.waiters.get(id) || new Set();
        this.waiters.set(id, set);
        const timer = setTimeout(() => {
          set.delete(wake);
          if (!set.size && this.waiters.get(id) === set) this.waiters.delete(id);
          resolve();
        }, seconds * 1000);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        set.add(wake);
      });
    }
    return await this.takeResult(id);
  }

  /* ----- sockets ----- */

  socketsFor(token) {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a && a.token === token;
    });
  }

  push(token, cmds) {
    if (!cmds.length) return;
    const now = Date.now();
    for (const ws of this.socketsFor(token)) {
      for (const cmd of cmds) {
        try {
          ws.send(JSON.stringify({ type: "cmd", cmd, now }));
        } catch {
          /* socket closing — the command stays queued until acked */
        }
      }
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const att = ws.deserializeAttachment() || {};

    if (!att.token) {
      const token = msg.type === "hello" && typeof msg.token === "string" ? msg.token : null;
      if (!token || !TOKEN_RE.test(token) || !this.devices.has(token)) {
        try {
          ws.send(JSON.stringify({ type: "error", error: "unknown_device" }));
          ws.close(4003, "unknown_device");
        } catch {
          /* already closed */
        }
        return;
      }
      // One live socket per device: a reconnect replaces the old one.
      for (const other of this.socketsFor(token)) {
        try {
          other.close(4000, "replaced");
        } catch {
          /* already closed */
        }
      }
      ws.serializeAttachment({ token, since: Date.now() });
      if (typeof msg.after === "number") await this.ack(token, msg.after);
      ws.send(JSON.stringify({ type: "welcome", now: Date.now() }));
      this.push(token, this.pending(token));
      return;
    }

    if (msg.type === "ack" && typeof msg.seq === "number") {
      await this.ack(att.token, msg.seq);
    } else if (msg.type === "result" && typeof msg.id === "string" && CMD_ID_RE.test(msg.id)) {
      await this.storeResult(msg.id, msg);
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError() {
    /* the close handler follows */
  }

  /* ----- HTTP ----- */

  async fetch(req) {
    const path = new URL(req.url).pathname;
    try {
      return await this.handle(req);
    } catch (e) {
      console.error("juno-bridge hub:", path, e && e.stack ? e.stack : e);
      return jsonResponse({ error: "server_error" }, 500, corsHeaders(path, req.headers.get("origin")));
    }
  }

  async handle(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get("origin");
    const cors = corsHeaders(path, origin);
    const json = (data, status = 200) => jsonResponse(data, status, cors);

    // ---- device: live WebSocket (the fast path) ----
    if (path === "/ws") {
      if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "expected_websocket" }, 426);
      }
      // Browsers always send Origin on WebSockets; only extensions may connect.
      if (origin && !origin.startsWith("chrome-extension://")) return json({ error: "forbidden_origin" }, 403);
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return json({ error: "too_many_sockets" }, 503);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ token: null });
      // The first message must be a valid hello; drop sockets that never send one.
      setTimeout(() => {
        try {
          const a = server.deserializeAttachment();
          if (!a || !a.token) server.close(4001, "hello_timeout");
        } catch {
          /* already closed */
        }
      }, HELLO_TIMEOUT_MS);
      return new Response(null, { status: 101, webSocket: client });
    }

    // An empty POST body (e.g. `curl -X POST .../admin/pair`) means {}.
    let body = {};
    if (req.method === "POST") {
      try {
        const text = await req.text();
        body = text.trim() ? JSON.parse(text) : {};
      } catch {
        return json({ error: "bad_json" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_json" }, 400);
    }

    const requireAdmin = async () => {
      const tok = bearer(req);
      if (!tok) return json({ error: "missing_auth" }, 401);
      const stored = this.adminHashValue();
      if (!stored) return json({ error: "not_bootstrapped" }, 503);
      if (!ctEqual(await sha256hex(tok), stored)) return json({ error: "bad_auth" }, 403);
      return null;
    };

    // Token accepted ONLY from the POST body — never from the query string.
    const requireDevice = () => {
      const tok = typeof body.token === "string" ? body.token : null;
      if (!tok) return { err: json({ error: "missing_device_token" }, 401) };
      if (!TOKEN_RE.test(tok) || !this.devices.has(tok)) return { err: json({ error: "unknown_device" }, 403) };
      return { token: tok };
    };

    // ---- one-shot bootstrap: set the admin PSK hash ----
    if (path === "/admin/bootstrap" && req.method === "POST") {
      if (this.adminHashValue()) return json({ error: "already_bootstrapped" }, 403);
      const tok = bearer(req);
      if (!tok || tok.length < 16) return json({ error: "psk_too_short" }, 400);
      this.adminHash = await sha256hex(tok);
      await this.saveRegistry();
      return json({ ok: true, bootstrapped: true });
    }

    // ---- admin: create a short-lived pairing code ----
    if (path === "/admin/pair" && req.method === "POST") {
      const err = await requireAdmin();
      if (err) return err;
      const now = Date.now();
      for (const [c, exp] of this.pairs) if (exp < now) this.pairs.delete(c);
      const code = pairCode();
      this.pairs.set(code, now + PAIR_TTL_MS);
      await this.saveRegistry();
      return json({ code, expires_in: PAIR_TTL_MS / 1000 });
    }

    // ---- admin: enqueue a command (and optionally wait for its result) ----
    const isRun = path === "/admin/run";
    if ((path === "/admin/cmd" || isRun) && req.method === "POST") {
      const err = await requireAdmin();
      if (err) return err;
      const action = body.action;
      if (!action || typeof action !== "string") return json({ error: "missing_action" }, 400);
      const dev = this.resolveDevice(body.device);
      if (dev.error) return json({ error: dev.error }, dev.status);
      const cmd = await this.enqueue(dev.token, action, body.params);
      if (!cmd) return json({ error: "queue_full" }, 429);
      const device = dev.token.slice(0, 8) + "…";
      if (!isRun) return json({ ok: true, id: cmd.id, device });
      const result = await this.waitForResult(cmd.id, waitSeconds(body.wait, RUN_WAIT_DEFAULT_S));
      return json(result ? { ok: true, id: cmd.id, device, pending: false, result } : { ok: true, id: cmd.id, device, pending: true });
    }

    // ---- admin: fetch (and consume) a command result, waiting briefly ----
    if (path === "/admin/result" && req.method === "GET") {
      const err = await requireAdmin();
      if (err) return err;
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);
      if (!CMD_ID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const res = await this.waitForResult(id, waitSeconds(url.searchParams.get("wait"), RESULT_WAIT_DEFAULT_S));
      return json(res ? { pending: false, result: res } : { pending: true });
    }

    // ---- admin: connectivity check ----
    if (path === "/admin/ping" && (req.method === "GET" || req.method === "POST")) {
      const err = await requireAdmin();
      if (err) return err;
      const connected = this.order.filter((t) => this.socketsFor(t).length).length;
      return json({ ok: true, devices: this.order.length, connected });
    }

    // ---- admin: list paired devices (ids are 8-char token prefixes) ----
    if (path === "/admin/devices" && req.method === "GET") {
      const err = await requireAdmin();
      if (err) return err;
      const devices = this.order.map((t) => {
        const d = this.devices.get(t) || {};
        return {
          id: t.slice(0, 8),
          name: d.name || null,
          created: d.created || null,
          connected: this.socketsFor(t).length > 0,
          pending: this.pending(t).length,
        };
      });
      return json({ ok: true, devices, default: this.order.length ? this.order[this.order.length - 1].slice(0, 8) : null });
    }

    // ---- admin: revoke a device (lost laptop, stale pairing) ----
    if (path === "/admin/revoke" && req.method === "POST") {
      const err = await requireAdmin();
      if (err) return err;
      if (!body.device || body.device === "default") return json({ error: "device_required" }, 400);
      const dev = this.resolveDevice(body.device);
      if (dev.error) return json({ error: dev.error }, dev.status);
      await this.removeDevice(dev.token);
      return json({ ok: true, revoked: dev.token.slice(0, 8) + "…" });
    }

    // ---- device: register with a pairing code ----
    if (path === "/register" && req.method === "POST") {
      if (body.code === undefined || body.code === null || body.code === "") {
        return json({ error: "missing_code" }, 400);
      }
      const code = normalizePairCode(body.code);
      const exp = PAIR_RE.test(code) ? this.pairs.get(code) : undefined;
      if (!exp || exp < Date.now()) return json({ error: "bad_or_expired_code" }, 403);
      this.pairs.delete(code);
      const token = randHex(32);
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, NAME_MAX) : "chrome";
      this.devices.set(token, { name, created: Date.now() });
      this.order.push(token);
      await this.saveRegistry();
      return json({ ok: true, device_token: token });
    }

    // ---- device: unregister itself (revokes the token) ----
    if (path === "/unregister" && req.method === "POST") {
      const d = requireDevice();
      if (d.err) return d.err;
      await this.removeDevice(d.token);
      return json({ ok: true });
    }

    // ---- device: HTTP fallback poll (POST; token in body only) ----
    if (path === "/poll" && req.method === "POST") {
      const d = requireDevice();
      if (d.err) return d.err;
      if (typeof body.after === "number") {
        // Cursor mode: `after` doubles as the acknowledgement.
        await this.ack(d.token, body.after);
        const cmd = this.pending(d.token)[0];
        if (!cmd) return new Response(null, { status: 204, headers: cors });
        return json({ cmd, now: Date.now() });
      }
      // Legacy destructive dequeue for extensions that don't send `after`.
      const items = this.pending(d.token);
      if (!items.length) return new Response(null, { status: 204, headers: cors });
      const cmd = items.shift();
      await this.saveQueue(d.token, { last: this.queues.get(d.token).last, items });
      return json({ cmd, now: Date.now() });
    }

    // ---- device: HTTP result post (fallback, and for results too big for the socket) ----
    if (path === "/result" && req.method === "POST") {
      const d = requireDevice();
      if (d.err) return d.err;
      const id = body.id;
      if (!id) return json({ error: "missing_id" }, 400);
      if (typeof id !== "string" || !CMD_ID_RE.test(id)) return json({ error: "bad_id" }, 400);
      await this.storeResult(id, body);
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  }
}
