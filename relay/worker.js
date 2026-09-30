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
 * - Admin: Authorization: Bearer <psk>, compared with the ADMIN_PSK_SHA256
 *   secret (hex SHA-256 of the passphrase). The secret is required. A hash
 *   stored in the Durable Object, including one imported from KV, does not
 *   authenticate anyone. POST /admin/bootstrap is disabled — the first caller
 *   of a fresh deploy cannot claim the relay.
 * - Device: per-device token issued at registration. It travels only in a
 *   POST body. WebSockets use single-use tickets in a private subprotocol.
 * - Results: a device may submit a result only for a command id that was
 *   enqueued for that device. The association outlives delivery
 *   acknowledgement and lasts until the result is accepted (further posts
 *   from the owner are duplicates) or the record expires.
 *
 * Delivery is at-most-once per command: each has a monotonically increasing
 * `seq`; the extension records the highest seq it has taken BEFORE running it
 * and acknowledges it. Unacknowledged commands are re-sent on reconnect, and
 * the extension skips anything at or below its cursor.
 *
 * Optional request_id on /admin/cmd and /admin/run is per device. A repeat
 * returns the original command and does not enqueue another execution. The
 * result is referenced by that record so a caller can read it again after
 * GET /admin/result has consumed its receipt. The reference lasts until the
 * ownership TTL. A different request_id is a different command.
 *
 * Migration: on first boot, if the old KV namespace is still bound as BRIDGE,
 * paired devices are imported so nothing needs re-pairing. An imported
 * passphrase hash is kept but does not authenticate; set ADMIN_PSK_SHA256.
 */

const enc = new TextEncoder();

const PAIR_TTL_MS = 600_000;
const QUEUE_KEEP_MS = 180_000; // the extension refuses commands older than 2 min anyway
const QUEUE_MAX = 100;
const RESULT_TTL_MS = 600_000;
// Command→device ownership outlives queue acknowledgement so a result can
// still be checked after the command was delivered, and dies with the result.
const OWNER_TTL_MS = RESULT_TTL_MS;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const RESULT_TOTAL_BYTES = 16 * 1024 * 1024;
const RESULT_MAX = 128;
const RESULT_CHUNK_BYTES = 100 * 1024;
const QUEUE_BYTES_MAX = 4 * 1024 * 1024;
const QUEUE_DEVICE_BYTES_MAX = 1024 * 1024;
const IDEM_BYTES_MAX = 4 * 1024 * 1024;
const OWNER_MAX = 1000;
const IDEM_MAX = 1000;
const DEVICE_MAX = 256;
const PAIR_MAX = 64;
const TICKET_MAX = 64;
const TICKET_TTL_MS = 30_000;
const BODY_MAX = 64 * 1024;
const RESULT_BODY_MAX = 10 * 1024 * 1024;
const BODY_TIMEOUT_MS = 15_000;
const BODY_READERS_MAX = 8;
const WS_MESSAGE_MAX = 900 * 1024;
const WAITERS_MAX = 256;
const RESULT_STREAMS_MAX = 16;
const RESULT_STREAM_TIMEOUT_MS = 30_000;
const CLEANUP_MS = 60_000;
const RESULT_WAIT_DEFAULT_S = 10;
const RUN_WAIT_DEFAULT_S = 30;
const WAIT_MAX_S = 60;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_SOCKETS = 16;
const NAME_MAX = 64;

// Hex SHA-256 only. A raw passphrase in this binding does not configure the relay.
function adminSecret(env) {
  const raw = env && env.ADMIN_PSK_SHA256;
  if (typeof raw !== "string") return null;
  const hex = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function bootstrapDisabled(headers = {}) {
  return jsonResponse(
    {
      error: "bootstrap_disabled",
      detail: "Set the ADMIN_PSK_SHA256 secret before the relay will serve. Open enrollment is disabled.",
    },
    410,
    headers
  );
}

const PAIR_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIR_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const CMD_ID_RE = /^cmd_[0-9a-f]{16}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CAPABILITIES = ["idempotency", "workflow"];

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
const DEVICE_PATHS = new Set(["/register", "/poll", "/result", "/unregister", "/ws-ticket"]);

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

// Workers provides this constant-time Web Crypto extension.
function ctEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b));
}

class RelayError extends Error {
  constructor(error, status) { super(error); this.status = status; }
}

function bytes(value) { return enc.encode(JSON.stringify(value)).byteLength; }

async function deleteKeys(storage, keys) {
  for (let start = 0; start < keys.length; start += 128) await storage.delete(keys.slice(start, start + 128));
}

