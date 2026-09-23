---
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

`cotal status` answers for a user-auth space whose material is a remote registry entry (a discovered space or a `meshes add --from` registration) instead of a local provisioning: the bare-status login row shows the signed-in subject from the entry's pinned IdP (grant reads as "not checkable on this machine", since the ledger runs where the space was provisioned), and `status --components` probes the manager as the signed-in login — the same credential `ps` uses — instead of minting static creds or connecting with none. A user-mode components row that cannot obtain that credential states the reason on the row (verdict `refused`), never a raw Authorization Violation. In user mode the manager row grades `serving` on the manager's own typed service answer, because the manager-lease sweep is a host credential an interactive bearer does not hold. The bare-status delivery responder axis stays `unknown` in user mode, as its comment states. Status still never static-mints on a user-auth mesh, and a signed-out machine still gets the offline "not signed in" row with the exact login command and no network round trip. Refs #1832.
