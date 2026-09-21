# Hosted environment provider contract

Status: proposed implementation contract. This document extends the generic environment seam so one
manager can drive a local microVM provider or a hosted provider over HTTPS. It does not put provider
API concepts on the Cotal wire.

## Current contract

The pending environment contract defines `EnvironmentDriver.describeImage`, `preflight`, `reserve`,
`provision`, `start`, `adopt`, `inspect`, `reconcile`, `reap`, `destroy`, checkpoint operations and
`recoveryEvidence` in `packages/core/src/environment.ts`, `EnvironmentDriver`. Its plan carries one
local image manifest. Its checkpoint export writes one host path.

The manager constructs that plan, calls `describeImage(manifest)`, and rejects failed checks or missing
seat capabilities in `implementations/manager/src/environment-operations.ts`,
`ManagerEnvironments.plan`. It installs the persona, customer inputs and the already minted agent
credential before launch finalization in the same file, `ManagerEnvironments.prepareSeat`. It calls
`exportCheckpoint` with a host path, then inspects that path in `ManagerEnvironments.operate`.

The existing generic launch recipe has a local control socket in
`packages/core/src/connector.ts`, `LaunchSpec`. User authentication currently carries a sentinel
credential path and executable bearer command in `packages/core/src/connector.ts`, `LaunchOpts`, and
validates the same shape in `packages/core/src/launch-material.ts`, `validate`. The manager executes
that command once before launch in `implementations/manager/src/manager.ts`,
`execBearerPreflight`.

The manager health command currently reports runtime, custody, agent count, uptime, connector
availability and static reconciliation in `implementations/manager/src/manager-service-contract.ts`,
`ManagerStatus`. `implementations/manager/src/manager.ts`, `Manager.managerStatusData`, builds that
response from boot inventory and live manager state.

## Contract types

The additive declarations are in `packages/core/src/environment.ts`. They are the merge surface for
the pending environment contract. They do not make environment records part of the wire spec.

## 1. Probe capabilities

Decision: `EnvironmentPreflight` returns one closed `EnvironmentCapabilities` value and `probedAt`.
Every provider reports every capability for the selected plan and current deployment. No manager
infers capability from provider name, engine name or status.

```ts
interface EnvironmentCapabilities {
  guestBuild: boolean;
  custody: boolean;
  sessionHistory: boolean;
  materialRenewal: boolean;
  coldCheckpoint: boolean;
  memoryCheckpoint: boolean;
  nested: boolean;
  pauseKeepsMemory: boolean;
  snapshot: boolean;
  export: boolean;
  gpu: boolean;
  durableSeatHome: boolean;
  screen: boolean;
  exec: boolean;
  extend: false | { stepMs: number };
}

interface EnvironmentPreflight {
  checks: EnvironmentPreflightCheck[];
  capabilities: EnvironmentCapabilities;
  probedAt: number;
}
```

Reason: deployment support can differ across accounts, regions, hosts and selected templates. A type
or product default would turn a deployment fact into an assumption.

Contract:

- `preflight(plan)` probes the selected deployment and returns an epoch-millisecond `probedAt`.
- The manager persists the returned capabilities with the environment record.
- A required `false` capability refuses before reservation or credential issuance.
- `pauseKeepsMemory: false` means pause is not a memory-retaining lifecycle action.
- `durableSeatHome: false` means the manager must not use the seat home as a checkpoint source. A
  provider checkpoint or explicit history export remains eligible when separately supported.
- `screen` means a provider can expose the managed seat's screen surface. `exec` means it can run the
  closed prepared launch. Neither is inferred from general network reachability.
- A later probe replaces the full capability value and `probedAt`. It does not merge selected fields
  with an older observation.

## 2. Image and template references

Decision: `EnvironmentPlan.image.reference` is a discriminated `EnvironmentImageReference`.
`describeImage` accepts the same reference and returns it unchanged in `EnvironmentImageDescription`,
with a normalized record projection.

```ts
type EnvironmentImageReference =
  | { kind: "oci"; manifest: EnvironmentFileReference }
  | { kind: "template"; ref: string };
```

Reason: an OCI image is selected by a manager-local manifest, while a hosted provider creates from an
opaque template reference. Putting templates in `providerOptions` would hide the principal immutable
input from preflight, journaling and reconciliation.

Contract:

- The manager selects exactly one reference before preflight.
- An OCI reference retains the current bounded local manifest validation.
- A template `ref` is opaque nonsecret provider input. It is not an API key, signed URL or bearer.
- `describeImage` performs a bounded read-only inspection and returns the exact input reference, a
  normalized `{ kind, ref, digest? }` record projection, architecture, guest ABI, protocol version,
  connector pin, bundle digest and system trust digest.
- For a template, `bundleSha256` is the digest of the Cotal guest bundle measured or attested inside
  that template. It is not a template ID digest.
- The manager rejects a returned reference that differs from the selected reference.
- The environment record later renders either source as `{ kind, ref, digest? }`. An OCI record uses a
  stable image reference and its digest. A template record omits `digest` unless the provider reports
  a stable content digest.

