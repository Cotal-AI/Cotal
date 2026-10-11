# Environment provisioning

> **Reference implementation** · **For:** hosts integrating provider compute with Cotal

`@cotal-ai/environments` exposes `create`, `inspect` and `destroy` as ordinary endpoint
commands. `@cotal-ai/tenki` supplies the first provider adapter. They are libraries for an
authorized host to compose; installing them does not enable a hosted execution service.

An environment is a provider VM. It can contain a stock manager, one agent or both. The
manager still owns agent launch and supervision, and the connector still integrates the
harness. Provisioning adds no workflow language syntax and does not report agent readiness.
A manager in an image must connect to the chosen broker directly with its own scoped
authority. The provider API key stays in the hosting service.

## Operations

The host configures profiles and supplies their names and canonical digests to authorized
callers. A profile pins its image, resource limits, lifetime and provider options. Callers
cannot override those fields or send credentials through the command arguments.

- `create` takes `operationId`, `profile` and `profileDigest`. Persist one stable operation
  key before sending the request. The service reserves it before contacting the provider.
- `inspect` takes the environment record `id`. The client can derive it before creation with
  `environmentOperationId(caller, operationId)` using its authenticated lifecycle. This also
  resolves a lost creation reply without calling create again or adopting a VM.
- `destroy` takes `id` and optional `force`. It records a bounded graceful deadline before
  obtaining the host's retention and retirement receipt. Expiry or an owner-forced close
  bypasses an unavailable receipt and requests provider termination.

`create` and `destroy` require the `environment.write` capability; `inspect` requires
`environment.read`. The caller's owner, actor and lifecycle come from the authenticated
request subject. All three must match the record for inspection or destruction. A later
agent reusing an actor name does not inherit the earlier lifecycle's environments.

These are bounded, idempotent request/reply commands. They are not workflow actions and do
not return a Cotal goal. Repeating the same creation input consults the persisted attempt;
it does not retry the provider create. A conflicting profile digest refuses. A lost reply
does not prove failure. `create-unconfirmed` means no provider binding is confirmed and
requires operator reconciliation, not another operation ID to work around it.

## Observations

The response separates the durable record from the provider observation. `running` means
the VM is running, not that a manager, connector or agent has joined. `paused`,
`terminating` and `unknown` are not `terminated`. A failed lookup returns
`observation-unavailable`; absence from a list is never evidence of deletion.

A destruction acknowledgement alone does not set `terminatedAt`. The service records it
only after observing `terminated` for the recorded provider reference. This timestamp
means infrastructure termination, not successful completion of the workload. `cleanup.retention`
reports retained, pending or unknown results separately from `cleanup.retirement`. Terminated
infrastructure can have `retirement-pending`; a failed authority callback does not erase terminal
provider evidence or invent retained results.

## Host responsibilities

The host registers the endpoint, publishes its contract artifacts and supplies a scoped
serve grant. It keeps the provider credential and lifecycle store inaccessible to guests.
Profile authorization is a required host callback; quotas and billing policy belong there.

Lifecycle records live in a dedicated private JetStream KV. It must use file storage,
history one, limits retention, discard-new, no TTL, no rollups, and no mirrors or sources.
Do not give callers or guests read, write, delete, purge or stream-management access to it.
Deletion markers are corruption. Cleanup reports `record-corruption` for each undecodable row
and continues with healthy records. Direct reads and unreported scans still refuse corrupt
rows; none may be recreated. A failed bucket scan stops the worker and requires supervision.
Records are retained indefinitely in this first slice.

The host's `retainAndRetire` callback is idempotent by record ID. During graceful shutdown it
retains results and retires authority before returning a non-secret receipt. The service
persists separate retention and retirement facts. Its default grace period is 15 seconds,
bounded by the recorded expiry. A reconstructed service uses the original deadline. A failed
callback returns `retention-unconfirmed`; a hung callback cannot extend that deadline.

At the deadline, expiry or an owner-forced close, provider termination proceeds without a
graceful receipt. After observing termination the external host's `retireTerminated` callback
retires only the lifecycle UIDs durably bound to that record, never arbitrary caller-supplied
UIDs. It must not rely on the guest or its manager. Its default time bound is five seconds;
failure leaves `retirement-pending` for a later reconciliation pass. Both callbacks receive an
AbortSignal and must honor cancellation. A host without this authority policy must refuse the
callback and expose the pending obligation and bound UIDs to its operator.

Hosts rendering a broker with `serverConfig` can opt into native full account resolution with
`accountResolver: { kind: "full", directory, limit, intervalMs }`. The directory must be absolute
and exclusive to that broker, the capacity positive, and the synchronization interval between
one second and one day. The renderer disables deletion and preserves the signed account
preloads. Omission or `{ kind: "memory" }` keeps the existing in-memory configuration; unknown
or malformed options refuse. There is no CLI or manifest selector for this library option.

Full resolution retains accepted account JWT updates across broker restarts. It does not
serialize competing account updates or make an older signed claim safe to replay. The host
still owns signer custody, current-claim preservation, the required server set and verified
retirement effects. Do not put this resolver's directory or update authority in a guest.

