/* Juno Bridge relay — unlisted Cloudflare Worker.
 *
 * Message bus between the Juno driver CLI and the Chrome extension.
 * - Admin auth: Authorization: Bearer <psk>. The worker stores only
 *   SHA-256(psk), set exactly once via POST /admin/bootstrap.
 * - Device auth: per-device token issued at registration. The token travels
 *   ONLY in a POST body — never in a URL, so it can't leak into logs.
 * - No cookies, no sessions, no PII. Commands and results live in KV
 *   with short TTLs. Nothing here is reachable unless you know the URL.
 *
 * Concurrency model: one driver, one extension per device token. Each
 * device has a single queue key holding a JSON array, so polling costs one
 * KV read — never a list. (KV list operations are capped at 1,000/day on the
 * free tier; a 2.5s poll loop would burn that in ~20 minutes. Reads get
 * 100,000/day, which comfortably fits two devices polling around the clock.)
 * Enqueue/dequeue are read-modify-write on that one key; with a single
 * driver and a single extension per device there is no queue race.
 */

const enc = new TextEncoder();

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
  // 8 unambiguous chars, human-typable
  const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => alpha[x % alpha.length]).join("");
}

// CORS is only meaningful for the extension (a browser). Admin endpoints are
// curl-only and get no CORS headers at all.
const DEVICE_PATHS = new Set(["/register", "/poll", "/result"]);

function corsHeaders(path) {
  if (!DEVICE_PATHS.has(path)) return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function json(data, status = 200, path = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(path) },
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

async function requireAdmin(req, env) {
  const stored = await env.BRIDGE.get("cfg:admin_hash");
  if (!stored) return { err: json({ error: "not_bootstrapped" }, 503) };
  const tok = bearer(req);
  if (!tok) return { err: json({ error: "missing_auth" }, 401) };
  const h = await sha256hex(tok);
  if (!ctEqual(h, stored)) return { err: json({ error: "bad_auth" }, 403) };
  return {};
}

async function requireDevice(req, env, body) {
  // Token accepted ONLY from the POST body — never from the query string.
  const tok = body && typeof body.token === "string" ? body.token : null;
  if (!tok) return { err: json({ error: "missing_device_token" }, 401) };
  const dev = await env.BRIDGE.get("device:" + tok, "json");
  if (!dev) return { err: json({ error: "unknown_device" }, 403) };
  return { token: tok, dev };
}

// One queue key per device: a JSON array of commands. Polling is a single
// KV read; enqueue/dequeue are read-modify-write on this key.
function queueKey(deviceToken) {
  return "queue:" + deviceToken;
}

async function resolveDevice(env, selector) {
  if (selector && selector !== "default") {
    const dev = await env.BRIDGE.get("device:" + selector, "json");
    return dev ? selector : null;
  }
  const idx = (await env.BRIDGE.get("devices:index", "json")) || [];
  return idx.length ? idx[idx.length - 1] : null;
}

function clientIp(req) {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for") ||
    "unknown"
  ).split(",")[0].trim().slice(0, 45);
}

export default {
  async fetch(req, env) {
    try {
      return await handleFetch(req, env);
    } catch (e) {
      // Never leak a bare 1101: a KV outage (e.g. daily quota exhausted)
      // should read as what it is so the driver/extension can back off.
      return json({ error: "kv_unavailable" }, 503);
    }
  },
};

