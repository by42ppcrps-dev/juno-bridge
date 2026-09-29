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

`npm test` runs both. The checks cover pause during a click, a missing tab
id, navigation off the authorized page, local queue delay, snapshot
redaction and its limits, pairing and revocation, result ownership,
reconnection, HTTP polling, result acknowledgement, and the driver's exit
status.

They do not load the extension in Chrome and they do not deploy a relay.
Step 3 above is still required before a transport or browser change is merged.

## Security

If you find a vulnerability (auth bypass, token leak, allowlist escape,
anything that lets an operator act beyond what the browser owner permitted),
**do not open a public issue**. Email the maintainer privately instead — the
address is on the GitHub profile. We'll fix it and credit you.

## License

By contributing, you agree your work is released under the MIT License.