This library does not implement that authorization policy or the UID enrollment ledger. Do
not admit hosted workloads until the host durably binds their manager and child lifecycles
and supports their retirement. Stock provider-local manager bootstrap and cross-uid seat
isolation also remain upstream dependencies. Empty-workload probes issue no such authority.

Core provides fixed `environment-bootstrap`, `environment-manager-supervisor`,
`environment-manager-executor` and `environment-manager-goal-writer` grant builders. They
require host-selected instance, owner, lifecycle and authority coordinates, and a current
explicit credential expiry bounded by admission. They confer no guest auth-store access.
The optional endpoint-gate `authorityFamily` marker survives native registration and mint
CAS operations; raw write exclusion, not a field parser, protects it from guests. These
primitives do not implement admission, the authority endpoint or stock manager bootstrap.
The existing auth-service manager authority path refuses gates marked `environment-manager`.
An explicit ordinary manager-caller selection also refuses that family. Automatic selection
excludes its gates, including unregistered ones, so they do not count as ordinary candidates
or prevent selection of an ordinary manager.
Ordinary preparation reserves an unmarked native gate before releasing direct-store manager
credentials. A racing environment admission must win that same create-only reservation; it
cannot adopt an instance already prepared by the ordinary path. This family reservation is
separate from the registration and credential-issuance fences.
The auth package's internal pre-issuance reservation step stages immutable host coordinates
under `stage.<opId>.environment-manager`, activates the bootstrap alias at the reserved UID,
creates the marked manager gate open, and freezes it under the original registration operation.
The initial open gate revision is recorded under `stage.<opId>.environment-manager-gate`
before its first freeze. Same-input retries preserve the live registration reservation, but
cannot re-freeze an aborted gate under that operation, even when its counters remain unchanged.
The host must bind one operation to each manager instance before calling this step and must
not substitute a new operation after abort. This step does not detect that substitution.
Unstamped prior state is unsupported and can be restored after an abort with unchanged counters.
Changed input, ordinary or foreign gates, completed registrations and deletion markers refuse.
Its host-private writer grants explicit staging suffixes in addition to lifecycle and manager
gate rows. This reservation step is not exported as an admission API and issues no credential.
The internal immutable admission index binds a host-confirmed provider reference, creator,
profile digest, expiry, account and authority context before selecting a manager instance,
lifecycle and operation. Same-source retries return the stored coordinates and native revision;
changed sources and deletion markers refuse. Its dedicated private KV must use file storage,
history one, no expiry, leader reads and no rollups, mirrors, sources or republishing.
Per-subject discard-new makes each binding key write-once. Native deny-delete and deny-purge
prevent message erasure. The boundary refuses a store missing any of these settings.
The private custody grant creates that store and reads or writes its binding keys, with no
lifecycle or auth-store access. It cannot replace a stored binding while that shape holds.
Stream deletion and configuration updates remain operator boundaries; no shipped index-holder
credential has those APIs. An operator can temporarily weaken write-once, expiry or republish
settings and restore them after replacing, losing or exposing rows. A reopened shape check
cannot detect that history. Privacy holds at the data-account boundary; a holder that can create
streams in that account can source their data. Subject permissions cannot confine metadata read
payloads, so custody remains trusted host authority, never a guest credential.
The index does not authenticate a guest, verify provider confirmation or authorize a workload.
An internal one-shot bootstrap issuer requires the staged admission, initial-gate stamp and
original frozen registration. It signs only the fixed bootstrap profile for a supplied public
nkey, with expiry bounded by five minutes and admission. The native credential ledger binds
that JWT's expiry and bootstrap principal to the reserved lifecycle. Separate registration and
lifecycle CAS fences must both win before material returns; a lost fence revokes its staged row.
The issuer records public signing coordinates under `stage.<opId>.environment-bootstrap-mint`.
A repeated or ambiguous attempt stays held, including after reconstruction. This helper does
not deliver a private file or redeem bootstrap requests and is not exported from the package.
External admission, required host policies, issuance recovery, file custody and terminal
retirement still need their composition.
Do not substitute these primitives for missing host policies or claim a runnable hosted manager.

Supervise the cleanup task independently of any operator session. It resumes recorded
destruction requests and expired environments after a host restart. Monitor its failure
promise and its per-record reports. An unavailable store or a provider create whose reply
was lost can require operator recovery. The service does not search by VM name and adopt
an unproven match.

## Tenki profiles

The adapter requires an immutable image digest, explicit CPU, memory and disk limits, and
a positive lifetime of at most one day. It disables inbound access and sticky sessions.
An empty domain allowlist disables outbound access rather than making it unrestricted.

Provider options carry `allowDomains`, `pauseRetentionMs`, optional `secretPolicies`,
non-secret `env` values and optional `secretFiles` references. A secret file names a guest
path and a native secret name. Only workload-scoped credentials may be materialized in the
guest. A secret reference is not proof that its value stays outside the VM: request-time
substitution policies and file delivery have different exposure properties. The host
must review its image and native policies together.

The image may start a stock manager through its own boot configuration. No repository,
account, model or factory path is built into this adapter. Remote-manager VM placement,
automatic credential enrollment, managed Lang acceptance, checkpoint migration and pooled
hosting are not implemented by this package.
