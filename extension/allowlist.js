/* Juno Bridge — site allowlist matching, shared by background.js and options.js. */

// Reduce whatever the user typed ("https://GitHub.com/foo", "*.github.com",
// "github.com:443") to the bare host the matcher compares against.
// Returns "" for entries that can't be a host.
function normalizeSiteEntry(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "*") return "*";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.replace(/[/?#].*$/, ""); // path, query, fragment
  s = s.replace(/^[^@]*@/, ""); // userinfo
  s = s.replace(/^\*\./, ""); // "*.example.com" means example.com and its subdomains anyway
  s = s.replace(/^\.+|\.+$/g, "");
  if (!s) return "";
  try {
    // Lets the URL parser handle ports, IDN → punycode, and junk.
    return new URL("http://" + s).hostname;
  } catch {
    return "";
  }
}

function hostAllowed(hostname, allowlist) {
  if (!hostname) return false;
  for (const raw of allowlist) {
    const entry = normalizeSiteEntry(raw);
    if (!entry) continue;
    if (entry === "*") return true;
    if (hostname === entry || hostname.endsWith("." + entry)) return true;
  }
  return false;
}

function urlAllowed(url, allowlist) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return hostAllowed(u.hostname.toLowerCase(), allowlist);
  } catch {
    return false;
  }
}