## 3. Network mode and lifetime

Decision: network selection is part of `EnvironmentPlan` and is immutable after provision. The driver
also has an `extend` verb. Providers that do not support extension report `extend: false` and the verb
refuses.

```ts
interface EnvironmentPlan {
  // existing fields
  network: string | null;
}

interface EnvironmentDriver {
  extend(ref: EnvironmentReference, op: OperationContext): Promise<EnvironmentLifetime>;
}

interface EnvironmentLifetime {
  expiresAt: number | null;
  observedAt: number;
}
```

Reason: a hosted provider fixes its network when it creates the environment. Lifetime extension is a
remote effect with its own deadline and uncertain-outcome rules. Hiding it in reconciliation or
provider options would make authorization and replay ambiguous.

Contract:

- `network` is a nonsecret provider-neutral selection key. `null` asks the provider for its documented
  default. The provider records the resolved network and never changes it in place.
- A network change requires a new environment. Reconcile observes the recorded selection but does not
  repair drift by choosing another network.
- `extend` is admitted, journaled and reconciled like other mutating driver operations.
- `EnvironmentStatus.operation.kind` includes `extend`.
- `extend: { stepMs }` promises that one successful call moves the provider deadline by at most that
  fixed positive step. The manager reaches a longer requested lifetime through bounded repeated calls.
- `extend` returns the provider-observed deadline. `expiresAt: null` means the provider reported no
  deadline. It never means an unknown fetch result.
- Timeout or cancellation leaves the operation uncertain until reconcile proves the same logical
  operation's result.

## 4. Checkpoint export without a host volume

Decision: checkpoint output is a destination request, and export returns the verified destination.
A provider file is read through a separate bounded streaming method.

```ts
type CheckpointOutput =
  | { kind: "host-path"; path: string; maxBytes: number }
  | { kind: "provider-file"; maxBytes: number };

type CheckpointExport =
  | { kind: "host-path"; file: EnvironmentFileReference }
  | { kind: "provider-file"; file: EnvironmentProviderFileReference };

interface EnvironmentProviderFileReference {
  environment: EnvironmentReference;
  id: string;
  byteLength: number;
  sha256: string;
}
```

Reason: a hosted provider has no manager-visible volume path. Returning only a provider file ID would
also omit the size and digest the manager needs to verify the read-out.

Contract:

- `exportCheckpoint` returns `CheckpointExport` instead of `void`.
- `host-path` writes only the requested path and returns the inspected file reference.
- `provider-file` creates a provider-managed readable object and returns its opaque ID, size and
  digest. The ID is not a URL or credential.
- `readProviderFile` is an `EnvironmentHandle` method and streams the named bytes under an
  `OperationContext`. The guest-side provider channel owns the provider file namespace. The manager
  enforces `maxBytes`, byte length and SHA-256 while copying to its chosen destination.
- The provider authorizes the read from the manager's current environment operation. It must not
  return a signed URL, provider credential or host path to the guest.
- The file API is available from the guest-side provider agent or equivalent provider channel. It
  does not require a volume visible to the manager host.
- Successful export does not delete the provider file. Retention and deletion remain provider
  operations with durable evidence.

## 5. Bearer source

Decision: the environment launch request carries a discriminated `EnvironmentBearerSource`. The
manager fills it after selecting the deployment and before it stages the closed request.

```ts
type EnvironmentBearerSource =
  | { kind: "socket"; path: string }
  | { kind: "https"; url: string };

interface EnvironmentLaunchAuthentication {
  bearerSource: EnvironmentBearerSource;
}

interface EnvironmentLaunchRequest {
  // existing closed fields
  authentication: EnvironmentLaunchAuthentication;
  credential: MaterialDescriptor & { purpose: "agent-credential" };
}
```

Reason: a local microVM can reach a host-mounted socket. A remote guest cannot. Both sources implement
one operation: fetch a fresh bearer for the already bound agent principal.

Contract:

- A local provider uses `socket` with a guest-visible socket path.
- A hosted provider uses `https` with the manager authority URL selected from trusted manager
  configuration. The URL must use HTTPS and must not contain userinfo, a token or a signed query.
- The manager fills `authentication.bearerSource` after preflight and durable reservation. The
  existing top-level `credential` descriptor remains the sole admitted agent credential and is bound
  beside that source in the same canonical request. Provider configuration can select a trusted
  endpoint but cannot override the closed launch request later.
- The guest fetch authenticates with the separately installed agent credential. Redirects refuse.
- The response is a short-lived bearer only. Provider and sponsor credentials never participate in
  the request.
- A provider refuses a source kind it cannot expose. There is no socket-to-HTTPS fallback.

## 6. Credentials

Decision: the launch request's existing top-level `credential` names the agent's own pre-minted,
revocable credential material. The manager installs its bytes through the existing material staging
path before `prepareLaunch`. `authentication.bearerSource` tells the guest how to use that credential
to fetch a fresh bearer.

Reason: `ManagerEnvironments.prepareSeat` already requires explicit credential material and installs
it with the other declared inputs. Making it explicit under launch authentication binds the material
to the bearer source without permitting a guest login flow.

