// Wording locks. They read the repo; they do not load Chrome or deploy a relay.

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("manifest identifies the experimental preview", () => {
  const manifest = JSON.parse(read("extension/manifest.json"));
  assert.equal(manifest.version, "1.4.8");
  assert.ok(manifest.description.length <= 132, manifest.description);
  assert.match(manifest.description, /Experimental preview/);
  assert.match(manifest.description, /cannot undo one already sent to Chrome/);
});

test("readme states the safeguards the code actually provides", () => {
  const readme = read("README.md");
  const privacy = "The relay stores a hash of the admin passphrase. "
    + "The driver transmits the passphrase over HTTPS for authentication. "
    + "Commands and browser results pass through the relay. "
    + "Snapshot redaction reduces exposure of recognized sensitive fields "
    + "but does not guarantee removal of all sensitive information.";
  assert.ok(readme.includes(privacy), "required privacy paragraph missing");
  assert.match(readme, /Experimental developer preview/);
  assert.match(readme, /An action already sent to Chrome is not\s+undone/);
  assert.match(readme, /Existing-tab commands require `tabId`/);
  assert.match(readme, /time it then waited on/);
  assert.match(readme, /does not continue the in-memory queue/);
  assert.match(readme, /redaction: "none"/);
  assert.match(readme, /result_ack/);
  assert.match(readme, /exits 1/);
  assert.match(readme, /bootstrap_disabled/);
  assert.match(readme, /Fewer round trips in 1\.4\.0/);
  assert.match(readme, /`snap_` plus 32 hex digits/);
  assert.match(readme, /Fixes in 1\.4\.3/);
  assert.match(readme, /Fixes in 1\.4\.5/);
  assert.match(readme, /1 to 10/);
  assert.match(readme, /one debugger attachment/);
  assert.match(readme, /holds the debugger until that workflow finishes/);
  assert.match(readme, /No model call runs inside the workflow/);
  assert.match(readme, /request_id/);
  assert.match(readme, /JUNO_OPERATOR=0/);
  assert.match(readme, /JUNO_BRIDGE_HTTP=curl/);
  assert.match(readme, /Unix socket/);
  assert.match(readme, /Certificate verification stays on/);
  assert.match(readme, /`wait` is a\s+maximum/);
  assert.match(readme, /native messaging/);
  assert.match(readme, /completed`, `cancelled`, `interrupted`, `uncertain`,\s+or `unobserved`/);
  assert.equal(/never leaves your machines/i.test(readme), false);
  assert.equal(/commands stop instantly/i.test(readme), false);
  assert.equal(/Secrets stay put/i.test(readme), false);
  assert.equal(/one-shot: locks the relay/i.test(readme), false);
});

test("the side panel and options page describe pause accurately", () => {
  const panel = read("extension/panel.js");
  const panelHtml = read("extension/panel.html");
  const options = read("extension/options.html");
  assert.match(panel, /further commands will not run/);
  assert.match(panel, /already sent to Chrome is not undone/);
  assert.match(options, /Experimental developer preview/);
  assert.match(options, /separate Chrome profile/);
  assert.match(panelHtml, /holds the debugger until that workflow finishes/);
  assert.match(options, /holds the debugger until that workflow finishes/);
});

test("contributing names the automated checks and the local wait", () => {
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /node --test/);
  assert.match(contributing, /test_\*\.py/);
  assert.match(contributing, /waiting locally/);
  assert.match(contributing, /do not load the extension in Chrome/);
  assert.match(contributing, /duplicate request ids/);
  assert.match(contributing, /workflows/);
  assert.match(contributing, /operator/);
});


test("public Jev docs require opt-in and the user's own key", () => {
  const readme = read("README.md");
  const contributing = read("CONTRIBUTING.md");
  assert.match(readme, /Jev is off by default/);
  assert.match(readme, /your own TypeSafe API key/);
  assert.match(readme, /no bundled key, shared\s+account/);
  for (const command of ["configure", "on", "off", "status"]) {
    assert.ok(readme.includes("python3 driver/jb.py jev " + command), command);
  }
  assert.match(readme, /without echoing your API key/);
  assert.match(readme, /jev-api-key/);
  assert.match(readme, /0600/);
  assert.match(readme, /JUNO_JEV=1/);
  assert.match(readme, /JUNO_JEV=0/);
  assert.match(readme, /TYPESAFE_API_KEY/);
  assert.match(readme, /JUNO_JEV_CONFIG_DIR/);
  assert.match(readme, /When Jev is off, decision commands stop before contacting the relay or\s+TypeSafe/);
  assert.match(readme, /--observation/);
  assert.match(readme, /--after-ready/);
  assert.match(readme, /--click/);
  assert.match(readme, /a model choice does not grant permission/);
  assert.match(readme, /even with Jev off/);
  assert.match(readme, /does not inherently shorten a deterministic relay API call/);
  assert.match(readme, /no measured speedup/);
  assert.match(readme, /no billed calls, live browser actions, or deployments/);
  assert.match(contributing, /standard test suite must remain offline/);
  assert.match(contributing, /tester.s own key/);
});

test("TypeSafe credentials and API calls stay out of the relay and extension", () => {
  const files = ["extension", "relay"].flatMap((directory) =>
    fs.readdirSync(new URL(directory + "/", root), { recursive: true })
      .filter((path) => /\.(?:js|mjs|json|html)$/.test(path) && !/(?:^|\/)(?:node_modules|\.wrangler)(?:\/|$)/.test(path))
      .map((path) => directory + "/" + path)
  );
  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes("TYPESAFE_API_KEY"), false, file + " accepts a TypeSafe key");
    assert.equal(source.includes("api.typesafe.ai"), false, file + " calls TypeSafe");
    assert.equal(source.includes("jev-api-key"), false, file + " reads a TypeSafe key file");
  }
  const readme = read("README.md");
  assert.match(readme, /key stays in the local driver\/operator/);
  assert.match(readme, /never sent to the\s+relay, Chrome extension, or local Unix socket/);
  assert.match(readme, /redaction is heuristic and cannot guarantee removal of every secret/);
});

test("gitignore protects local key and secret paths but permits sanitized examples", () => {
  const ignored = [
    ".env", "driver/.env.local", "relay/.dev.vars", "relay/.dev.vars.production",
    "jev-api-key", "driver/jev-api-key", "driver/typesafe-key", "driver/operator.token",
  ];
  const examples = [".env.example", "driver/.env.local.example", "relay/.dev.vars.example", "jev-api-key.example"];
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    input: [...ignored, ...examples].join("\n") + "\n",
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const matched = new Set(result.stdout.trim().split("\n"));
  for (const path of ignored) assert.ok(matched.has(path), path + " must be ignored");
  for (const path of examples) assert.equal(matched.has(path), false, path + " should be allowed");
});
