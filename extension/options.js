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

async function refresh() {
  const s = await chrome.storage.local.get({
    deviceToken: null, deviceName: "", allowlist: [], allowEval: false,
  });
  if (s.deviceToken) {
    pairState.textContent = `Registered${s.deviceName ? ` as "${s.deviceName}"` : ""} — polling the relay.`;
    unregisterBtn.hidden = false;
  } else {
    pairState.textContent = "Not registered.";
    unregisterBtn.hidden = true;
  }
  if (!deviceNameInput.value) deviceNameInput.value = s.deviceName || "";
  allowlistInput.value = s.allowlist.join("\n");
  allowEvalInput.checked = !!s.allowEval;
}

registerBtn.addEventListener("click", async () => {
  const code = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) {
    setStatus("Enter the pairing code Juno gave you.", "err");
    return;
  }
  const name = deviceNameInput.value.trim().slice(0, 60) || "My Chrome";
  setStatus("Registering…");
  try {
    const res = await fetch(JUNO_RELAY_URL + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "registration failed");
    await chrome.storage.local.set({ deviceToken: data.device_token, deviceName: name, enabled: true });
    codeInput.value = "";
    setStatus("Registered. The bridge is active — open the side panel to see it work.", "ok");
  } catch (e) {
    setStatus("Registration failed: " + e.message, "err");
  }
  refresh();
});

unregisterBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(["deviceToken", "deviceName"]);
  await chrome.storage.local.set({ enabled: false });
  setStatus("Unregistered. The extension no longer talks to the relay.", "ok");
  refresh();
});

saveBtn.addEventListener("click", async () => {
  const allowlist = allowlistInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
  await chrome.storage.local.set({ allowlist, allowEval: allowEvalInput.checked });
  if (!allowlist.length) {
    setStatus("Saved — but the allowlist is empty, so Juno can't act on any site yet. Add at least one domain above.", "err");
  } else {
    setStatus("Settings saved.", "ok");
  }
  refresh();
});

refresh();
