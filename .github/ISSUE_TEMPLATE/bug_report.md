---
name: Bug report
about: Something isn't working as expected
title: "[bug] "
labels: bug
---

## What happened

A clear description of the bug.

## Setup

- Extension version (chrome://extensions):
- Relay: commit you deployed from, and whether `relay/worker.js` is modified
- Upgraded from the KV-based relay (v1.0.x)? yes / no
- Driver: `jb.py` from this repo, or modified?
- Side panel connection state: live / polling / unreachable / rejected
- Chrome version / OS:

## Steps to reproduce

1.
2.
3.

## What you expected

## Logs

Paste the relevant output from `jb.py` and `jb.py devices` (redact your
passphrase and any device tokens), anything from the extension's side-panel
activity log (failed entries include the reason), and — if the relay is
involved — `npx wrangler tail` output from around the failure.

> **Security bugs:** do not file them here. See CONTRIBUTING.md — report
> vulnerabilities privately.
