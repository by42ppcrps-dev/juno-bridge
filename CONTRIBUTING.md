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

- Any new **state-changing** command (click, type, key, navigate already
  exist; anything beyond those is a security conversation).
- Changes to the auth model, the allowlist semantics, or the kill switch.
- Anything that touches the relay's admin endpoints.

## How to contribute

1. Fork the repo and create a branch from `master`.
2. Keep changes small and focused — one concern per PR.
3. Test end to end: deploy the relay, pair a browser, run the new behavior
   through `driver/jb.py`. PRs that were never run against a real browser
   won't be merged.
4. Update the README if your change affects setup or usage.
5. Open the PR with a clear description of what changed and how you tested it.

## Security

If you find a vulnerability (auth bypass, token leak, allowlist escape,
anything that lets an operator act beyond what the browser owner permitted),
**do not open a public issue**. Email the maintainer privately instead — the
address is on the GitHub profile. We'll fix it and credit you.

## License

By contributing, you agree your work is released under the MIT License.
