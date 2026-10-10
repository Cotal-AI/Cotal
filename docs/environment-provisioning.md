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

- `create` takes `operationId`, `profile` and `profileDigest`. Use one stable operation ID
  for one intended environment. The service reserves it before contacting the provider.
- `inspect` takes the returned environment record `id`. It observes the stored provider
  reference without creating or adopting a VM.
- `destroy` takes `id`. It records the destruction intent, obtains the host's durable
  retention and retirement receipt, requests provider deletion, and observes its result.

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
means infrastructure termination, not successful completion of the workload.

## Host responsibilities

The host registers the endpoint, publishes its contract artifacts and supplies a scoped
serve grant. It keeps the provider credential and lifecycle store inaccessible to guests.
Profile authorization is a required host callback; quotas and billing policy belong there.

Lifecycle records live in a dedicated private JetStream KV. It must use file storage,
history one, limits retention, discard-new, no TTL, no rollups, and no mirrors or sources.
Do not give callers or guests read, write, delete, purge or stream-management access to it.
Deletion markers are corruption. Records are retained indefinitely in this first slice.

The host's `retainAndRetire` callback must be idempotent by record ID. It retains results
and retires workload authority before returning a non-secret durable receipt. The service
persists that receipt before asking the provider to destroy the VM. A failed callback
blocks destruction and is surfaced for operator attention. Provider-imposed expiry may
still stop a workload; applications must save results continuously if they need to survive
that event.

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
