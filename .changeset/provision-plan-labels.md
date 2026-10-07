---
"@cotal-ai/core": patch
---

The credential-profile and permission comments in `provision.ts`, and the `note` strings that `credentialLifetime()` returns, no longer cite internal plan labels such as `P2 item 6`, `D5 slice 5` or `PR 1.5`. Each note still states what the credential is for and how it is renewed. For example, the `goal-writer` note now reads "self-mediated goal-writer for spawn-as-action; the manager re-mints for the SAME nkey on renewal, disjoint from the serve credential". The comment above the CLI-surface profiles now describes that group instead of the deleted allow-all `manager` profile. Lifetime classes, default expiries and permissions are unchanged.
