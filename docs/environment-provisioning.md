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
Deletion markers are corruption. Records are retained indefinitely in this first slice.

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

This library does not implement that authorization policy or the UID enrollment ledger. Do
not admit hosted workloads until the host durably binds their manager and child lifecycles
and supports their retirement. Stock provider-local manager bootstrap and cross-uid seat
isolation also remain upstream dependencies. Empty-workload probes issue no such authority.

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
