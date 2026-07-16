# @cotal-ai/auth

## 0.11.6

### Patch Changes

- Updated dependencies [7b24953]
  - @cotal-ai/workspace@0.11.6
  - @cotal-ai/core@0.11.6

## 0.11.5

### Patch Changes

- @cotal-ai/core@0.11.5
- @cotal-ai/workspace@0.11.5

## 0.11.4

### Patch Changes

- Updated dependencies [1935221]
- Updated dependencies [5634ae4]
  - @cotal-ai/core@0.11.4
  - @cotal-ai/workspace@0.11.4

## 0.11.3

### Patch Changes

- @cotal-ai/core@0.11.3
- @cotal-ai/workspace@0.11.3

## 0.11.2

### Patch Changes

- @cotal-ai/core@0.11.2
- @cotal-ai/workspace@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [5b2863a]
  - @cotal-ai/workspace@0.11.1
  - @cotal-ai/core@0.11.1

## 0.11.0

### Minor Changes

- 9061d0e: feat: per-user authentication (owner+actor identity, IdP login, credential death)

  Add per-user auth as a first-class mesh mode. A mesh brought up with `cotal up --user-auth --idp <url>`
  authenticates humans against an identity provider and issues short-lived, ledger-scoped bearers through an
  auth callout, in place of long-lived static credential files.

  - **owner+actor identity.** An instance's wire identity becomes the two-token principal `(owner, actor)`:
    every subject carries the sender as `<owner>.<actor>`, and grants, durables, presence, and `from.id`
    re-key onto the pair. Cross-owner and same-owner cross-actor forge/read isolation is enforced by the
    broker; the connection nkey survives only as the transport credential.
  - **Login and delegation.** Humans sign in with `cotal login --idp <url>` (device-code); operators grant
    access with `cotal actor grant`. Agents are spawned under the signed-in human as managed `(owner, actor)`
    children whose scope is a subset of the spawner's (the delegation envelope rule). Agent identities live in
    a separate managed-actor ledger space, exchanged via their own per-agent secret, so they outlive the
    human's login session.
  - **Credential death.** Every managed credential is now lifetime-bounded, with supervisor and delivery
    standing renewal, `$SYS` rotation-renewal, live connection eviction on revoke, and a `cotal doctor auth`
    repair surface. On a user-auth mesh, static agent creds are retired (the flip): revocation closes the live
    window at the next connect.
  - **Elevated operator surfaces.** `cotal web`, `console`, `history clear`, `channels set/default`, and
    `spawn -f` come online in user mode via server-authored elevated view bearers, minted only by the
    signed-in human exchange and gated on ledger scope (`admin` / `spawn`); `ps` and `status` are
    owner-domain scoped.
  - **Connectors.** Add the `cotal_docs` tool (version-exact Cotal docs the agent reads natively) and an
    opaque `launchOptions` raw passthrough for the Claude Code, OpenCode, and Hermes adapters.

### Patch Changes

- Updated dependencies [9061d0e]
  - @cotal-ai/core@0.11.0
  - @cotal-ai/workspace@0.11.0
