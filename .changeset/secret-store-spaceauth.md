---
"@cotal-ai/workspace": minor
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

feat(secret-store): move SpaceAuth (the signing authority) behind the SecretStore seam

The space trust bundle (`.cotal/auth/auth.json`) is the last and highest-blast-radius durable secret kind. It now flows through the pluggable `SecretStore` seam, so a hosted composition injects its own KMS/Vault store and no signing seed lands on the hosted disk.

- New `@cotal-ai/workspace` API: `getSpaceAuth(store, expectedSpace?)`, `putSpaceAuth(store, auth)`, `deleteSpaceAuth(store)`, and `SPACE_AUTH_KEY` (`auth/auth.json`), byte-for-byte the current local path under `workspaceSecretStore`. `getSpaceAuth` fully validates the trust chain (`validateSpaceAuth`) before returning and never echoes stored seeds/JWTs/space labels in errors. `putSpaceAuth` is the single `sys.signingSeed` strip site.
- `remintDaemonCreds(root, store?, expectedSpace?)` now reads the signer through the same resolved store as the daemon cred, and validates it against the caller's space — a wrong-space or malformed signer is refused rather than overwriting the last-good daemon cred.
- The manager reads its signer from the injected `ManagerOptions.secretStore` (`getSpaceAuth(this.secrets, this.space)`); `up`, `mint`, `backup`, `restore`, `doctor`, `spawn`, and the delivery dev-mint helper go through the store. `loadSpaceAuth` remains the sync FS reader for name-only/presence callers and the static-auth single-machine mint composition.
- `cotal clean all` deletes `auth/auth.json` through the store as its absolute-last step, so a partial-failure reset re-runs against the correct space.

Closes "no signing seed at rest on a hosted disk"; the remaining hosted gap is signer isolation (the seed is still decrypted in-process at the manager's uid), not custody.
