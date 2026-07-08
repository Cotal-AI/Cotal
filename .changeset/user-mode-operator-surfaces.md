---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/auth": minor
"cotal-web": minor
---

feat(auth): user-mode operator surfaces via exchange-gated elevated views

Bring the operator CLI surfaces online on per-user-auth meshes without static creds: `cotal web`,
`cotal console`, `history clear`, `channels set/default`, and `spawn -f` now ride short-lived,
server-authored view bearers minted by the signed-in human exchange. Views are a closed enum
(`admin`/`purger`/`channel-purger`/`channel-writer` gated on ledger scope `admin`; `deployer` gated
on `spawn`), authorized against the fresh ledger row on every connect, and rejected outright by the
managed agent-secret exchange. `ps`/`status` are owner-domain scoped in user mode (a fresh `admin`
ledger scope sees all, matching `stop`/`attach`).

Also hardens the CLI's fail-loud contract: a top-level error boundary renders command failures as one
clean line instead of a raw stack trace; a dead or typo'd `--idp` fails at `cotal up` before a space
is provisioned; `actor grant`/`revoke` refuse when run off the authoritative ledger machine; and the
`--creds` flip guard fires on non-default ports.
