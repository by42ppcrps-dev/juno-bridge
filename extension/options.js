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
  setStatus("Registering…");
  registerBtn.disabled = true;
  try {
    const { deviceToken: oldToken } = await chrome.storage.local.get({ deviceToken: null });
    const name = deviceNameInput.value.trim().slice(0, 60) || "My Chrome";
    const data = await postRelay("/register", { code, name });
    if (!data.device_token) throw new Error("relay sent no device token");
    await chrome.storage.local.set({
      deviceToken: data.device_token, deviceName: name, enabled: true, cursor: 0, relayStatus: null,
    });
    if (oldToken && oldToken !== data.device_token) await revokeOnRelay(oldToken);
    codeInput.value = "";
    setStatus("Registered. The bridge is active — open the side panel to see it work.", "ok");
  } catch (e) {
    setStatus("Registration failed: " + e.message, "err");
  } finally {
    registerBtn.disabled = false;
  }
  refresh();
});

unregisterBtn.addEventListener("click", async () => {
  const { deviceToken } = await chrome.storage.local.get({ deviceToken: null });
  // Stop polling first, then revoke; the local token goes either way.
  await chrome.storage.local.set({ enabled: false });
  const revoked = deviceToken ? await revokeOnRelay(deviceToken) : true;
  await chrome.storage.local.remove(["deviceToken", "deviceName", "cursor", "relayStatus"]);
  setStatus(
    revoked
      ? "Unregistered and revoked on the relay. The extension no longer talks to it."
      : "Unregistered locally, but the relay couldn't be reached to revoke the token — ask your Juno operator to revoke this device.",
    revoked ? "ok" : "err"
  );
  refresh();
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
