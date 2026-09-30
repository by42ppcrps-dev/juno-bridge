/* Juno Bridge — options page */

const relayUrl = document.getElementById("relayUrl");
const pairState = document.getElementById("pairState");
const deviceNameInput = document.getElementById("deviceName");
const codeInput = document.getElementById("code");
const registerBtn = document.getElementById("registerBtn");
const unregisterBtn = document.getElementById("unregisterBtn");
const allowlistInput = document.getElementById("allowlist");
const allowEvalInput = document.getElementById("allowEval");
const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");

relayUrl.textContent = JUNO_RELAY_URL;

function setStatus(msg, cls) {
  status.textContent = msg;
  status.className = cls || "";
}

// Relay errors can come back as HTML (e.g. a Cloudflare error page).
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function postRelay(path, payload) {
  const res = await fetch(JUNO_RELAY_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.error || `relay returned ${res.status}`);
  return data;
}

// Revoke a token on the relay so it stops being valid there, not just here.
async function revokeOnRelay(token) {
  try {
    await postRelay("/unregister", { token });
    return true;
  } catch {
    return false;
  }
}

// Options can be open in more than one tab. Serialize the short storage
// updates across those tabs; leave the relay requests outside the lock so
// Unregister can invalidate a Register whose network response is delayed.
let localPairingQueue = Promise.resolve();
let pagePairingAction = 0;
function withPairingLock(fn) {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request("juno-bridge-options-pairing", fn);
  }
  // Older browsers still serialize clicks from this Options page.
  const result = localPairingQueue.then(fn, fn);
  localPairingQueue = result.catch(() => {});
  return result;
}

async function beginPairingIntent() {
  return withPairingLock(async () => {
    const { pairingIntent, deviceToken } = await chrome.storage.local.get({
      pairingIntent: 0, deviceToken: null,
    });
    const intent = pairingIntent + 1;
    await chrome.storage.local.set({ pairingIntent: intent });
    return { intent, oldToken: deviceToken };
  });
}

function statusIfCurrent(intent, message, cls) {
  return withPairingLock(async () => {
    const state = await chrome.storage.local.get({ pairingIntent: 0 });
    if (state.pairingIntent === intent) setStatus(message, cls);
  });
}

function revokeHelp(token) {
  const id = token.slice(0, 8);
  return `Ask your Juno operator to run python3 driver/jb.py revoke ${id} (device ${id}…).`;
}

async function refresh() {
  const s = await chrome.storage.local.get({
    deviceToken: null, deviceName: "", allowlist: [], allowEval: false,
  });
  if (s.deviceToken) {
    pairState.textContent = `Registered${s.deviceName ? ` as "${s.deviceName}"` : ""} (device ${s.deviceToken.slice(0, 8)}…) — connected to the relay.`;
    unregisterBtn.hidden = false;
    registerBtn.textContent = "Re-pair";
  } else {
    pairState.textContent = "Not registered.";
    unregisterBtn.hidden = true;
    registerBtn.textContent = "Register";
  }
  if (!deviceNameInput.value) deviceNameInput.value = s.deviceName || "";
  allowlistInput.value = s.allowlist.join("\n");
  allowEvalInput.checked = !!s.allowEval;
}

registerBtn.addEventListener("click", async () => {
  const code = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) {
    setStatus("Enter the pairing code your Juno operator gave you.", "err");
    return;
  }
  const action = ++pagePairingAction;
  setStatus("Registering…");
  registerBtn.disabled = true;
  let intent = null;
  try {
    const started = await beginPairingIntent();
    intent = started.intent;
    const name = deviceNameInput.value.trim().slice(0, 60) || "My Chrome";
    const data = await postRelay("/register", { code, name });
    if (!data.device_token) throw new Error("relay sent no device token");
    codeInput.value = "";
    const published = await withPairingLock(async () => {
      const state = await chrome.storage.local.get({ pairingIntent: 0 });
      if (state.pairingIntent !== intent) return false;
      await chrome.storage.local.set({
        // Publish the token and its progress together. Old-device saves use a
        // separate item and cannot overwrite this pairing's initial cursor.
        deviceToken: data.device_token, [`cursor:${data.device_token}`]: 0,
        deviceName: name, enabled: true, relayStatus: null,
      });
      return true;
    });
    if (!published) {
      const revoked = await revokeOnRelay(data.device_token);
      if (!revoked) {
        setStatus(`Registration was cancelled, but its new token could not be revoked. ${revokeHelp(data.device_token)}`, "err");
      } else if (pagePairingAction === action) {
        setStatus("Registration cancelled; its new token was revoked.", "ok");
      }
    } else {
      const oldToken = started.oldToken;
      const revoked = !oldToken || oldToken === data.device_token || await revokeOnRelay(oldToken);
      if (!revoked) {
        setStatus(`Registered, but the previous device could not be revoked. ${revokeHelp(oldToken)}`, "err");
      } else {
        await statusIfCurrent(intent, "Registered. The bridge is active — open the side panel to see it work.", "ok");
      }
    }
  } catch (e) {
    if (intent === null) setStatus("Registration failed: " + e.message, "err");
    else await statusIfCurrent(intent, "Registration failed: " + e.message, "err");
  } finally {
    registerBtn.disabled = false;
  }
  await refresh();
});

unregisterBtn.addEventListener("click", async () => {
  ++pagePairingAction;
  unregisterBtn.disabled = true;
  try {
    const { deviceToken, intent } = await withPairingLock(async () => {
      const state = await chrome.storage.local.get({ pairingIntent: 0, deviceToken: null });
      const nextIntent = state.pairingIntent + 1;
      // Stop polling and invalidate pending registrations before relay I/O.
      await chrome.storage.local.set({ pairingIntent: nextIntent, enabled: false });
      await chrome.storage.local.remove(["deviceToken", "deviceName", "cursor", "legacyCursorToken", "relayStatus"]);
      return { deviceToken: state.deviceToken, intent: nextIntent };
    });
    const revoked = deviceToken ? await revokeOnRelay(deviceToken) : true;
    if (!revoked) {
      setStatus(`Unregistered locally, but the relay could not revoke the device. ${revokeHelp(deviceToken)}`, "err");
    } else {
      await statusIfCurrent(intent, "Unregistered and revoked on the relay. The extension no longer talks to it.", "ok");
    }
  } catch (e) {
    setStatus("Unregistration failed: " + e.message, "err");
  } finally {
    unregisterBtn.disabled = false;
  }
  await refresh();
});

saveBtn.addEventListener("click", async () => {
  const entries = allowlistInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
  const allowlist = [];
  const rejected = [];
  for (const e of entries) {
    const host = normalizeSiteEntry(e);
    if (!host) rejected.push(e);
    else if (!allowlist.includes(host)) allowlist.push(host);
  }
  await chrome.storage.local.set({ allowlist, allowEval: allowEvalInput.checked });
  if (rejected.length) {
    setStatus(`Saved, but skipped entries that aren't domains: ${rejected.join(", ")}`, "err");
  } else if (!allowlist.length) {
    setStatus("Saved — but the allowlist is empty, so Juno can't act on any site yet. Add at least one domain above.", "err");
  } else if (allowlist.includes("*")) {
    setStatus("Saved. Warning: * lets Juno act on every site, including banking and email.", "err");
  } else {
    setStatus("Settings saved.", "ok");
  }
  refresh();
});

refresh();
