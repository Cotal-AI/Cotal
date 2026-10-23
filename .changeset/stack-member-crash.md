---
"@cotal-ai/cli": patch
---

When a controller stack's manager or delivery daemon has died, `status` now leads its Next with
`cotal up --root <root>`, which restarts it. `ps` against a stack whose manager died refuses with
"no manager is running for this space" and names bare `cotal up`, as it does for a stack started
with `--no-manager`. It used to end with "no manager reachable on the ep rails" and no Next.
