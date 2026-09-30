#!/usr/bin/env node
// Explicit local integration check; intentionally outside Node's default test discovery.
// Existing Miniflare, Playwright, Chrome and openssl are required. No packages are installed.
// JUNO_PLAYWRIGHT_MODULE / JUNO_MINIFLARE_MODULE may name existing module entry points.
// JUNO_CHROME_PATH may select an installed Chrome with Extensions.loadUnpacked support.
// Only loopback endpoints, synthetic data, and a fresh disposable browser profile are used.
// Optional dedicated staging mode: JUNO_AUDIT_RELAY_URL=https://...audit-....workers.dev
// and JUNO_AUDIT_PSK_FILE=/outside/repository/private-mode-0600-file. Never deploys.
// JUNO_AUDIT_SKIP_HALF_OPEN_BODY=1 may explicitly omit staging ingress-buffered
// probes; local mode always verifies the half-open body protections.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
function dependency(name, variable) {
  try { return require.resolve(process.env[variable] || name); }
  catch { throw new Error(`Install/use an existing ${name}; set ${variable} to its entry point. This script installs nothing.`); }
}
const miniflarePath = dependency("miniflare", "JUNO_MINIFLARE_MODULE");
const { Miniflare, convertV4MiniflareOptions } = require(miniflarePath);
const { chromium } = require(dependency("playwright", "JUNO_PLAYWRIGHT_MODULE"));
const WebSocket = createRequire(miniflarePath)("ws");
const chromePath = process.env.JUNO_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
assert.ok(fs.existsSync(chromePath), "Set JUNO_CHROME_PATH to an installed Chrome executable");
assert.equal(spawnSync("openssl", ["version"], { stdio: "ignore" }).status, 0, "openssl is required to create a disposable fixture CA");