async function handleFetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(path) });
    }
    if (path === "/") return json({ service: "juno-bridge", ok: true }, 200, path);

    let body = null;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        return json({ error: "bad_json" }, 400, path);
      }
    }

    // ---- one-shot bootstrap: set the admin PSK hash ----
    if (path === "/admin/bootstrap" && req.method === "POST") {
      const existing = await env.BRIDGE.get("cfg:admin_hash");
      if (existing) return json({ error: "already_bootstrapped" }, 403, path);
      const tok = bearer(req);
      if (!tok || tok.length < 16) return json({ error: "psk_too_short" }, 400, path);
      await env.BRIDGE.put("cfg:admin_hash", await sha256hex(tok));
      return json({ ok: true, bootstrapped: true }, 200, path);
    }

    // ---- admin: create a short-lived pairing code ----
    if (path === "/admin/pair" && req.method === "POST") {
      const a = await requireAdmin(req, env);
      if (a.err) return a.err;
      const code = pairCode();
      await env.BRIDGE.put("pair:" + code, JSON.stringify({ created: Date.now() }), {
        expirationTtl: 600,
      });
      return json({ code, expires_in: 600 }, 200, path);
    }

    // ---- admin: enqueue a command for a device ----
    if (path === "/admin/cmd" && req.method === "POST") {
      const a = await requireAdmin(req, env);
      if (a.err) return a.err;
      const action = body && body.action;
      if (!action || typeof action !== "string") return json({ error: "missing_action" }, 400, path);
      const deviceToken = await resolveDevice(env, body.device);
      if (!deviceToken) return json({ error: "no_device" }, 404, path);
      const id = "cmd_" + randHex(8);
      const ts = Date.now();
      const qk = queueKey(deviceToken);
      const queue = (await env.BRIDGE.get(qk, "json")) || [];
      queue.push({
        id,
        action,
        params: body.params && typeof body.params === "object" ? body.params : {},
        issued_at: ts,
      });
      await env.BRIDGE.put(qk, JSON.stringify(queue), {
        expirationTtl: 600, // uncollected commands evaporate
      });
      return json({ ok: true, id, device: deviceToken.slice(0, 8) + "…" }, 200, path);
    }

    // ---- admin: fetch (and consume) a command result ----
    if (path === "/admin/result" && req.method === "GET") {
      const a = await requireAdmin(req, env);
      if (a.err) return a.err;
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400, path);
      const res = await env.BRIDGE.get("res:" + id, "json");
      if (!res) return json({ pending: true }, 200, path);
      await env.BRIDGE.delete("res:" + id);
      return json({ pending: false, result: res }, 200, path);
    }

    // ---- admin: connectivity check ----
    if (path === "/admin/ping" && (req.method === "GET" || req.method === "POST")) {
      const a = await requireAdmin(req, env);
      if (a.err) return a.err;
      const idx = (await env.BRIDGE.get("devices:index", "json")) || [];
      return json({ ok: true, devices: idx.length }, 200, path);
    }

    // ---- device: register with a pairing code (rate-limited) ----
    if (path === "/register" && req.method === "POST") {
      const ip = clientIp(req);
      const rlKey = "rl:" + ip;
      const attempts = parseInt((await env.BRIDGE.get(rlKey)) || "0", 10) || 0;
      if (attempts >= 20) return json({ error: "rate_limited" }, 429, path);
      await env.BRIDGE.put(rlKey, String(attempts + 1), { expirationTtl: 300 });

      const code = body && body.code;
      if (!code) return json({ error: "missing_code" }, 400, path);
      const slot = await env.BRIDGE.get("pair:" + String(code).toUpperCase(), "json");
      if (!slot) return json({ error: "bad_or_expired_code" }, 403, path);
      await env.BRIDGE.delete("pair:" + String(code).toUpperCase());
      const token = randHex(32);
      await env.BRIDGE.put(
        "device:" + token,
        JSON.stringify({ name: (body && body.name) || "chrome", created: Date.now() })
      );
      const idx = (await env.BRIDGE.get("devices:index", "json")) || [];
      idx.push(token);
      await env.BRIDGE.put("devices:index", JSON.stringify(idx));
      return json({ ok: true, device_token: token }, 200, path);
    }

    // ---- device: poll for next command (POST; token in body only) ----
    if (path === "/poll" && req.method === "POST") {
      const d = await requireDevice(req, env, body);
      if (d.err) return d.err;
      // Single KV read — never a list (see header comment for why).
      const qk = queueKey(d.token);
      const queue = (await env.BRIDGE.get(qk, "json")) || [];
      if (!queue.length) return new Response(null, { status: 204, headers: corsHeaders(path) });
      const cmd = queue.shift();
      if (queue.length) {
        await env.BRIDGE.put(qk, JSON.stringify(queue), { expirationTtl: 600 });
      } else {
        await env.BRIDGE.delete(qk);
      }
      return json({ cmd }, 200, path);
    }

    // ---- device: post a command result ----
    if (path === "/result" && req.method === "POST") {
      const d = await requireDevice(req, env, body);
      if (d.err) return d.err;
      const id = body && body.id;
      if (!id) return json({ error: "missing_id" }, 400, path);
      await env.BRIDGE.put(
        "res:" + id,
        JSON.stringify({
          ok: !!body.ok,
          data: body.data || null,
          error: body.error || null,
          finished_at: Date.now(),
        }),
        { expirationTtl: 600 }
      );
      return json({ ok: true }, 200, path);
    }

    return json({ error: "not_found" }, 404, path);
}
