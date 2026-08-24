# Design note: remote user manager-service authority

**Status:** design only. Not a proposed implementation or release artifact. The existing remote authority cell (`implementations/manager/smoke/supervise-registered-user-authority.smoke.ts`) proves a registered participant’s ordinary user bearer cannot access the manager registration surfaces. No privilege is added by this note.

## Problem boundary

A locally hosted manager is a signer. `Manager.start()` gets static trust at `implementations/manager/src/manager.ts:900-978`, and `registerManagerService()` uses static provisioner, endpoint-serve-executor, endpoint-serve, goal-writer, and session-ledger credentials at `4566-4748`. A registered remote participant deliberately has neither the hosting marker nor the space signer.

The participant path already has a narrow authentication seam:

- `AuthProvider.userCredentials()` in `packages/core/src/auth-provider.ts:53`;
- remote exchange implementation in `implementations/auth/src/provider.ts:343-426`;
- callout mapping in `implementations/auth/src/service.ts:486-510` and `implementations/auth/src/permissions.ts:44-101`.

The callout currently emits `permissionsFor("agent", ...)`. That is correct for foreground/user-agent operation, but lacks the authority to create endpoint resources, write service registration records, publish contracts, stage/revoke the manager service’s credential family, or bind the session ledger. The exact proof is `f273de5e`.

## Minimal extension proposed for later approval

Introduce one **closed**, server-issued user-token view, conceptually `manager-service`. It is neither an arbitrary profile name nor a client-supplied permissions object.

### Gate

- A signed-in human exchange requests this closed view only from the **loopback/operator exchange**.
- The current interactive ledger row must contain a new dedicated scope token, proposed `supervise` (not `spawn`, not `admin`).
- The public exchange refuses the view. Managed-agent secret exchanges refuse every view.
- The callout re-reads the row at connect/mint as it does for current views. A revoked/narrowed scope denies the next exchange/connect. Missing scope fails closed with a re-grant explanation that spells out the entire row semantics.

`supervise` is deliberately separate from `admin`: a user who may observe or control their team should not thereby obtain persistent manager registration authority.

### Principal and resource scope

The bearer remains the user’s ordinary derived owner plus a fixed, server-selected actor (for example `manager`). It must carry a lifecycle uid and a root credential like every other user bearer. The permission builder may grant only:

1. The caller’s own manager endpoint registration instance, namespaced by an opaque manager instance id selected locally and included in the server-authorized view claim or independently constrained at the callout. It must not write another participant’s service instance.
2. The `manager` endpoint’s required contract publication and exactly its own `svc`/status records.
3. The one matching `epgate.manager.<instance>` and `epcred.manager.<instance>` family, sufficient only for manager endpoint registration, serve renewal, goal writer, and session ledger lifecycle.
4. The manager’s own presence, lease, and its own endpoint rails.
5. Per-agent provisioning only for descendants of the same derived owner and only after a remote host-side provisioning service validates the requester’s grant. The participant never receives the space signer, callout signing seed, owner secret, static provisioner credential, or generic stream/KV write authority.

The host must issue any NATS credential material that requires the data-account signing key. This means a viable design needs a server-side endpoint/flow that creates manager-scoped connection material, not just a broader bearer. It must be an explicitly typed, authenticated protocol with replay/idempotency and lifecycle binding, not a generic “mint credentials” endpoint.

## Required protocol / spec work

This is spec-affecting.

- **SPEC §13.1:** define manager-service authority lifecycle, issuance gate/family, revocation and server-issued material for a non-host manager.
- **SPEC §13.2 / §13.9:** define the user owner/actor caller and service-registration authority; constrain the manager endpoint and instance coordinates.
- **SPEC §13.6:** define the manager session ledger / serving credential ownership when the service is registered remotely.
- **SPEC §13.7:** define contract publication authority for the scoped manager service.
- **Identity/auth docs:** new `supervise` scope, its difference from `spawn`/`admin`, remote exchange eligibility, revocation behavior, and host operational responsibility.
- **CLI/run-a-mesh docs:** remote supervised agents become available only after the host advertises and runs the approved manager authority service; foreground operation remains the default otherwise.

## Security and adversarial test plan

1. A `spawn`-only bearer cannot request or mint manager-service authority.
2. An `admin` bearer without `supervise` cannot request it; `supervise` without `admin` cannot gain admin control operations.
3. Public exchange, managed-agent exchange, arbitrary/unknown view, and raw profile strings are refused.
4. A bearer whose scope is narrowed or revoked is refused on the next exchange and new connect; an already-live manager degrades according to an explicit bounded renewal policy.
5. A manager-service grant for owner A cannot register, overwrite, describe, invoke, or bind service/lease/gate/credential records of owner B or another manager instance.
6. A participant cannot publish arbitrary endpoint contracts, create arbitrary streams/KVs/consumers, mint static credentials, or access the signer/callout/owner-secret material.
7. Replay of provisioning/manager material is lifecycle- and instance-bound; a stale material replay cannot revive a retired manager or agent incarnation.
8. Two same-owner manager attempts race safely at the manager-instance lease/gate, with one explicit winner and no credential family leak.
9. Host failure, exchange expiry, renewal denial, and provisioning endpoint loss retain existing live agents where promised, refuse unsafe new restarts, and report an actionable re-login/host-service state.
10. Existing local `cotal up --user-auth` manager behavior, static auth, open meshes, foreground remote spawn, and manual remote records remain regression-covered.

## Residuals

- A remote manager service necessarily increases the host’s control-plane attack surface. The protocol must explicitly decide whether the host is willing to delegate a long-running manager to each approved user; this cannot be inferred from ordinary spawn authority.
- Revocation cannot retroactively erase already-issued short-lived NATS credentials without an eviction authority. The design must state bounded expiry and whether the host performs verified eviction for this new family.
- A remote manager may be unavailable when the participant’s IdP is down or their login expires. The implementation must never substitute static/local trust; availability degradation is preferable to privilege escalation.
- Multi-manager semantics need an owner/instance scoping decision before implementation. This note intentionally does not assume one manager per user, only that a grant cannot cross owners or instances.