const staging = process.env.JUNO_AUDIT_RELAY_URL ? new URL(process.env.JUNO_AUDIT_RELAY_URL) : null;
if (staging) {
  assert.ok(staging.protocol === "https:" && /(?:^|[.-])(?:audit|staging)-/.test(staging.hostname) &&
    staging.hostname.endsWith(".workers.dev") && staging.pathname === "/" &&
    !staging.username && !staging.password && !staging.search && !staging.hash,
  "Remote mode requires a dedicated HTTPS audit-/staging- Worker, not a production relay");
}
const skipHalfOpenBody = process.env.JUNO_AUDIT_SKIP_HALF_OPEN_BODY === "1";
assert.ok(!skipHalfOpenBody || staging, "Skipping half-open body checks is allowed only for dedicated staging mode");
function stagingPassphrase() {
  const configured = process.env.JUNO_AUDIT_PSK_FILE;
  assert.ok(configured, "Staging mode requires JUNO_AUDIT_PSK_FILE");
  const file = path.resolve(configured), relative = path.relative(root, file);
  assert.ok(relative.startsWith(".." + path.sep), "Keep the staging credential outside the repository");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    assert.ok(info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.size <= 4096,
      "Staging credential must be an owner-controlled regular mode-0600 file");
    const value = fs.readFileSync(fd, "utf8").trim();
    assert.ok(value.length >= 12 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value), "Invalid staging credential file");
    return value;
  } finally { fs.closeSync(fd); }
}
const passphrase = staging ? stagingPassphrase() : "synthetic-local-audit-passphrase-only";
const hash = crypto.createHash("sha256").update(passphrase).digest("hex");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "juno-audit-"));
const certificate = path.join(temporary, "localhost.pem");
const privateKey = path.join(temporary, "localhost-key.pem");
const certificateConfig = path.join(temporary, "localhost.cnf");
let ca, spki;
try {
  fs.writeFileSync(certificateConfig, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  const certificateResult = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", certificateConfig, "-keyout", privateKey, "-out", certificate], { encoding: "utf8" });
  assert.equal(certificateResult.status, 0, "fixture certificate generation failed");
  fs.chmodSync(privateKey, 0o600);
  ca = fs.readFileSync(certificate);
  const publicKey = new crypto.X509Certificate(ca).publicKey.export({ type: "spki", format: "der" });
  spki = crypto.createHash("sha256").update(publicKey).digest("base64");
} catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
const report = { runtime: staging ? "externally provisioned isolated Cloudflare staging" : "local workerd",
  deploymentByThisScript: false, paidProviderCalls: 0, normalChromeProfilesTouched: false, checks: [], limitations: [] };
const sockets = new Set();
const registeredDevices = new Set();
const counts = new Map();
let mf, upstream, front, context, operator, base, fallback = false;
let phase = "runtime setup";
const admin = { Authorization: "Bearer " + passphrase };
const fixture = '<!doctype html><title>Audit invoice fixture</title><h1>Invoices</h1><button id="invoice" onclick="document.getElementById(\'status\').textContent=\'Invoice ready\'; window.clicks=(window.clicks||0)+1">Download invoice</button><p id="status">Waiting</p><input type="password" value="synthetic-secret-not-a-credential">';

function checked(name) { report.checks.push(name); console.log("PASS " + name); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(fn, description, timeout = 15000) {
  phase = description;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await pause(100); }
  throw new Error("Timed out: " + description);
}
function mfOptions() {
  const opts = {
    name: "juno-audit-local", modules: true, scriptPath: path.join(root, "relay/worker.js"),
    compatibilityDate: "2026-09-01", host: "127.0.0.1", port: 0,
    durableObjects: { HUB: { className: "BridgeHub", useSQLite: true } },
    durableObjectsPersist: path.join(temporary, "durable-state"),
    // Miniflare 5 uses this root for all isolated storage when sharing is off.
    resourcePersistencePath: path.join(temporary, "durable-state"),
    isolatedResourcePersistencePath: path.join(temporary, "durable-state"),
    bindings: { ADMIN_PSK_SHA256: hash },
  };
  return convertV4MiniflareOptions ? convertV4MiniflareOptions(opts) : opts;
}
async function startRelay() {
  if (staging) { upstream = staging; return; }
  mf = new Miniflare(mfOptions()); upstream = await mf.ready;
}
async function restartRelay() { await mf.dispose(); await startRelay(); }

function request(route, { method = "POST", body, headers = {}, timeout = 25000, end = true } = {}) {
  phase = method + " " + route.split("?")[0];
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
    const req = https.request(base + route, { method, ca, rejectUnauthorized: true, headers: { "Content-Type": "application/json", ...headers } }, res => {
      const chunks = []; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > 25 * 1024 * 1024) req.destroy(new Error("oversized fixture response")); else chunks.push(chunk); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: data, headers: res.headers });
        if (!end) req.destroy();
      });
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error("fixture request timed out: " + route.split("?")[0])));
    req.on("error", reject);
    if (encoded !== undefined) req.write(encoded);
    if (end) req.end();
    else req.flushHeaders();
  });
}
async function call(route, body, headers = admin, method = "POST") {
  const result = await request(route, { body, headers, method });
  assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.body)}`);
  return result.body;
}
async function register(name) {
  const pairing = await call("/admin/pair", {});
  const result = await call("/register", { code: pairing.code, name }, {});
  assert.match(result.device_token, /^[0-9a-f]{64}$/);
  registeredDevices.add(result.device_token);
  return result.device_token;
}
function wsAttempt(protocols = [], origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^https/, "wss") + "/ws", protocols, { ca, rejectUnauthorized: true, handshakeTimeout: 3000, headers: origin ? { Origin: origin } : {} });
    ws.once("open", () => { sockets.add(ws); ws.once("close", () => sockets.delete(ws)); resolve({ ws, status: 101 }); });
    ws.once("unexpected-response", (_req, res) => { res.resume(); resolve({ status: res.statusCode }); });
    ws.once("error", error => { if (error.message.includes("Unexpected server response")) return; reject(error); });
  });
}
async function welcome(ws) {
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no WebSocket welcome")), 3000);
    ws.once("message", value => { clearTimeout(timer); resolve(JSON.parse(value.toString())); });
  });
  ws.send(JSON.stringify({ type: "hello", after: 0, version: "local-audit" }));
  assert.equal((await message).type, "welcome");
}
function socketMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", receive); reject(new Error("missing socket message: " + type)); }, 5000);
    function receive(value) {
      let parsed; try { parsed = JSON.parse(value.toString()); } catch { return; }
      if (parsed.type !== type) return;
      clearTimeout(timer); ws.off("message", receive); resolve(parsed);
    }
    ws.on("message", receive);
  });
}
async function cli(...args) {
  phase = "CLI " + args[0];
  return new Promise((resolve, reject) => {
    const processChild = spawn("python3", [path.join(root, "driver/jb.py"), ...args], { env: operatorEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { processChild.kill("SIGKILL"); reject(new Error("CLI timed out: " + args[0])); }, 65000);
    processChild.stdout.on("data", chunk => out += chunk);
    processChild.stderr.on("data", chunk => err += chunk);
    processChild.on("error", reject);
    processChild.on("close", code => {
      clearTimeout(timer);
      // The public driver returns nonzero for a correctly refused browser
      // command; preserve its structured result for the refusal assertions.
      let refused = false;
      if (args[0] === "send") { try { refused = JSON.parse(out).ok === false; } catch {} }
      if (code !== 0 && !refused) reject(new Error(`${args[0]} failed: ${err}`)); else resolve(out);
    });
  });
}
let operatorEnvironment;
async function startOperator() {
  const directory = path.join(temporary, "operator"); fs.mkdirSync(directory, { mode: 0o700 });
  operatorEnvironment = { PATH: process.env.PATH, JUNO_OPERATOR_DIR: directory, JUNO_JEV_CONFIG_DIR: directory,
    JUNO_OPERATOR_SOCK: path.join(directory, "operator.sock"), JUNO_OPERATOR: "1", JUNO_JEV: "0", JUNO_BRIDGE_PSK: passphrase,
    NO_PROXY: "*", no_proxy: "*", CURL_CA_BUNDLE: certificate };
  await cli("init", base);
  // Trust only this generated CA in the real libcurl session; verification stays enabled.
  // CURLOPT_CAINFO = 10065. This is a test-only process, not a driver configuration change.
  const source = `import ctypes, importlib.util\ns=importlib.util.spec_from_file_location('isolated_operator',${JSON.stringify(path.join(root, "driver/juno_operator.py"))})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nc=m.LibcurlSession()\nc.fixture_ca=${JSON.stringify(certificate)}.encode()\nc._setopt(10065,c.fixture_ca,ctypes.c_char_p)\nm.serve(client=c)\n`;
  operator = spawn("python3", ["-c", source], { env: operatorEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  let operatorError = ""; operator.stderr.on("data", chunk => operatorError += chunk);
  await waitUntil(() => fs.existsSync(path.join(directory, "operator.sock")) || operator.exitCode !== null, "local operator starts");
  assert.equal(operator.exitCode, null, "operator startup failed: " + operatorError);
  assert.equal(JSON.parse(await cli("ping")).ok, true);
}

async function main() {
  await startRelay();
  front = https.createServer({ cert: ca, key: fs.readFileSync(privateKey) }, (req, res) => {
    counts.set(req.url, (counts.get(req.url) || 0) + 1);
    if (req.url === "/fixture") { res.setHeader("Content-Type", "text/html"); res.end(fixture); return; }
    if (fallback && req.url === "/ws-ticket") {
      const origin = req.headers.origin;
      if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
      res.setHeader("Access-Control-Allow-Headers", "content-type"); res.writeHead(req.method === "OPTIONS" ? 204 : 404); res.end(); req.resume(); return;
    }
    const destination = new URL(req.url, upstream);
    if (destination.origin !== upstream.origin) { res.writeHead(400); res.end(); return; }
    const transport = upstream.protocol === "https:" ? https : http;
    const forward = transport.request(destination, { method: req.method, rejectUnauthorized: true, headers: { ...req.headers, host: upstream.host } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    forward.on("error", () => { if (!res.headersSent) res.writeHead(503); res.end(); });
    req.on("aborted", () => forward.destroy()); forward.flushHeaders(); req.pipe(forward);
  });
  front.on("upgrade", (req, downstream, head) => {
    const destination = new URL(req.url, upstream);
    if (destination.origin !== upstream.origin) { downstream.destroy(); return; }
    const transport = upstream.protocol === "https:" ? https : http;
    const forward = transport.request(destination, { rejectUnauthorized: true, headers: { ...req.headers, host: upstream.host } });
    forward.on("upgrade", (response, socket, upstreamHead) => {
      downstream.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n` + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") + "\r\n");
      if (head.length) socket.write(head); if (upstreamHead.length) downstream.write(upstreamHead);
      socket.pipe(downstream); downstream.pipe(socket);
      sockets.add(downstream); sockets.add(socket);
      downstream.on("close", () => { sockets.delete(downstream); socket.destroy(); });
      socket.on("close", () => { sockets.delete(socket); downstream.destroy(); });
      socket.on("error", () => downstream.destroy()); downstream.on("error", () => socket.destroy());
    });
    forward.on("response", response => {
      downstream.write(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      response.resume(); downstream.end();
    });
    forward.on("error", () => downstream.destroy()); forward.end();
  });
  await new Promise(resolve => front.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${front.address().port}`;
  assert.equal((await request("/", { method: "GET" })).body.configured, true);
  await startOperator();

  for (let i = 0; i < 20; i++) assert.equal((await wsAttempt()).status, 403);
  const token = await register("synthetic durable-result probe");
  const ticket = await call("/ws-ticket", { token }, {});
  const protocols = ["juno-bridge-v1", "juno-ticket." + ticket.ticket];
  const accepted = await wsAttempt(protocols);
  assert.equal(accepted.status, 101); assert.equal(accepted.ws.protocol, "juno-bridge-v1"); await welcome(accepted.ws);
  assert.equal((await wsAttempt(protocols)).status, 403);
  accepted.ws.close();
  const racingTicket = await call("/ws-ticket", { token }, {});
  const racingProtocols = ["juno-bridge-v1", "juno-ticket." + racingTicket.ticket];
  const racers = await Promise.all([wsAttempt(racingProtocols), wsAttempt(racingProtocols)]);
  assert.deepEqual(racers.map(item => item.status).sort(), [101, 403]);
  const winner = racers.find(item => item.ws).ws; await welcome(winner); winner.close();
  const originTicket = await call("/ws-ticket", { token }, { Origin: "chrome-extension://fixture-a" });
  assert.equal((await wsAttempt(["juno-bridge-v1", "juno-ticket." + originTicket.ticket], "chrome-extension://fixture-b")).status, 403);
  checked("anonymous upgrade rejection, authenticated token-free hello, ticket replay/race rejection and origin binding");

  if (!staging && process.env.JUNO_AUDIT_FORCE_HIBERNATION === "1") {
  const hibernationTicket = await call("/ws-ticket", { token }, {});
  const hibernated = (await wsAttempt(["juno-bridge-v1", "juno-ticket." + hibernationTicket.ticket])).ws;
  await welcome(hibernated);
  assert.equal(typeof mf.unsafeEvictDurableObject, "function", "local runtime must support explicit hibernation verification");
  phase = "forced Durable Object socket hibernation";
  let evictionTimer;
  try {
    await Promise.race([
      mf.unsafeEvictDurableObject("juno-audit-local", "BridgeHub", { name: "juno-bridge", webSockets: "hibernate" }),
      new Promise((_, reject) => { evictionTimer = setTimeout(() => reject(new Error("local dev-control eviction timed out")), 5000); }),
    ]);
  } finally { clearTimeout(evictionTimer); }
  const [delivered, wake] = await Promise.all([socketMessage(hibernated, "cmd"),
    call("/admin/cmd", { action: "ping", params: {}, device: token, request_id: "audit_hibernation_identity" })]);
  assert.equal(delivered.cmd.id, wake.id);
  const receipt = socketMessage(hibernated, "result_ack");
  hibernated.send(JSON.stringify({ type: "ack", seq: delivered.cmd.seq }));
  hibernated.send(JSON.stringify({ type: "result", id: wake.id, ok: true, data: { fixture: "hibernation wake" } }));
  assert.equal((await receipt).id, wake.id);
  assert.equal((await call(`/admin/result?id=${wake.id}&wait=0`, undefined, admin, "GET")).result.data.fixture, "hibernation wake");
  hibernated.close();
  checked("authenticated socket attachment survives real Durable Object hibernation and result acknowledgement");
  } else {
    report.limitations.push("Forced socket hibernation is not covered by this run; the installed Miniflare alpha dev-control call stalled/reset in isolated probes.");
  }

  const requestId = "audit_large_result_once";
  const command = { action: "screenshot", params: { tabId: 1 }, device: token, request_id: requestId };
  const queued = await call("/admin/cmd", command);
  const polled = await call("/poll", { token, after: 0 }, {}); assert.equal(polled.cmd.id, queued.id);
  const result = { token, id: queued.id, ok: true, data: { image: "data:image/jpeg;base64," + "a".repeat(1_200_000), marker: "synthetic-large-result" } };
  assert.equal((await call("/result", result, {})).ok, true);
  if (!staging) await restartRelay();
  const primary = await call(`/admin/result?id=${queued.id}&wait=0`, undefined, admin, "GET");
  assert.equal(primary.pending, false); assert.equal(primary.result.data.image, result.data.image);
  const repeated = await call("/admin/run", { ...command, wait: 0 });
  assert.equal(repeated.duplicate, true); assert.equal(repeated.pending, false); assert.equal(repeated.result.data.image, result.data.image);
  if (!staging) await restartRelay();
  assert.equal((await call("/admin/run", { ...command, wait: 0 })).result.data.image, result.data.image);
  assert.equal((await call("/result", result, {})).duplicate, true);
  checked(staging ? "deployed relay persists a 1.2 MB result and replays it after primary consumption" :
    "1.2 MB result survives runtime restart and primary consumption; idempotent result survives a second restart");
  await call("/admin/revoke", { device: token });
  registeredDevices.delete(token);
  assert.equal((await request("/poll", { body: { token, after: 0 } })).status, 403);
  assert.equal((await request(`/admin/result?id=${queued.id}&wait=0`, { method: "GET", headers: admin })).status, 404);
  if (!staging) await restartRelay();
  assert.equal((await request(`/admin/result?id=${queued.id}&wait=0`, { method: "GET", headers: admin })).status, 404);
  checked(staging ? "deployed relay revocation invalidates device authentication and retained primary result" :
    "revocation invalidates device authentication and removes retained primary result across restart");

  const extension = path.join(temporary, "extension"); fs.cpSync(path.join(root, "extension"), extension, { recursive: true });
  fs.writeFileSync(path.join(extension, "config.js"), `const JUNO_RELAY_URL = ${JSON.stringify(base)};\n`);
  const manifestPath = path.join(extension, "manifest.json"); const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.host_permissions = ["https://127.0.0.1/*"]; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(path.join(temporary, "chrome-profile"), {
    executablePath: chromePath, headless: true, ignoreDefaultArgs: ["--disable-extensions"], timeout: 20000,
    args: ["--enable-unsafe-extension-debugging", `--ignore-certificate-errors-spki-list=${spki}`, "--disable-background-networking", "--disable-component-update", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
  });
  report.browser = context.browser().version();
  const cdp = await context.browser().newBrowserCDPSession();
  const installed = await cdp.send("Extensions.loadUnpacked", { path: extension });
  let worker = context.serviceWorkers().find(item => item.url().startsWith(`chrome-extension://${installed.id}/`));
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
  const options = await context.newPage(); await options.goto(`chrome-extension://${installed.id}/options.html`);
  await options.locator("#allowlist").fill("127.0.0.1"); await options.locator("#saveBtn").click();
  const pairingOutput = await cli("pair"); const pairingCode = pairingOutput.match(/Pairing code:\s*([A-Z0-9]{8})/)[1];
  await options.locator("#deviceName").fill("isolated audit Chrome"); await options.locator("#code").fill(pairingCode); await options.locator("#registerBtn").click();
  await waitUntil(() => options.locator("#status").textContent().then(text => text.startsWith("Registered.")), "actual extension pairs");
  await waitUntil(() => worker.evaluate(async () => (await chrome.storage.local.get("relayStatus")).relayStatus?.via === "live"), "authenticated extension WebSocket", 20000);
  let browserToken = await worker.evaluate(async () => (await chrome.storage.local.get("deviceToken")).deviceToken);
  assert.match(browserToken, /^[0-9a-f]{64}$/);
  registeredDevices.add(browserToken);
  assert.ok((counts.get("/ws-ticket") || 0) > 0);
  checked("real Chrome Options pairing and authenticated ticket WebSocket");
  const page = await context.newPage(); await page.goto(base + "/fixture");
  const tabs = JSON.parse(await cli("send", "tabs"));
  const tab = tabs.data.tabs.find(item => item.url === base + "/fixture"); assert.ok(tab, "fixture tab appears in driver response");
  const snapshot = JSON.parse(await cli("send", "snapshot", JSON.stringify({ tabId: tab.id })));
  assert.equal(snapshot.ok, true); assert.match(snapshot.data.snapshot, /^snap_[0-9a-f]{32}$/);
  const target = snapshot.data.elements.find(item => item.text === "Download invoice"); assert.ok(target);
  const workflow = JSON.parse(await cli("send", "workflow", JSON.stringify({ tabId: tab.id, snapshot: snapshot.data.snapshot, steps: [{ op: "click", ref: target.ref, expect: { tag: target.tag, text: target.text }, after: { ready: { type: "text", text: "Invoice ready", timeoutMs: 1000 }, observe: "snapshot" } }] })));
  assert.equal(workflow.ok, true); assert.equal(workflow.data.status, "completed");
  assert.notEqual(workflow.data.observation.snapshot, snapshot.data.snapshot);
  assert.equal(await page.evaluate(() => window.clicks), 1);
  checked("real CLI snapshot and one bound workflow click return a fresh observation over WebSocket");
  if (!staging) {
    const issuedTickets = counts.get("/ws-ticket") || 0;
    await restartRelay();
    await waitUntil(async () => (counts.get("/ws-ticket") || 0) > issuedTickets &&
      await worker.evaluate(async () => (await chrome.storage.local.get("relayStatus")).relayStatus?.via === "live"), "real browser reconnects after runtime restart", 20000);
    assert.equal(JSON.parse(await cli("send", "snapshot", JSON.stringify({ tabId: tab.id }))).ok, true);
    assert.equal(await page.evaluate(() => window.clicks), 1);
    checked("actual extension reconnects with a fresh ticket after relay restart without replaying its click");
  } else {
    report.limitations.push("Cloudflare runtime restart/eviction is not forced; those durability checks run in local workerd mode.");
  }

  // Test-only interception in this disposable extension: hold an actual native
  // screenshot reply after Chrome produced it, then change document/policy.
  // The production source and the user's browser profile are never modified.
  await worker.evaluate(() => {
    globalThis.auditOriginalSendCommand = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = async (...args) => {
      const result = await globalThis.auditOriginalSendCommand(...args);
      if (args[1] === "Page.captureScreenshot" && globalThis.auditHoldScreenshot) {
        globalThis.auditHoldScreenshot = false;
        globalThis.auditScreenshotHeld = true;
        await new Promise(resolve => { globalThis.auditReleaseScreenshot = resolve; });
      }
      return result;
    };
  });
  async function holdScreenshot() {
    await worker.evaluate(() => { globalThis.auditScreenshotHeld = false; globalThis.auditHoldScreenshot = true; });
    const response = cli("send", "screenshot", JSON.stringify({ tabId: tab.id }));
    await waitUntil(() => worker.evaluate(() => globalThis.auditScreenshotHeld === true), "native screenshot reply is held");
    return { response };
  }
  const fixtureCdp = await context.newCDPSession(page);
  const originalLoader = (await fixtureCdp.send("Page.getFrameTree")).frameTree.frame.loaderId;
  const staleScreenshot = await holdScreenshot();
  await page.reload();
  const reloadedLoader = (await fixtureCdp.send("Page.getFrameTree")).frameTree.frame.loaderId;
  assert.notEqual(reloadedLoader, originalLoader, "native loader identity changes on same-URL reload");
  await worker.evaluate(() => globalThis.auditReleaseScreenshot());
  const staleResult = JSON.parse(await staleScreenshot.response);
  assert.equal(staleResult.ok, false); assert.match(staleResult.error, /document changed|navigated|detached/);
  assert.ok(!staleResult.data?.image, "stale screenshot pixels must not escape");
  checked("held real native screenshot is discarded after same-URL reload with changed Chrome loader identity");

  const permissionScreenshot = await holdScreenshot();
  await worker.evaluate(async () => { await chrome.storage.local.set({ allowlist: [] }); });
  await worker.evaluate(() => globalThis.auditReleaseScreenshot());
  const permissionResult = JSON.parse(await permissionScreenshot.response);
  assert.equal(permissionResult.ok, false); assert.match(permissionResult.error, /cancelled|allowlist|detached/);
  assert.ok(!permissionResult.data?.image, "screenshot held across permission revocation must not escape");
  await options.locator("#allowlist").fill("127.0.0.1"); await options.locator("#saveBtn").click();
  await worker.evaluate(() => { chrome.debugger.sendCommand = globalThis.auditOriginalSendCommand; });
  await fixtureCdp.detach();
  checked("held real native screenshot is discarded after actual storage permission revocation");

  // Hold an old device's receipt immediately before Chrome applies it, then
  // perform a real new Options pairing. Storage calls from different contexts
  // may arrive in this order; old progress must never suppress the new queue.
  const oldBrowserToken = browserToken;
  const nextCode = (await cli("pair")).match(/Pairing code:\s*([A-Z0-9]{8})/)[1];
  await worker.evaluate(token => {
    globalThis.auditOriginalStorageSet = chrome.storage.local.set.bind(chrome.storage.local);
    globalThis.auditHeldCursor = false;
    globalThis.auditHoldCursorOnce = true;
    globalThis.auditCursorApplied = false;
    chrome.storage.local.set = async values => {
      if (globalThis.auditHoldCursorOnce && !Object.hasOwn(values, "deviceToken") &&
          Object.hasOwn(values, "cursor:" + token)) {
        globalThis.auditHoldCursorOnce = false;
        globalThis.auditHeldCursor = true;
        await new Promise(resolve => { globalThis.auditReleaseCursor = resolve; });
        await globalThis.auditOriginalStorageSet(values);
        globalThis.auditCursorApplied = true;
        return;
      }
      return globalThis.auditOriginalStorageSet(values);
    };
  }, oldBrowserToken);
  try {
    // Direct enqueue avoids blocking the operator while Options re-pair may
    // revoke the old owner and wake its pending result wait.
    await call("/admin/cmd", { action: "snapshot", params: { tabId: tab.id }, device: oldBrowserToken });
    await waitUntil(() => worker.evaluate(() => globalThis.auditHeldCursor === true), "old-device cursor receipt held before application");
    await options.locator("#deviceName").fill("isolated audit re-pair");
    await options.locator("#code").fill(nextCode); await options.locator("#registerBtn").click();
    await waitUntil(async () => {
      browserToken = await worker.evaluate(async () => (await chrome.storage.local.get("deviceToken")).deviceToken);
      return browserToken && browserToken !== oldBrowserToken;
    }, "actual Options changes device identity while old receipt is held");
    registeredDevices.add(browserToken);
    await worker.evaluate(() => globalThis.auditReleaseCursor());
    await waitUntil(() => worker.evaluate(() => globalThis.auditCursorApplied === true), "old-device cursor write applies after re-pair");
    assert.equal(await worker.evaluate(async () => (await getState()).cursor), 0,
      "old receipt cannot overwrite the new device's initial progress");
    await worker.evaluate(() => { chrome.storage.local.set = globalThis.auditOriginalStorageSet; });
    await waitUntil(() => worker.evaluate(async () => (await chrome.storage.local.get("relayStatus")).relayStatus?.via === "live"), "re-paired extension connects with its own ticket", 20000);
    const pairedSnapshot = JSON.parse(await cli("send", "snapshot", JSON.stringify({ tabId: tab.id })));
    assert.equal(pairedSnapshot.ok, true);
    assert.ok(await worker.evaluate(async () => (await getState()).cursor) > 0,
      "new device runs its first command despite the late old-device receipt");
    const oldDevice = await request("/admin/revoke", { body: { device: oldBrowserToken }, headers: admin });
    assert.ok(oldDevice.status === 200 || oldDevice.status === 404); registeredDevices.delete(oldBrowserToken);
    checked("held real old-device cursor write cannot suppress the actual new pairing's first snapshot command");
  } finally {
    await worker.evaluate(() => {
      globalThis.auditReleaseCursor?.();
      chrome.storage.local.set = globalThis.auditOriginalStorageSet;
    }).catch(() => {});
  }

  fallback = true;
  await worker.evaluate(async () => { await chrome.storage.local.set({ enabled: false }); });
  await pause(100);
  await worker.evaluate(async () => { await chrome.storage.local.set({ enabled: true }); });
  await waitUntil(() => worker.evaluate(async () => (await chrome.storage.local.get("relayStatus")).relayStatus?.via === "polling"), "HTTP fallback after missing ticket endpoint", 20000);
  assert.equal(JSON.parse(await cli("send", "snapshot", JSON.stringify({ tabId: tab.id }))).ok, true);
  assert.ok((counts.get("/poll") || 0) > 0); assert.ok((counts.get("/result") || 0) > 1);
  checked("real extension HTTP polling/result fallback when ticket endpoint returns 404");
  await cli("revoke", browserToken.slice(0, 8));
  registeredDevices.delete(browserToken);
  assert.equal((await request("/poll", { body: { token: browserToken, after: 0 } })).status, 403);
  await waitUntil(() => worker.evaluate(async () => (await chrome.storage.local.get("relayStatus")).relayStatus?.state === "rejected"), "extension observes revocation", 15000);
  checked("CLI revoke rejects the real extension's old device token");
  await context.close(); context = null;

  if (skipHalfOpenBody) {
    report.limitations.push("Staging half-open HTTP body probes explicitly omitted because ingress can buffer them before Worker invocation. Early header-only authentication and the 15-second stalled-body deadline are verified only by local-runtime mode.");
    const unauthenticated = await request("/admin/cmd", { body: JSON.stringify({ action: "ping", params: { text: "x".repeat(65536) } }) });
    assert.equal(unauthenticated.status, 401);
    checked("completed unauthenticated body above 64 KiB rejects with 401 before relay body parsing");
  } else {
    const started = Date.now();
    const unauthenticated = await request("/admin/cmd", { headers: { "Content-Length": String(100 * 1024 * 1024) }, end: false, timeout: 3000 });
    assert.equal(unauthenticated.status, 401); assert.ok(Date.now() - started < 2500);
    checked("unauthenticated admin request rejects unfinished declared 100 MiB body before reading it");
  }
  assert.equal((await request("/admin/cmd", { body: JSON.stringify({ action: "ping", params: { text: "x".repeat(65536) } }), headers: admin })).status, 413);
  checked("ordinary authenticated HTTP body is limited to 64 KiB");
  if (!skipHalfOpenBody) {
    const stalled = Date.now();
    const deadlineResult = await request("/admin/pair", { body: "{", headers: { ...admin, "Content-Length": "20" }, end: false, timeout: 20000 });
    assert.equal(deadlineResult.status, 408); assert.ok(Date.now() - stalled < 19000);
  }
  assert.equal((await call("/admin/ping", undefined, admin, "GET")).ok, true);
  checked(skipHalfOpenBody ? "deployed relay remains healthy after completed authorization/body-cap probes" : "absolute stalled-body deadline and healthy recovery");
  report.result = "passed";
}

try { await main(); console.log(JSON.stringify(report, null, 2)); }
catch (error) {
  report.result = "failed";
  // Remote response bodies and child stderr can echo arbitrarily encoded
  // credentials. Publish only a controlled phase and fixed failure class.
  report.error = `${error instanceof assert.AssertionError ? "Assertion" : "Integration"} failed during ${phase}`;
  console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
}
finally {
  if (context) await context.close().catch(() => {});
  // On a partial remote run, remove each device this harness registered.
  // Root also deletes the dedicated staging Worker after verification.
  for (const token of registeredDevices) {
    try { await call("/admin/revoke", { device: token }); } catch { /* isolated staging teardown is the final cleanup boundary */ }
  }
  if (operator && operator.exitCode === null) {
    try { await cli("operator", "stop"); } catch { operator.kill("SIGTERM"); }
    await Promise.race([new Promise(resolve => operator.once("exit", resolve)), pause(2000)]);
    if (operator.exitCode === null) operator.kill("SIGKILL");
  }
  for (const socket of sockets) { try { socket.terminate?.(); socket.destroy?.(); } catch {} }
  if (front) { front.closeAllConnections(); await new Promise(resolve => front.close(resolve)); }
  if (mf) await mf.dispose().catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true });
}
