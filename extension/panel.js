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

// What the background worker last heard from the relay.
const RELAY_STATES = {
  ok: ["dot", "Active — connected, listening for Juno's commands."],
  "ok/live": ["dot", "Active — live connection, commands arrive instantly."],
  "ok/polling": ["dot", "Active — connected by polling (live connection unavailable)."],
  unreachable: ["dot warn", "Active, but the relay is unreachable — retrying."],
  error: ["dot warn", "Active, but the relay is returning errors — retrying."],
  rejected: ["dot bad", "The relay no longer recognises this browser — re-pair in Options."],
};

async function refresh() {
  const s = await chrome.storage.local.get({
    deviceToken: null, enabled: true, allowlist: [], log: [], relayStatus: null,
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
    const rs = s.relayStatus || {};
    const [cls, text] = RELAY_STATES[rs.state + "/" + rs.via] || RELAY_STATES[rs.state] ||
      ["dot warn", "Active — connecting to the relay…"];
    dot.className = cls;
    statusText.textContent = text;
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
    if (e.error) {
      const why = document.createElement("span");
      why.className = "err";
      why.textContent = e.error;
      li.appendChild(why);
    }
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

// Covers log entries, pause/resume, pairing and relay status alike.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") refresh();
});
refresh();