// One absolute deadline covers the full stream, including an incomplete body.
async function readJsonBody(req, limit) {
  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    if (req.body) void req.body.cancel().catch(() => {});
    throw new RelayError("body_too_large", 413);
  }
  if (!req.body) return {};
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let timedOut = false, timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
      reject(new RelayError("body_timeout", 408));
    }, BODY_TIMEOUT_MS);
  });
  try {
    const text = await Promise.race([timeout, (async () => {
      let size = 0, segment = "";
      const segments = [];
      while (true) {
        const { value, done } = await reader.read();
        if (timedOut) throw new RelayError("body_timeout", 408);
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new RelayError("body_too_large", 413);
        segment += decoder.decode(value, { stream: true });
        if (segment.length >= 65536) { segments.push(segment); segment = ""; }
      }
      segments.push(segment + decoder.decode());
      return segments.join("");
    })()]);
    let body;
    try { body = text.trim() ? JSON.parse(text) : {}; }
    catch { throw new RelayError("bad_json", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RelayError("bad_json", 400);
    return body;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* a cancelled read may still be settling */ }
  }
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
      if (path === "/") {
        return jsonResponse({ service: "juno-bridge", ok: true, configured: adminSecret(env) != null });
      }
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(path, origin) });
      }
      // Refuse before waking the Durable Object. Bootstrap cannot claim a
      // relay that has no secret yet, and no operational route is served until
      // ADMIN_PSK_SHA256 is a hex SHA-256.
      if (path === "/admin/bootstrap") return bootstrapDisabled();
      if (!adminSecret(env)) {
        return jsonResponse({ error: "admin_not_configured" }, 503, corsHeaders(path, origin));
      }
      // Reject header-only attackers before forwarding any body to the hub.
      // The hub repeats this check for direct Durable Object requests.
      if (path.startsWith("/admin/")) {
        const token = bearer(req);
        if (!token) return jsonResponse({ error: "missing_auth" }, 401);
        if (!ctEqual(await sha256hex(token), adminSecret(env))) return jsonResponse({ error: "bad_auth" }, 403);
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
      console.error("juno-bridge: request failed");
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
    this.owners = new Map(); // cmd id → { token, expires, done }
    this.idem = new Map(); // token:request_id → { cmd, expires, resultId }
    this.idemByCmd = new Map(); // cmd id → idempotency key
    this.idemWaiters = new Map(); // idempotency key → Set of wake-up functions
    this.mutations = Promise.resolve();
    this.waiterCount = 0;
    this.bodyReaders = 0;
    this.postRequests = 0;
    this.resultBodyReaders = 0;
    this.resultStreams = 0;
    this.resultPins = new Map(); // active, deadline-bounded streams defer TTL deletion
    // The runtime answers the extension's keepalive without waking the hub.
    ctx.setWebSocketAutoResponse(new globalThis.WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(() => this.load());
  }

  /* ----- state and bounded, transactional mutations ----- */

  mutate(fn) {
    const work = this.mutations.then(fn);
    this.mutations = work.catch(() => {});
    return work;
  }

  async *records(prefix, pageSize = 128) {
    let startAfter;
    while (true) {
      const page = await this.ctx.storage.list({ prefix, limit: pageSize, ...(startAfter ? { startAfter } : {}) });
      for (const pair of page) yield pair;
      if (page.size < pageSize) return;
      startAfter = [...page.keys()].at(-1);
    }
  }

  async commit(writes = {}, deletes = []) {
    await this.ctx.storage.transaction(async (tx) => {
      await deleteKeys(tx, deletes);
      const entries = Object.entries(writes);
      for (let i = 0; i < entries.length; i += 128) await tx.put(Object.fromEntries(entries.slice(i, i + 128)));
      await tx.setAlarm(Date.now() + CLEANUP_MS);
    });
  }

  registry(devices = this.devices, order = this.order, pairs = this.pairs) {
    return { admin_hash: this.adminHash, devices, order, pairs, migrated: this.migrated };
  }

  async load() {
    const s = this.ctx.storage;
    const now = Date.now();
    const reg = await s.get(["admin_hash", "devices", "order", "pairs", "migrated"]);
    this.adminHash = reg.get("admin_hash") || null;
    this.devices = reg.get("devices") || new Map();
    this.order = reg.get("order") || [];
    const storedPairs = reg.get("pairs") || new Map();
    this.pairs = new Map([...storedPairs].filter(([, expires]) => expires > now));
    this.migrated = !!reg.get("migrated");
    if (this.devices.size > DEVICE_MAX || this.pairs.size > PAIR_MAX) throw new Error("legacy registry exceeds safe limits");
    if (!this.migrated) await this.importFromKv();
    else if (storedPairs.size !== this.pairs.size) await this.commit({ pairs: this.pairs });
    this.queues = new Map();
    this.results = new Map();
    this.payloads = new Map(); // metadata only; primary and replay share durable chunks
    this.owners = new Map();
    this.idem = new Map();
    this.idemByCmd = new Map();
    this.tickets = new Map();
    for await (const [k, v] of this.records("queue:", 1)) {
      if (!this.devices.has(k.slice(6))) { await s.delete(k); continue; }
      const queue = { last: v.last, items: v.items.filter((c) => now - c.issued_at < QUEUE_KEEP_MS) };
      if (queue.items.length !== v.items.length) await this.commit({ [k]: queue });
      this.queues.set(k.slice(6), queue);
      if (queue.items.length > QUEUE_MAX || bytes(queue) > QUEUE_DEVICE_BYTES_MAX || this.queueBytes() > QUEUE_BYTES_MAX) throw new Error("legacy queues exceed safe limits");
    }
    for await (const [k, v] of this.records("own:")) {
      if (!v || !TOKEN_RE.test(v.token)) continue;
      // Leave expired rows available to attribute old raw result records until
      // migration finishes, but never count them against the live-state bound.
      if (v.expires <= now || !this.devices.has(v.token)) continue;
      this.owners.set(k.slice(4), { ...v, done: !!v.done });
      if (this.owners.size > OWNER_MAX) throw new Error("legacy owners exceed safe limits");
    }
    for await (const [k, v] of this.records("payload:")) {
      if (!v || !Number.isSafeInteger(v.chunks) || v.chunks < 1 || v.chunks > Math.ceil(MAX_RESULT_BYTES / RESULT_CHUNK_BYTES) || !Number.isSafeInteger(v.bytes) || v.bytes < 1 || v.bytes > MAX_RESULT_BYTES) throw new Error("invalid durable result metadata");
      if (v.expires <= now || (v.token && !this.devices.has(v.token))) { await deleteKeys(s, [k, ...this.chunkKeys(k.slice(8), v)]); continue; }
      const token = v.token || (await s.get("own:" + k.slice(8)))?.token || null;
      if (token && !this.devices.has(token)) { await deleteKeys(s, [k, "res:" + k.slice(8), ...this.chunkKeys(k.slice(8), v)]); continue; }
      const meta = token && !v.token ? { ...v, token } : v;
      if (meta !== v) await this.commit({ [k]: meta });
      this.payloads.set(k.slice(8), meta);
      if (this.payloads.size > RESULT_MAX || this.payloadBytes() > RESULT_TOTAL_BYTES) throw new Error("legacy results exceed safe limits");
    }
    for await (const [k, v] of this.records("res:", 1)) {
      const id = k.slice(4);
      if (!v) continue;
      if (v.expires <= now) { await s.delete(k); continue; }
      if (typeof v.record === "string") {
        const oldOwner = this.owners.get(id) || await s.get("own:" + id);
        if (oldOwner?.token && !this.devices.has(oldOwner.token)) { await s.delete(k); continue; }
        await this.importResult(id, v.record, v.expires, { [k]: { expires: v.expires } }, oldOwner?.token);
      } else if (!this.payloads.has(id)) throw new Error("missing durable result payload");
      this.results.set(id, { expires: v.expires });
    }
    for await (const [k, v] of this.records("idem:", 1)) {
      if (!v || !v.cmd || !CMD_ID_RE.test(v.cmd.id)) continue;
      const key = k.slice(5);
      if (v.expires <= now || !this.devices.has(key.slice(0, 64))) { await s.delete(k); continue; }
      const entry = { cmd: v.cmd, expires: v.expires, resultId: v.resultId || null };
      if (v.result) {
        entry.resultId = v.cmd.id;
        await this.importResult(v.cmd.id, JSON.stringify(v.result), v.expires, { [k]: entry }, key.slice(0, 64));
      }
      if (entry.resultId && !this.payloads.has(entry.resultId)) throw new Error("missing durable replay payload");
      if (entry.resultId && !this.payloads.get(entry.resultId).token) {
        const meta = { ...this.payloads.get(entry.resultId), token: key.slice(0, 64) };
        await this.commit({ ["payload:" + entry.resultId]: meta }); this.payloads.set(entry.resultId, meta);
      }
      this.idem.set(key, entry);
      this.idemByCmd.set(v.cmd.id, key);
      if (this.idem.size > IDEM_MAX || this.idemBytes() > IDEM_BYTES_MAX) throw new Error("legacy idempotency records exceed safe limits");
    }
    for await (const [k, v] of this.records("ticket:")) {
      if (!v || v.expires <= now || !this.devices.has(v.token)) { await s.delete(k); continue; }
      this.tickets.set(k.slice(7), v);
      if (this.tickets.size > TICKET_MAX) throw new Error("legacy tickets exceed safe limits");
    }
    // Older schemas might have queued commands without independent ownership.
    const owners = {};
    for (const [token, q] of this.queues) for (const cmd of q.items) {
      if (this.owners.has(cmd.id)) continue;
      const owner = { token, expires: cmd.issued_at + OWNER_TTL_MS, done: this.payloads.has(cmd.id) };
      owners["own:" + cmd.id] = owner;
      this.owners.set(cmd.id, owner);
    }
    if (this.owners.size > OWNER_MAX) throw new Error("legacy owners exceed safe limits");
    // A previously acknowledged, memory-only screenshot cannot be reconstructed.
    // Keep the receipt and expose an explicit failure rather than pending forever.
    for (const [id, owner] of this.owners) if (owner.done && !owner.consumed && !this.payloads.has(id)) owner.resultMissing = true;
    if (Object.keys(owners).length) await this.commit(owners);
    let expiredOwners = [];
    for await (const [k, v] of this.records("own:")) {
      if (!v || v.expires <= now || !this.devices.has(v.token)) expiredOwners.push(k);
      if (expiredOwners.length === 128) { await deleteKeys(s, expiredOwners); expiredOwners = []; }
    }
    await deleteKeys(s, expiredOwners);
    await this.purgeExpired();
  }

  async importFromKv() {
    const kv = this.env.BRIDGE;
    const devices = new Map(this.devices), order = [...this.order];
    let hash = this.adminHash;
    if (kv) {
      const imported = await kv.get("cfg:admin_hash");
      if (imported && !hash) hash = imported;
      for (const token of (await kv.get("devices:index", "json")) || []) {
        if (!TOKEN_RE.test(token) || devices.has(token)) continue;
        if (devices.size >= DEVICE_MAX) throw new Error("KV registry exceeds safe limits");
        const d = await kv.get("device:" + token, "json");
        if (!d) continue;
        devices.set(token, { name: String(d.name || "chrome").slice(0, NAME_MAX), created: d.created || Date.now() });
        order.push(token);
      }
    }
    // No partial import becomes visible or marks migration complete.
    await this.commit({ admin_hash: hash, devices, order, pairs: this.pairs, migrated: true });
    this.adminHash = hash; this.devices = devices; this.order = order; this.migrated = true;
  }

  adminHashValue() { return adminSecret(this.env); }

  resolveDevice(selector) {
    if (!selector || selector === "default") return this.order.length ? { token: this.order.at(-1) } : { error: "no_device", status: 404 };
    if (typeof selector !== "string") return { error: "bad_device", status: 400 };
    const sel = selector.trim().toLowerCase().replace(/…$/, "");
    if (TOKEN_RE.test(sel)) return this.devices.has(sel) ? { token: sel } : { error: "no_device", status: 404 };
    if (sel.length < 8) return { error: "device_prefix_too_short", status: 400 };
    const hits = this.order.filter((t) => t.startsWith(sel));
    if (hits.length > 1) return { error: "ambiguous_device", status: 409 };
    return hits.length ? { token: hits[0] } : { error: "no_device", status: 404 };
  }

  queueBytes() { let total = 0; for (const q of this.queues.values()) total += bytes(q); return total; }
  idemBytes() { let total = 0; for (const e of this.idem.values()) total += bytes(e.cmd); return total; }
  payloadBytes() { let total = 0; for (const p of this.payloads.values()) total += p.bytes; return total; }
  chunkKeys(id, meta = this.payloads.get(id)) { return meta ? Array.from({ length: meta.chunks }, (_, i) => `chunk:${id}:${i}`) : []; }

  async removeDevice(token) {
    return this.mutate(async () => {
      const devices = new Map(this.devices); devices.delete(token);
      const order = this.order.filter((t) => t !== token);
      const ownerIds = [...this.owners].filter(([, o]) => o.token === token).map(([id]) => id);
      const idemKeys = [...this.idem.keys()].filter((k) => k.startsWith(token + ":"));
      const ids = new Set([...ownerIds, ...idemKeys.map((k) => this.idem.get(k).cmd.id), ...[...this.payloads].filter(([, p]) => p.token === token).map(([id]) => id)]);
      const ticketKeys = [...this.tickets].filter(([, t]) => t.token === token).map(([k]) => k);
      const deletes = ["queue:" + token, ...ownerIds.map((id) => "own:" + id), ...idemKeys.map((k) => "idem:" + k), ...ticketKeys.map((k) => "ticket:" + k)];
      for (const id of ids) deletes.push("res:" + id, "payload:" + id, ...this.chunkKeys(id));
      await this.commit(this.registry(devices, order), deletes);
      this.devices = devices; this.order = order; this.queues.delete(token);
      for (const id of ids) { this.owners.delete(id); this.results.delete(id); this.payloads.delete(id); this.idemByCmd.delete(id); this.wake(this.waiters, id); }
      for (const k of idemKeys) { this.idem.delete(k); this.wake(this.idemWaiters, k); }
      for (const k of ticketKeys) this.tickets.delete(k);
      for (const ws of this.socketsFor(token)) try { ws.close(4003, "revoked"); } catch { /* closing */ }
    });
  }

  pending(token) {
    const q = this.queues.get(token);
    return q ? q.items.filter((c) => Date.now() - c.issued_at < QUEUE_KEEP_MS) : [];
  }

  async enqueue(token, action, params, requestId) {
    return this.mutate(async () => {
      await this.purgeExpired();
      if (!this.devices.has(token)) return { error: "unknown_device", status: 403 };
      let key = null;
      if (requestId !== undefined && requestId !== null) {
        if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) return { error: "bad_request_id", status: 400 };
        key = token + ":" + requestId;
        const prior = this.idem.get(key);
        if (prior) return { cmd: prior.cmd, duplicate: true, idemKey: key };
      }
      const q = this.queues.get(token) || { last: 0, items: [] };
      const items = this.pending(token);
      if (items.length >= QUEUE_MAX || this.owners.size >= OWNER_MAX || (key && this.idem.size >= IDEM_MAX)) return null;
      const now = Date.now();
      const cmd = { id: "cmd_" + randHex(8), seq: Math.max(now, q.last + 1), action, params: params && typeof params === "object" ? params : {}, issued_at: now };
      if (bytes(cmd) > BODY_MAX) return { error: "command_too_large", status: 413 };
      const next = { last: cmd.seq, items: [...items, cmd] };
      if (bytes(next) > QUEUE_DEVICE_BYTES_MAX || this.queueBytes() - (this.queues.has(token) ? bytes(q) : 0) + bytes(next) > QUEUE_BYTES_MAX || (key && this.idemBytes() + bytes(cmd) > IDEM_BYTES_MAX)) return null;
      const owner = { token, expires: now + OWNER_TTL_MS, done: false };
      const entry = key ? { cmd, expires: now + OWNER_TTL_MS, resultId: null } : null;
      const writes = { ["queue:" + token]: next, ["own:" + cmd.id]: owner };
      if (key) writes["idem:" + key] = entry;
      await this.commit(writes);
      this.queues.set(token, next); this.owners.set(cmd.id, owner);
      if (key) { this.idem.set(key, entry); this.idemByCmd.set(cmd.id, key); }
      this.push(token, [cmd]);
      return { cmd, duplicate: false, idemKey: key };
    });
  }

  async ack(token, seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    return this.mutate(async () => {
      if (!this.devices.has(token)) return;
      const q = this.queues.get(token);
      if (!q) return;
      const items = q.items.filter((c) => c.seq > seq);
      if (items.length === q.items.length) return;
      const next = { last: q.last, items };
      await this.commit({ ["queue:" + token]: next });
      this.queues.set(token, next);
    });
  }

  async legacyPoll(token) {
    return this.mutate(async () => {
      if (!this.devices.has(token)) return null;
      const items = this.pending(token);
      if (!items.length) return null;
      const cmd = items.shift(), next = { last: this.queues.get(token).last, items };
      await this.commit({ ["queue:" + token]: next });
      this.queues.set(token, next);
      return cmd;
    });
  }

  async putPayload(tx, id, encoded, expires, token = this.owners.get(id)?.token || null) {
    const meta = { bytes: encoded.byteLength, chunks: Math.ceil(encoded.byteLength / RESULT_CHUNK_BYTES), expires, token };
    // Small write batches keep the write buffer bounded, including >128 chunks.
    for (let i = 0; i < meta.chunks; i++) await tx.put(`chunk:${id}:${i}`, encoded.slice(i * RESULT_CHUNK_BYTES, (i + 1) * RESULT_CHUNK_BYTES), { noCache: true });
    await tx.put("payload:" + id, meta);
    return meta;
  }

  async importResult(id, record, expires, writes, token) {
    if (this.payloads.has(id)) {
      const old = this.payloads.get(id);
      const meta = !old.token && token ? { ...old, token } : old;
      await this.commit({ ...writes, ["payload:" + id]: meta }); this.payloads.set(id, meta); return;
    }
    const encoded = enc.encode(record);
    if (encoded.byteLength > MAX_RESULT_BYTES || this.payloads.size >= RESULT_MAX || this.payloadBytes() + encoded.byteLength > RESULT_TOTAL_BYTES) throw new Error("legacy result exceeds safe limits");
    let meta;
    await this.ctx.storage.transaction(async (tx) => {
      meta = await this.putPayload(tx, id, encoded, expires, token);
      await tx.put(writes);
      await tx.setAlarm(Date.now() + CLEANUP_MS);
    });
    this.payloads.set(id, meta);
  }

  async acceptResult(token, id, body) {
    return this.mutate(async () => {
      await this.purgeExpired();
      if (!this.devices.has(token)) return { ok: false, error: "unknown_device", status: 403 };
      const owner = this.owners.get(id);
      if (!owner) return { ok: false, error: "unknown_command", status: 403 };
      if (owner.token !== token) return { ok: false, error: "not_command_owner", status: 403 };
      if (owner.done) return { ok: true, duplicate: true };
      let parsed = { ok: !!body.ok, data: body.data ?? null, error: body.error == null ? null : String(body.error).slice(0, 1000), finished_at: Date.now() };
      let encoded = enc.encode(JSON.stringify(parsed));
      if (encoded.byteLength > MAX_RESULT_BYTES || this.payloadBytes() + encoded.byteLength > RESULT_TOTAL_BYTES) {
        parsed = { ok: false, data: null, error: encoded.byteLength > MAX_RESULT_BYTES ? "result_too_large" : "result_capacity", finished_at: Date.now() };
        encoded = enc.encode(JSON.stringify(parsed));
      }
      if (this.payloads.size >= RESULT_MAX || this.payloadBytes() + encoded.byteLength > RESULT_TOTAL_BYTES) return { ok: false, error: "result_capacity", status: 429 };
      const completed = { ...owner, done: true }, primary = { expires: Date.now() + RESULT_TTL_MS };
      const key = this.idemByCmd.get(id), prior = key && this.idem.get(key);
      const replay = prior ? { ...prior, resultId: id } : null;
      let meta;
      await this.ctx.storage.transaction(async (tx) => {
        meta = await this.putPayload(tx, id, encoded, Math.max(primary.expires, replay ? replay.expires : 0));
        const writes = { ["res:" + id]: primary, ["own:" + id]: completed };
        if (key && replay) writes["idem:" + key] = replay;
        await tx.put(writes);
        await tx.setAlarm(Date.now() + CLEANUP_MS);
      });
      // Visibility, done receipts, waiters and socket acknowledgements follow commit.
      this.payloads.set(id, meta); this.results.set(id, primary); this.owners.set(id, completed);
      if (replay) this.idem.set(key, replay);
      this.wake(this.waiters, id); if (key) this.wake(this.idemWaiters, key);
      return { ok: true };
    });
  }

  wake(map, key) { const set = map.get(key); if (set) for (const wake of [...set]) wake(); }

  async wait(map, key, seconds, ready, live) {
    if (ready() || !live() || seconds <= 0) return;
    if (this.waiterCount >= WAITERS_MAX) throw new RelayError("too_many_waiters", 429);
    this.waiterCount++;
    await new Promise((resolve) => {
      const set = map.get(key) || new Set(); map.set(key, set);
      let finished = false;
      const wake = () => {
        if (finished) return; finished = true; clearTimeout(timer);
        set.delete(wake); if (!set.size && map.get(key) === set) map.delete(key);
        this.waiterCount--; resolve();
      };
      const timer = setTimeout(wake, seconds * 1000);
      set.add(wake);
      if (ready() || !live()) wake();
    });
  }

  missingResult(id) { return this.owners.get(id)?.resultMissing ? { inline: { ok: false, data: null, error: "result_unavailable_after_upgrade", finished_at: Date.now() } } : null; }

  async waitForResult(id, seconds) {
    await this.wait(this.waiters, id, seconds, () => this.results.has(id) || this.missingResult(id), () => this.owners.has(id) && !this.owners.get(id).done);
    return this.results.has(id) ? { id, consume: true } : this.missingResult(id);
  }

  async waitForIdem(key, seconds) {
    const ready = () => this.idem.get(key)?.resultId || (this.idem.has(key) && this.missingResult(this.idem.get(key).cmd.id));
    await this.wait(this.idemWaiters, key, seconds, ready, () => this.idem.has(key));
    const entry = this.idem.get(key);
    return entry?.resultId ? { id: entry.resultId, consume: false } : entry ? this.missingResult(entry.cmd.id) : null;
  }

  async resultResponse(envelope, result, headers) {
    if (result.inline) return jsonResponse({ ...envelope, result: result.inline }, 200, headers);
    return this.mutate(async () => {
      const meta = this.payloads.get(result.id);
      if (!meta || meta.expires < Date.now() || (result.consume && !this.results.has(result.id))) return jsonResponse({ ...envelope, pending: true }, 200, headers);
      if (this.resultStreams >= RESULT_STREAMS_MAX) throw new RelayError("too_many_result_readers", 429);
      if (result.consume) {
        const owner = this.owners.get(result.id), completed = owner ? { ...owner, consumed: true } : null;
        await this.commit(completed ? { ["own:" + result.id]: completed } : {}, ["res:" + result.id]);
        this.results.delete(result.id); if (completed) this.owners.set(result.id, completed);
      }
      this.resultStreams++;
      this.resultPins.set(result.id, (this.resultPins.get(result.id) || 0) + 1);
      let index = -1, settled = false, timer;
      const release = () => {
        if (settled) return; settled = true; clearTimeout(timer); this.resultStreams--;
        const pins = this.resultPins.get(result.id) - 1;
        if (pins) this.resultPins.set(result.id, pins); else this.resultPins.delete(result.id);
      };
      const prefix = JSON.stringify(envelope).slice(0, -1) + ',"result":';
      const stream = new ReadableStream({
        start(controller) {
          timer = setTimeout(() => { try { controller.error(new Error("result_stream_timeout")); } finally { release(); } }, RESULT_STREAM_TIMEOUT_MS);
        },
        pull: async (controller) => {
          try {
            if (settled) return;
            if (index === -1) { index = 0; controller.enqueue(enc.encode(prefix)); return; }
            if (index < meta.chunks) {
              const chunk = await this.ctx.storage.get(`chunk:${result.id}:${index++}`, { noCache: true });
              if (settled) return;
              if (!(chunk instanceof Uint8Array)) throw new Error("missing durable result chunk");
              controller.enqueue(chunk); return;
            }
            controller.enqueue(enc.encode("}")); controller.close(); release();
          } catch (e) { if (!settled) controller.error(e); release(); }
        },
        cancel() { release(); },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json", ...headers } });
    });
  }

  async purgeExpired() {
    const now = Date.now(), deletes = [], writes = {};
    const ownerIds = [...this.owners].filter(([, v]) => !this.devices.has(v.token) || v.expires <= now).map(([id]) => id);
    const idemKeys = [...this.idem].filter(([k, v]) => !this.devices.has(k.slice(0, 64)) || v.expires <= now).map(([k]) => k);
    const resultIds = [...this.results].filter(([id, v]) => v.expires <= now && !this.resultPins.has(id)).map(([id]) => id);
    const payloadIds = [...this.payloads].filter(([id, v]) => (v.token && !this.devices.has(v.token)) || (v.expires <= now && !this.resultPins.has(id))).map(([id]) => id);
    const tickets = [...this.tickets].filter(([, v]) => !this.devices.has(v.token) || v.expires <= now).map(([k]) => k);
    const pairs = new Map([...this.pairs].filter(([, exp]) => exp > now));
    if (pairs.size !== this.pairs.size) Object.assign(writes, this.registry(this.devices, this.order, pairs));
    const queues = new Map();
    for (const [token, q] of this.queues) {
      const items = q.items.filter((c) => now - c.issued_at < QUEUE_KEEP_MS);
      if (items.length !== q.items.length) { const next = { last: q.last, items }; queues.set(token, next); writes["queue:" + token] = next; }
    }
    deletes.push(...ownerIds.map((id) => "own:" + id), ...idemKeys.map((k) => "idem:" + k), ...resultIds.map((id) => "res:" + id), ...tickets.map((k) => "ticket:" + k));
    for (const id of payloadIds) deletes.push("payload:" + id, ...this.chunkKeys(id));
    if (deletes.length || Object.keys(writes).length) await this.commit(writes, deletes);
    this.pairs = pairs;
    for (const [token, q] of queues) this.queues.set(token, q);
    for (const id of ownerIds) { this.owners.delete(id); this.wake(this.waiters, id); }
    for (const k of idemKeys) { const e = this.idem.get(k); this.idem.delete(k); if (e) this.idemByCmd.delete(e.cmd.id); this.wake(this.idemWaiters, k); }
    for (const id of resultIds) { this.results.delete(id); this.wake(this.waiters, id); }
    for (const id of payloadIds) this.payloads.delete(id);
    for (const k of tickets) this.tickets.delete(k);
    const expiring = this.owners.size || this.idem.size || this.results.size || this.payloads.size || this.tickets.size || this.pairs.size || [...this.queues.values()].some((q) => q.items.length);
    if (expiring) await this.ctx.storage.setAlarm(now + CLEANUP_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() { await this.mutate(() => this.purgeExpired()); }

  /* ----- sockets ----- */

  socketsFor(token) {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a && a.token === token && (ws.readyState === undefined ? !ws.closed : ws.readyState === 1);
    });
  }

  push(token, cmds) {
    if (!cmds.length) return;
    const now = Date.now();
    for (const ws of this.socketsFor(token)) {
      if (!this.devices.has(token) || ws.deserializeAttachment().hello === false) continue;
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
    if (typeof message !== "string" || message.length > WS_MESSAGE_MAX || enc.encode(message).byteLength > WS_MESSAGE_MAX) {
      try { ws.close(1009, "message_too_large"); } catch { /* closing */ }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    message = null;
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const att = ws.deserializeAttachment() || {};
    if (!att.token || !this.devices.has(att.token)) {
      try { ws.close(4003, "unknown_device"); } catch { /* closing */ }
      return;
    }
    if (att.hello === false) {
      if (msg.type !== "hello" || (msg.token !== undefined && msg.token !== att.token) || Date.now() - att.since > HELLO_TIMEOUT_MS) {
        try {
          ws.send(JSON.stringify({ type: "error", error: "unknown_device" }));
          ws.close(4003, "unknown_device");
        } catch {
          /* already closed */
        }
        return;
      }
      ws.serializeAttachment({ ...att, hello: true });
      const after = msg.after; msg = null;
      if (typeof after === "number") await this.ack(att.token, after);
      ws.send(JSON.stringify({ type: "welcome", now: Date.now(), capabilities: CAPABILITIES }));
      this.push(att.token, this.pending(att.token));
      return;
    }

    if (msg.type === "ack" && typeof msg.seq === "number") {
      const seq = msg.seq; msg = null;
      await this.ack(att.token, seq);
    } else if (msg.type === "result" && typeof msg.id === "string" && CMD_ID_RE.test(msg.id)) {
      // HTTP and socket result commits share one large-payload admission slot.
      // Close rather than issuing a final rejection: the client can use HTTP.
      if (this.resultBodyReaders >= 1) { try { ws.close(1013, "result_busy"); } catch { /* closing */ } return; }
      this.resultBodyReaders++;
      let verdict;
      try { verdict = await this.acceptResult(att.token, msg.id, msg); }
      finally { this.resultBodyReaders--; }
      try {
        ws.send(JSON.stringify(verdict.ok
          ? { type: "result_ack", id: msg.id }
          : { type: "result_rejected", id: msg.id, error: verdict.error }));
      } catch {
        /* socket closing — the extension falls back to HTTP */
      }
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
    const origin = req.headers.get("origin");
    const resultBody = path === "/result" && req.method === "POST";
    const ordinaryPost = req.method === "POST" && !resultBody;
    if (resultBody && this.resultBodyReaders >= 1) return jsonResponse({ error: "too_many_body_readers" }, 429, corsHeaders(path, req.headers.get("origin")));
    if (ordinaryPost && this.postRequests >= BODY_READERS_MAX) return jsonResponse({ error: "too_many_body_readers" }, 429, corsHeaders(path, req.headers.get("origin")));
    if (resultBody) this.resultBodyReaders++;
    if (ordinaryPost) this.postRequests++;
    let admittedPost = ordinaryPost;
    const releasePost = () => { if (admittedPost) { admittedPost = false; this.postRequests--; } };
    try {
      const work = this.handle(req, releasePost);
      req = null;
      return await work;
    } catch (e) {
      if (e instanceof RelayError) return jsonResponse({ error: e.message }, e.status, corsHeaders(path, origin));
      console.error("juno-bridge hub: request failed");
      return jsonResponse({ error: "server_error" }, 500, corsHeaders(path, origin));
    } finally {
      if (resultBody) this.resultBodyReaders--;
      releasePost();
    }
  }

  async handle(req, releasePost = () => {}) {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get("origin");
    const cors = corsHeaders(path, origin);
    const json = (data, status = 200) => jsonResponse(data, status, cors);

    // Direct Durable Object requests are gated here too. The edge fetch
    // usually answers first; this covers anything that reaches the hub.
    if (path === "/admin/bootstrap") return bootstrapDisabled(cors);
    if (!this.adminHashValue()) return json({ error: "admin_not_configured" }, 503);

    // ---- device: live WebSocket (the fast path) ----
    if (path === "/ws") {
      if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "expected_websocket" }, 426);
      }
      // Browsers always send Origin on WebSockets; only extensions may connect.
      if (origin && !origin.startsWith("chrome-extension://")) return json({ error: "forbidden_origin" }, 403);
      const protocols = (req.headers.get("sec-websocket-protocol") || "").split(",").map((v) => v.trim());
      const offered = protocols.filter((v) => /^juno-ticket\.[0-9a-f]{64}$/.test(v));
      if (url.search || !protocols.includes("juno-bridge-v1") || offered.length !== 1) return json({ error: "bad_or_expired_ticket" }, 403);
      return this.mutate(async () => {
        await this.purgeExpired();
        const key = offered[0].slice("juno-ticket.".length), ticket = this.tickets.get(key);
        if (!ticket || ticket.expires <= Date.now() || !this.devices.has(ticket.token) || (ticket.origin && ticket.origin !== origin)) return json({ error: "bad_or_expired_ticket" }, 403);
        const own = this.socketsFor(ticket.token);
        const active = this.ctx.getWebSockets().filter((ws) => {
          const a = ws.deserializeAttachment();
          return a?.token && this.devices.has(a.token) && (ws.readyState === undefined ? !ws.closed : ws.readyState === 1);
        });
        if (active.length - own.length >= MAX_SOCKETS) return json({ error: "too_many_sockets" }, 503);
        // Single use is durable BEFORE WebSocketPair construction or acceptance.
        await this.commit({}, ["ticket:" + key]); this.tickets.delete(key);
        for (const other of own) try { other.close(4000, "replaced"); } catch { /* closing */ }
        const [client, server] = Object.values(new globalThis.WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ token: ticket.token, since: Date.now(), hello: false });
        const timer = setTimeout(() => {
          try { if (server.deserializeAttachment()?.hello === false) server.close(4001, "hello_timeout"); } catch { /* closing */ }
        }, HELLO_TIMEOUT_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
        return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "juno-bridge-v1" } });
      });
    }

    let authenticated = false;
    const requireAdmin = async () => {
      if (authenticated) return null;
      const tok = bearer(req);
      if (!tok) return json({ error: "missing_auth" }, 401);
      const stored = this.adminHashValue();
      if (!stored) return json({ error: "admin_not_configured" }, 503);
      if (!ctEqual(await sha256hex(tok), stored)) return json({ error: "bad_auth" }, 403);
      authenticated = true;
      return null;
    };
    // Authenticate headers before allocating readers or parsing admin JSON.
    if (path.startsWith("/admin/")) { const denied = await requireAdmin(); if (denied) return denied; }
    if (DEVICE_PATHS.has(path) && origin && !origin.startsWith("chrome-extension://")) return json({ error: "forbidden_origin" }, 403);
    let body = {};
    if (req.method === "POST") {
      if (this.bodyReaders >= BODY_READERS_MAX) return json({ error: "too_many_body_readers" }, 429);
      this.bodyReaders++;
      try { body = await readJsonBody(req, path === "/result" ? RESULT_BODY_MAX : BODY_MAX); }
      finally { this.bodyReaders--; }
    }

    // Token accepted ONLY from the POST body — never from the query string.
    const requireDevice = () => {
      const tok = typeof body.token === "string" ? body.token : null;
      if (!tok) return { err: json({ error: "missing_device_token" }, 401) };
      if (!TOKEN_RE.test(tok) || !this.devices.has(tok)) return { err: json({ error: "unknown_device" }, 403) };
      return { token: tok };
    };

    if (path === "/ws-ticket" && req.method === "POST") {
      const d = requireDevice(); if (d.err) return d.err;
      return this.mutate(async () => {
        await this.purgeExpired();
        if (!this.devices.has(d.token)) return json({ error: "unknown_device" }, 403);
        const prior = [...this.tickets].filter(([, t]) => t.token === d.token).map(([k]) => k);
        if (this.tickets.size - prior.length >= TICKET_MAX) return json({ error: "too_many_tickets" }, 429);
        const ticket = randHex(32), entry = { token: d.token, origin: origin || null, expires: Date.now() + TICKET_TTL_MS };
        await this.commit({ ["ticket:" + ticket]: entry }, prior.map((k) => "ticket:" + k));
        for (const k of prior) this.tickets.delete(k);
        this.tickets.set(ticket, entry);
        return json({ ticket, expires_in: TICKET_TTL_MS / 1000 });
      });
    }

    // ---- admin: create a short-lived pairing code ----
    if (path === "/admin/pair" && req.method === "POST") {
      const err = await requireAdmin();
      if (err) return err;
      return this.mutate(async () => {
        await this.purgeExpired();
        if (this.pairs.size >= PAIR_MAX) return json({ error: "too_many_pairs" }, 429);
        let code; do { code = pairCode(); } while (this.pairs.has(code));
        const pairs = new Map(this.pairs); pairs.set(code, Date.now() + PAIR_TTL_MS);
        await this.commit(this.registry(this.devices, this.order, pairs));
        this.pairs = pairs;
        return json({ code, expires_in: PAIR_TTL_MS / 1000 });
      });
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
      const hasRequest = Object.prototype.hasOwnProperty.call(body, "request_id");
      const queued = await this.enqueue(dev.token, action, body.params, hasRequest ? body.request_id : undefined);
      if (!queued) return json({ error: "queue_full" }, 429);
      if (queued.error) return json({ error: queued.error }, queued.status || 400);
      const cmd = queued.cmd;
      const device = dev.token.slice(0, 8) + "…";
      if (queued.duplicate) {
        if (!isRun) return json({ ok: true, id: cmd.id, device, duplicate: true });
        const wait = waitSeconds(body.wait, RUN_WAIT_DEFAULT_S);
        body = null; req = null; releasePost();
        const result = await this.waitForIdem(queued.idemKey, wait);
        return result
          ? this.resultResponse({ ok: true, id: cmd.id, device, duplicate: true, pending: false }, result, cors)
          : json({ ok: true, id: cmd.id, device, duplicate: true, pending: true });
      }
      if (!isRun) return json({ ok: true, id: cmd.id, device });
      const wait = waitSeconds(body.wait, RUN_WAIT_DEFAULT_S);
      body = null; req = null; releasePost();
      const result = await this.waitForResult(cmd.id, wait);
      return result ? this.resultResponse({ ok: true, id: cmd.id, device, pending: false }, result, cors) : json({ ok: true, id: cmd.id, device, pending: true });
    }

    // ---- admin: fetch (and consume) a command result, waiting briefly ----
    if (path === "/admin/result" && req.method === "GET") {
      const err = await requireAdmin();
      if (err) return err;
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);
      if (!CMD_ID_RE.test(id)) return json({ error: "bad_id" }, 400);
      if (!this.owners.has(id) && !this.results.has(id)) return json({ error: "unknown_command" }, 404);
      const res = await this.waitForResult(id, waitSeconds(url.searchParams.get("wait"), RESULT_WAIT_DEFAULT_S));
      return res ? this.resultResponse({ pending: false }, res, cors) : json({ pending: true });
    }

    // ---- admin: connectivity check ----
    if (path === "/admin/ping" && (req.method === "GET" || req.method === "POST")) {
      const err = await requireAdmin();
      if (err) return err;
      const connected = this.order.filter((t) => this.socketsFor(t).length).length;
      return json({ ok: true, devices: this.order.length, connected, capabilities: CAPABILITIES });
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
      return this.mutate(async () => {
        await this.purgeExpired();
        const code = normalizePairCode(body.code), exp = PAIR_RE.test(code) ? this.pairs.get(code) : undefined;
        if (!exp || exp <= Date.now()) return json({ error: "bad_or_expired_code" }, 403);
        if (this.devices.size >= DEVICE_MAX) return json({ error: "too_many_devices" }, 429);
        const pairs = new Map(this.pairs); pairs.delete(code);
        const token = randHex(32), devices = new Map(this.devices), order = [...this.order, token];
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, NAME_MAX) : "chrome";
        devices.set(token, { name, created: Date.now() });
        await this.commit(this.registry(devices, order, pairs));
        this.pairs = pairs; this.devices = devices; this.order = order;
        return json({ ok: true, device_token: token });
      });
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
      const cmd = await this.legacyPoll(d.token);
      if (!cmd) return new Response(null, { status: 204, headers: cors });
      return json({ cmd, now: Date.now() });
    }

    // ---- device: HTTP result post (fallback, and for results too big for the socket) ----
    if (path === "/result" && req.method === "POST") {
      const d = requireDevice();
      if (d.err) return d.err;
      const id = body.id;
      if (!id) return json({ error: "missing_id" }, 400);
      if (typeof id !== "string" || !CMD_ID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const verdict = await this.acceptResult(d.token, id, body);
      if (!verdict.ok) return json({ error: verdict.error }, verdict.status);
      return json(verdict.duplicate ? { ok: true, duplicate: true } : { ok: true });
    }

    return json({ error: "not_found" }, 404);
  }
}
