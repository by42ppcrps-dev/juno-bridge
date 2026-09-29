// Wording locks. They read the repo; they do not load Chrome or deploy a relay.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("manifest identifies the experimental preview", () => {
  const manifest = JSON.parse(read("extension/manifest.json"));
  assert.equal(manifest.version, "1.3.0");
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
  assert.equal(/never leaves your machines/i.test(readme), false);
  assert.equal(/commands stop instantly/i.test(readme), false);
  assert.equal(/Secrets stay put/i.test(readme), false);
  assert.equal(/one-shot: locks the relay/i.test(readme), false);
});

test("the side panel and options page describe pause accurately", () => {
  const panel = read("extension/panel.js");
  const options = read("extension/options.html");
  assert.match(panel, /further commands will not run/);
  assert.match(panel, /already sent to Chrome is not undone/);
  assert.match(options, /Experimental developer preview/);
  assert.match(options, /separate Chrome profile/);
});

test("contributing names the automated checks and the local wait", () => {
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /node --test/);
  assert.match(contributing, /test_\*\.py/);
  assert.match(contributing, /waiting locally/);
  assert.match(contributing, /do not load the extension in Chrome/);
});
