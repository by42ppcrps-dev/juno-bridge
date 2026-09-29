// Wording locks. They read the repo; they do not load Chrome or deploy a relay.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("manifest identifies the experimental preview", () => {
  const manifest = JSON.parse(read("extension/manifest.json"));
  assert.equal(manifest.version, "1.4.4");
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
  assert.match(readme, /Fixes in 1\.4\.4/);
  assert.match(readme, /element_visible/);
  assert.match(readme, /element_enabled/);
  assert.match(readme, /timeoutMs/);
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
  assert.match(readme, /`jb\.py send` does not call Jev/);
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
  assert.match(contributing, /do not call TypeSafe/);
  assert.match(contributing, /duplicate request ids/);
  assert.match(contributing, /workflows/);
  assert.match(contributing, /operator/);
});

test("readme documents that Jev is optional and billed", () => {
  const readme = read("README.md");
  assert.match(readme, /off until you set `JUNO_JEV=1`/);
  assert.match(readme, /\$0\.042 per million input tokens/);
  assert.match(readme, /https:\/\/docs\.typesafe\.ai\/models/);
  assert.match(readme, /api\.typesafe\.ai/);
  assert.match(readme, /not an\s+invoice/);
  assert.match(readme, /TYPESAFE_API_KEY/);
  assert.match(readme, /billed: false/);
  assert.match(readme, /JUNO_JEV_MIN_CONFIDENCE/);
  const extension = read("extension/background.js");
  const relay = read("relay/worker.js");
  for (const source of [extension, relay]) {
    assert.equal(source.includes("api.typesafe.ai"), false);
    assert.equal(source.includes("TYPESAFE_API_KEY"), false);
  }
});
