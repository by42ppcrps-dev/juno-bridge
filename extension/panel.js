/* Juno Bridge — side panel */

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const toggleBtn = document.getElementById("toggleBtn");
const optionsBtn = document.getElementById("optionsBtn");
const meta = document.getElementById("meta");
const logList = document.getElementById("log");
const emptyLog = document.getElementById("emptyLog");

function fmtTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function refresh() {
  const s = await chrome.storage.local.get({
    deviceToken: null, enabled: true, allowlist: [], log: [],
  });

  if (!s.deviceToken) {
    dot.className = "dot unregistered";
    statusText.textContent = "Not registered — open Options and enter your pairing code.";
    toggleBtn.hidden = true;
  } else if (!s.enabled) {
    dot.className = "dot paused";
    statusText.textContent = "Paused — Juno cannot drive this browser right now.";
    toggleBtn.hidden = false;
    toggleBtn.textContent = "Resume";
    toggleBtn.className = "primary";
  } else {
    dot.className = "dot";
    statusText.textContent = "Active — listening for Juno's commands.";
    toggleBtn.hidden = false;
    toggleBtn.textContent = "Pause";
    toggleBtn.className = "danger";
  }

  const sites = s.allowlist.length ? s.allowlist.join(", ") : "none — add sites in Options";
  meta.textContent = s.deviceToken
    ? `Device ${s.deviceToken.slice(0, 8)}… · relay ${JUNO_RELAY_URL.replace("https://", "")} · sites: ${sites}`
    : `Relay: ${JUNO_RELAY_URL}`;

  logList.innerHTML = "";
  const items = [...s.log].reverse();
  emptyLog.hidden = items.length > 0;
  for (const e of items.slice(0, 30)) {
    const li = document.createElement("li");
    const mark = document.createElement("span");
    mark.className = "t " + (e.ok ? "good" : "bad");
    mark.textContent = e.ok ? "✓" : "✗";
    li.appendChild(mark);
    const tt = document.createElement("span");
    tt.className = "t";
    tt.textContent = fmtTime(e.t);
    li.appendChild(tt);
    li.appendChild(document.createTextNode(`${e.action}${e.target ? " — " + e.target.slice(0, 80) : ""}`));
    logList.appendChild(li);
  }
}

toggleBtn.addEventListener("click", async () => {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  await chrome.storage.local.set({ enabled: !enabled });
  refresh();
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "juno-log") refresh();
});

chrome.storage.onChanged.addListener(refresh);
refresh();
