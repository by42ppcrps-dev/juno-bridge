## What changed

## How it was tested

- [ ] Deployed the relay from this branch
- [ ] Paired a real browser and ran the affected commands via `driver/jb.py`
- [ ] If the transport changed: tested the live WebSocket and the HTTP polling fallback
- [ ] README updated (if setup or usage changed)

## Security checklist

- [ ] No new state-changing capability without owner consent mechanics
- [ ] No secrets, tokens, or personal data in the diff
- [ ] Allowlist and kill-switch behavior unchanged (or explicitly justified)
- [ ] At-most-once delivery and stale-command refusal unchanged (or explicitly justified)
