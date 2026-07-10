---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

feat: `cotal clean` - one configurable cleanup verb (history / store / all)

`cotal down` deliberately preserves the on-disk JetStream store, so stale broker state (e.g.
durables minted by an older, incompatible Cotal generation) survived every down/up cycle and made
a new-generation `cotal spawn` fail with `consumer already exists`. `cotal clean <history|store|all>
--force` is the operator reset:

- **history**: purge the retained message backlog on the running broker (channels, plus DMs with
  `--dms`) over the least-privilege purger cred; `cotal history clear` stays as a thin alias.
- **store**: delete the stopped mesh's JetStream store (`.cotal/nats` or `--store-dir`).
- **all**: store + the space identity (`.cotal/auth`), every locally persisted cred/marker tied to
  it, crash residue a normal `down` would have swept, and this root's registry entries; the next
  `up` mints a fresh identity.

Hardening that shipped with it: one shared pidfile probe for `down`/`clean`/`status` (pid > 0
only; EPERM reads as alive), `down` no longer erases the record of a process it cannot stop nor
presents a failed stop as clean, registry teardown keys on the canonicalized project root
everywhere (a named open mesh can no longer delete another mesh's entry), and stale-store failures
plus `cotal status` now name the reset recipe.
