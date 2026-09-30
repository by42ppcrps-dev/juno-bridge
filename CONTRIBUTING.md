# Contributing to Juno Bridge

Thanks for wanting to help. This is a small, security-sensitive project — a
few ground rules keep it trustworthy.

## What we're looking for

- Bug fixes, especially around the pairing flow, the command queue, and the
  extension's non-interference behavior (it must never fight the user for
  their mouse, keyboard, or active tab).
- New read-only commands (things that observe pages without changing them).
- Documentation improvements — setup friction is the biggest barrier to
  adoption.

## What needs discussion first

Open an issue before building:

- Any new **state-changing** command (navigate, click, type, key, scroll
  and close already exist; anything beyond those is a security conversation).
- Changes to delivery semantics. Commands are delivered at most once. At
  execution the extension adds the command's age on the relay when it
  arrived to the time spent waiting locally, and refuses the command when
  that sum is over 2 minutes or the timestamps are unusable. Pause drops
  the in-memory queue. A command already taken is cancelled and not retried.
  A command not yet taken stays on the relay; resume may deliver it again,
  and it runs only if it is still inside that window.
- Changes to the auth model, the allowlist semantics, or the kill switch.
- Anything that touches the relay's admin endpoints.

## How to contribute

1. Fork the repo and create a branch from `master`.
2. Keep changes small and focused — one concern per PR.
3. Test end to end: deploy the relay (`cd relay && npx wrangler deploy`),
   pair a browser, and run the new behavior through `driver/jb.py`. If you
   touch the transport, test both the live WebSocket and the HTTP polling
   fallback (the side panel shows which one is active). PRs that were never
   run against a real browser won't be merged.
4. Update the README if your change affects setup or usage.
5. Open the PR with a clear description of what changed and how you tested it.

## Automated checks

From the repo root, with no packages to install:

```bash
node --test
python3 -m unittest discover -s test -p 'test_*.py'
```

`npm test` runs both. The checks cover pause during a click, pause during
a reused-tab navigation, a command that times out and must not resume,
a missing tab id, navigation off the authorized page, local queue delay,
snapshot redaction and its limits, pairing and revocation, result ownership,
reconnection, HTTP polling, result acknowledgement, duplicate request ids,
bounded workflows, the operator process, and the driver's exit status.
Optional Jev checks cover default-off behavior, configuration and override
precedence, private key handling, observation reuse, and refusal of unsafe
or stale clicks. Use fake keys and responses; these checks do not call
TypeSafe, spend API credit, or run live browser actions.
Relay and extension regressions also cover ticket replay and origin binding,
stale pairing replies, permission changes during browser work, stalled body
reads, UTF-8 size limits, durable large results, transactional enqueue failures,
legacy-import retries, revocation cleanup, and bounded storage batches.

They do not load the extension in Chrome and they do not deploy a relay.
Step 3 above is still required before a transport or browser change is merged.

For an additional real local-runtime/browser check, use existing Miniflare,
Playwright, Chrome, and OpenSSL installations:

```bash
node scripts/local-audit-integration.mjs
```

`JUNO_MINIFLARE_MODULE` and `JUNO_PLAYWRIGHT_MODULE` can point at existing
module entry points; `JUNO_CHROME_PATH` selects the browser executable.
The script installs nothing and uses a disposable Chrome profile, local
worker storage, a generated fixture certificate, and synthetic page data.
It checks actual pairing, WebSocket delivery, HTTP fallback, result recovery
after restart, and revocation. It does not touch a normal browser profile.
This script is outside the default test suite and makes no paid model calls.

To test an already-provisioned, disposable Cloudflare staging relay, set
`JUNO_AUDIT_RELAY_URL` to its HTTPS `audit-` or `staging-` Worker URL and
`JUNO_AUDIT_PSK_FILE` to a private, owner-controlled, mode-0600 regular file
outside the repository. The script does not deploy the relay. It checks the
same browser transports and result receipts with verified upstream TLS.
Do not point it at a production relay. Remove your disposable Worker after
testing.

Runtime restart checks run locally. Forced socket hibernation is opt-in with
`JUNO_AUDIT_FORCE_HIBERNATION=1` and requires a working eviction-control API
in the installed Miniflare version. The report identifies checks that were
not run; it does not claim to force a Cloudflare runtime restart.
When a cloud ingress holds half-open uploads before invoking the Worker,
`JUNO_AUDIT_SKIP_HALF_OPEN_BODY=1` can omit only those staging probes. The
report records the omission; completed-body authentication and size checks
still run. This flag is rejected in local mode, where the deadline tests
remain required.

## Optional third-party decisions

Jev is a public bring-your-own-key feature, off by default. Keep paid-call
configuration in the local driver/operator. Do not add an embedded key,
default account, or direct TypeSafe client to the relay or extension. The
key must not travel on the local Unix socket or appear in logs, test fixtures,
or public reports. Sanitized `.env.example` and `.dev.vars.example` files may
show variable names, but must not contain a working credential.

The standard test suite must remain offline. Any real TypeSafe integration
check is opt-in, uses the tester's own key and authorized page data, and must
report that it may incur charges. Separate connection reuse and browser
workflow savings from semantic model choices when reporting performance;
do not present old vendor benchmarks as a measurement of this project.

## Security

If you find a vulnerability (auth bypass, token leak, allowlist escape,
anything that lets an operator act beyond what the browser owner permitted),
**do not open a public issue**. Email the maintainer privately instead — the
address is on the GitHub profile. We'll fix it and credit you.

## License

By contributing, you agree your work is released under the MIT License.