Contract:

- The manager mints the agent credential after reservation and issuance admission.
- The descriptor has `purpose: "agent-credential"`, `lifetime: "launch"`, and null home and environment
  destinations.
- Credential bytes move only through `replaceMaterial`. They do not enter argv, provider options,
  image metadata, the environment record or presence.
- The guest starts with the credential already installed. It performs no human login, provider login,
  sponsor login or credential exchange during seat launch.
- The provider refuses provider API keys, sponsor keys, account tokens, signed URLs or any descriptor
  other than the one admitted agent credential in this launch slot.
- Revocation targets the agent credential and its lifecycle. It does not require rotating provider
  account credentials.

## 7. Environment record

Decision: the presence card's opaque `environment` value equals `EnvironmentRecord.id`. The complete
record is durable in the manager's environment journal and is read through the manager control
surface. It is not added to the Cotal wire specification.

```ts
interface EnvironmentRecord {
  version: "cotal-manager-environment-record/v1";
  id: string;
  provider: string;
  providerRef: string;
  space: string;
  host: string;
  arch: string;
  engine: string;
  volumeId: string;
  image: { kind: "template" | "oci"; ref: string; digest?: string };
  owner: string;
  createdAt: number;
  state: "creating" | "running" | "stopped" | "failed";
  stoppedAt?: number;
  expiresAt?: number;
  network?: string;
  capabilities: EnvironmentCapabilities;
  probedAt?: number;
}
```

Reason: the Cotal environment ID and the provider handle have different lifetimes. A durable join must
survive a provider reissued handle and must place the environment within its space.

Contract:

- The manager mints `id` before provider reservation and calls `reserve(id)`. The provider returns an
  `EnvironmentReference` whose `id` is unchanged. The ID is globally unique across providers, has no
  provider-prefix convention, and is never a credential.
- `presence.environment === record.id` is the only join. A provider reference, host, volume or image
  reference is never an alternate join.
- The provider exposes `facts(ref, op)` for `providerRef`, `volumeId`, resolved `network`, provider
  deadline, state evidence, engine identity and provider observation time. `describeImage` supplies the
  stable image digest when available.
- The manager records `id`, `provider`, `space`, `host`, `owner`, `createdAt`, the selected image
  reference, normalized architecture, probe result and `probedAt`.
- The manager maps provider observations to the closed record state. `stoppedAt` is present only after
  a proved stop. `expiresAt` is absent only when the provider did not report a deadline.
- `providerRef` is opaque and may change after provider reconciliation. `id` never changes.
- Every record update is appended or replaced through the manager's durable environment journal
  before it is served.
- No field may contain a secret. In particular, no API key, bearer, credential path, signed URL,
  control token or launch material ID is allowed. Dashboards may read the whole record.

## 8. Host enrollment facts

Decision: add an untargeted read command named `environment-host-facts` to the manager endpoint. It
uses the existing `manager.read` capability class and returns one closed `EnvironmentHostFacts`
value.

```ts
interface EnvironmentHostFacts {
  version: "cotal-environment-host-facts/v1";
  instanceId: string;
  host: string;
  arch: string;
  os: { platform: string; release: string };
  engines: { name: string; version?: string }[];
  kvm: { present: boolean; usable: boolean };
  headroom: {
    cpus: number;
    memoryMiB: number;
    diskGiB: number;
    environmentSlots: number;
  };
  observedAt: number;
}
```

Reason: spawn placement needs measured machine facts, not a host-name convention. A separate command
keeps resource inventory out of the general process-health response and allows independent refresh.

Contract:

- `host` is the manager's stable nonsecret enrollment label. It is not a network address unless the
  operator deliberately chose an address as the label.
- `arch` and `os` describe the manager machine. `engines` lists detected environment engines and
  versions when known.
- `kvm.present` reports device presence. `kvm.usable` reports the manager's actual access check.
- `headroom` is currently allocatable capacity after manager reservations, not total machine size.
- `observedAt` timestamps the completed probe. Probe failure returns command failure, not zero
  headroom or an empty engine list.
- A spawn goal may select a manager instance whose returned facts satisfy its host requirement. The
  selected manager still runs provider preflight before reservation.

There is a related manager scheduling gap outside this contract. A manager with no usable connector
inventory still serves the spawn anycast class and can terminally refuse a goal that another manager
could run. A later change should either let `supervise` decline the spawn class or define a
harness-aware negative acknowledgement that leaves the goal available to another instance. This
lane does not define that behavior.

## Lifecycle and security rules

- Every HTTPS provider call is bounded by the original `OperationContext` deadline and abort signal.
- An accepted remote request that times out is uncertain. The manager reconciles the same logical
  operation ID before another mutation.
- Provider references and file IDs are opaque identifiers, never authority.
- Provider options contain selection data only. Trusted callbacks and credential bytes stay in the
  in-process provider context or staged launch material.
- Unsupported capabilities refuse. No provider reports a successful no-op.
- The manager journal is authoritative for intent, ownership, record identity and operation history.
  Provider observations are evidence joined to that state.
