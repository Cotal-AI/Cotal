# Hosted managed-agent terminal retirement

## Current gap

A remotely supervised manager can register and serve without holding the space signer. Its typed host authority protocol issues prepare, activate, renew, and session credentials. Terminal managed-agent retirement is different from those standing phases:

- The manager must first revoke the managed actor's standing mint grant.
- The host must release the lifecycle-owned broker footprint without changing the lifecycle UID or its activation frontier while the actor can still resume.
- Only an explicit terminal request may run the full auth-owned retirement barrier and eventually free the alias.
- A retry must reuse one operation identity so a crash resumes the same barrier.

Deprovisioning the DM and delivery consumers is not terminal retirement. Recreating them for the same UID recaptures the DM frontier and loses pending delivery state. A hosted release therefore keeps the alias and lifecycle resumable. A hosted terminal operation ends that resumability and frees neither footprint nor alias before the barrier confirms.

## Narrow seam

Extend the closed remote manager-service authority protocol with one terminal-retirement operation. The request adds:

- one caller-generated requester nkey,
- the exact target owner, actor, and lifecycle UID,
- one operation ID derived from the target lifecycle UID,
- the manager's current registered serve epoch.

The host derives the authenticated owner from the IdP proof and the manager actors from the registered instance ID. It fresh-checks `supervise`, the manager lifecycle, the endpoint issuance gate, its principal, and its process epoch. It then returns only a short-lived `retirement-requester` JWT for that nkey. The JWT is pinned to:

- the server-derived manager serve principal and manager lifecycle UID,
- the exact target lifecycle,
- the auth retirement request and caller reply rails.

The manager uses the existing auth endpoint retirement request. The target stays on the broker-enforced subject. The request carries the lifecycle-derived operation ID and the current registered instance ID and serve epoch. The auth rail recomputes the operation ID from the broker-pinned target before any gate, head, intent, or barrier access, so mint-time validation is not the terminal authorization boundary. No barrier executor, lifecycle head writer, gate writer, signer, profile selector, generic permissions object, or caller-supplied principal crosses the public seam.

## Required ordering

The host composition must retain this order:

1. Revoke the managed actor's standing mint grant.
2. Complete or durably retain the hosted release state without freeing the alias.
3. Mint the target-pinned one-shot retirement requester from the current manager registration.
4. Request the existing auth-owned terminal barrier with the lifecycle-derived operation ID.
5. Remove the hosted survivor record and free the alias only after terminal confirmation.

A failed or uncertain terminal request keeps the alias held. Repeating it uses the same operation ID and target UID.

## Bounded regressions

The broker-free authority policy suite should prove:

- only `supervise` may request terminal authority,
- the terminal request shape is closed,
- the operation ID is derived from the target UID and a different valid ID is refused,
- manager actors and the requester principal are server-derived,
- a missing, retired, foreign-principal, or stale-epoch serve gate refuses issuance,
- the returned JWT grants only the exact target's retirement request and the caller's reply rail,
- a different target, manager lifecycle, instance, or epoch cannot reuse the request,
- retries with the same operation ID remain the same terminal operation,
- prepare, activate, renew, and session behavior remains unchanged.

A manager synthetic regression should prove remote teardown asks its injected terminal-authority callback, uses the current `serveGrant.epoch`, retains the stable UID-derived operation ID, and does not clear its held alias on refusal or uncertainty.

## Durable manager slot custody and consumer-free recovery (#4005)

A user-mode or remotely supervised manager records per-seat lifecycle custody in `KV_cotal_records_<space>` under its own holder prefix:

- Key format: `mgrslot.<managerOwner>.<targetOwner>-<actor>`, plus the holder-scoped index key `mgrslot.<managerOwner>._index`.
- `<managerOwner>` is validated with `assertPrincipalOwnerToken(managerOwner, { allowPlatform: true })` (`u_…` for a human manager or `p_…` for a platform-control manager).
- `<targetOwner>` is validated with `assertDerivedOwnerToken(targetOwner)` (`u_…`). When `delegated !== true`, `targetOwner` must equal `managerOwner`.
- `<actor>` is validated with `assertValidOwnerToken(actor)` (`[A-Za-z0-9_]+`, no `-`), so the hyphen in `<targetOwner>-<actor>` is the sole separator and `_index` (containing no `-`) is disjoint from every slot key.
- `remoteManagerPermissions` grants the supervisor credential (`manager_<iid>`) only the two subject-confined `pub.allow` entries `$KV.<REC>.mgrslot.<pr.owner>.*` and `$JS.API.DIRECT.GET.KV_<REC>.$KV.<REC>.mgrslot.<pr.owner>.*`. It never grants `CONSUMER.CREATE` on `KV_<REC>`, because consumer filter subjects live in the request body and are not subject-ACL confinable (`nats-server#8274`).
- Key enumeration reads `mgrslot.<managerOwner>._index` via `DIRECT.GET` (unioned with the local mirror `<workspaceRoot>/.cotal/space.<space-hex>/mgrslots.json`) and point-reads each `mgrslot.<managerOwner>.<targetOwner>-<actor>` via `DIRECT.GET`.
- Before calling `enroll(...)`, `enrollUserAgent` writes `phase: "enrolling"` with `provisionalUid`, `tokenHash`, `enrollSpec`, and reserved `runtime`, retaining the staged token and row on any non-definitive enrollment error so a retry or successor converges on `tokenHash` via idempotent `enrollManagedAgent` and drives `prepareAgentRetirement` + `retireManagedAgent` to `phase: "retired"`.
- Kernel process inspection (`inspectProcessStart`, `identityVerdict`, `processGroupOf`, `groupMembers`, `reapSeat`, `drainSeats`, `requireRuntimeReap`) is three-valued (`"live" | "gone" | "unknown"`): only `ENOENT`/`ESRCH` or a differing readable `starttime` is `"gone"`, while any other `/proc` read failure (`EACCES`, etc.) is `"unknown"` and fails closed without signalling, deleting `record.json`, or retiring the lifecycle.
