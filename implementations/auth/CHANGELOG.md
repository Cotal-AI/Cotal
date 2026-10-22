# @cotal-ai/auth

## 0.96.0

### Minor Changes

- 083205e: Add `AuthProvider.serviceEndpointRenewal`, a renewal source for one registered service witness that a long-lived service endpoint passes as its bearer function. The first pull activates and later pulls renew, replaying one persisted request per operation, so renewal never exhausts the instance's request bound. An outage, a missing sign-in or a store failure is reported as `unavailable` and retried with the same request, and an expired renewal proof reactivates on the signed-in login under the same request; a revocation, expiry of the root or approval, or other denial from the space ends the source. Tokens leave only through `bearer()`.

### Patch Changes

- Updated dependencies [083205e]
  - @cotal-ai/core@0.96.0
  - @cotal-ai/workspace@0.96.0
  - @cotal-ai/lang@0.96.0

## 0.95.2

### Patch Changes

- @cotal-ai/core@0.95.2
  - @cotal-ai/lang@0.95.2
  - @cotal-ai/workspace@0.95.2

## 0.95.1

### Patch Changes

- @cotal-ai/core@0.95.1
  - @cotal-ai/lang@0.95.1
  - @cotal-ai/workspace@0.95.1

## 0.95.0

### Patch Changes

- Updated dependencies [b7acdcc]
  - @cotal-ai/workspace@0.95.0
  - @cotal-ai/core@0.95.0
  - @cotal-ai/lang@0.95.0

## 0.94.7

### Patch Changes

- @cotal-ai/core@0.94.7
  - @cotal-ai/lang@0.94.7
  - @cotal-ai/workspace@0.94.7

## 0.94.6

### Patch Changes

- Updated dependencies [ba9155a]
- Updated dependencies [520c66b]
  - @cotal-ai/workspace@0.94.6
  - @cotal-ai/core@0.94.6
  - @cotal-ai/lang@0.94.6

## 0.94.5

### Patch Changes

- Updated dependencies [4b64fe7]
  - @cotal-ai/workspace@0.94.5
  - @cotal-ai/core@0.94.5
  - @cotal-ai/lang@0.94.5

## 0.94.4

### Patch Changes

- Updated dependencies [464413c]
  - @cotal-ai/workspace@0.94.4
  - @cotal-ai/core@0.94.4
  - @cotal-ai/lang@0.94.4

## 0.94.3

### Patch Changes

- 606059c: `deviceLogin` and `establishIdpSession` accept an optional `signal`. Aborting it stops this sign-in on this machine: the wait, the poll and any IdP request in flight end at once, no further request is sent, and nothing is saved, even when the abort comes after approval. It rejects with the new exported `IdpLoginCancelled`, which is distinct from `IdpUnreachableError`. Cancelling revokes nothing at the IdP. Without a signal, sign-in behaves as before.
- @cotal-ai/core@0.94.3
  - @cotal-ai/lang@0.94.3
  - @cotal-ai/workspace@0.94.3

## 0.94.2

### Patch Changes

- 454cb0e: Include the human-only approval, review link and unchanged-request retry instructions inside the structured pending result as well as its text. Native clients that show the model only structured content must still receive the instructions to wait for the person and never approve or poll on their behalf. Issuance remains blocked by the authority until the person's recorded decision.
  
  Explain expiry without incorrectly claiming the person never approved: an approved request can also expire before its connection is issued. A fresh request still needs fresh approval.
  
  Exercise native connection, exact recovery, capability attenuation and completed workflows through an isolated approval authority and fixture-person decision, including pre-approval transcript exclusion. Register the live approval controls in the smoke gate.
- @cotal-ai/core@0.94.2
  - @cotal-ai/lang@0.94.2
  - @cotal-ai/workspace@0.94.2

## 0.94.1

### Patch Changes

- @cotal-ai/core@0.94.1
  - @cotal-ai/lang@0.94.1
  - @cotal-ai/workspace@0.94.1

## 0.94.0

### Minor Changes

- 1caaf63: Add explicit standalone-broker payload bootstrap for service caller policy. Hosts supply fresh VARZ-only SYS observer credentials through a broker-owner helper, and broker configuration accepts an explicit maxPayload without changing its default. Assertions bind actual broker configuration, stream limits and the genuine plane claim. Caller issuance rechecks live evidence, exact assertion and effective authority before release, refuses stale prior-plane appends, and drains owned observations before shutdown. Clusters, gateway and leaf configurations remain unsupported. No production configuration is changed automatically.
- 311a26e: The service endpoint host serves `caller-grant`, `caller-revoke`, `caller-policy-read` and `caller-policy-list` instead of answering `unsupported`. A grant needs an interactive owner who holds the approved instance and an interactive grantee with no parent. Its capabilities must be pinned to that instance with `instanceOnly`, carry no journal access and no `any` or `ledger` target, and sit within the approval's ceiling. It is recorded `active` with a host-derived id, source and parents. One instance indexes at most 256 grants. A revoke lands deny-new, then writes the grant's op-bound cutoff marker and a `notBefore` in epoch seconds from the marker's broker time. It answers `pending` and never `revoked`. Each operation record keeps the exact request and the grant's immutable fields, and a positive grant write is recorded before it is issued, so a replay never repeats a write whose outcome is unknown. Grants also need a payload precondition: every server's `max_payload` at least 2 MiB plus 1 KiB, an auth stream with no per-message limit, and an operator assertion recorded in the auth store. Stock records no assertion and its generated broker keeps the 1 MiB default, so a stock deployment answers `unsupported` to grants. A failed check or a revoke write that would not fit withdraws the assertion. The operation kind gains `grant`, operation views accept the caller target, and the result parser accepts the grant and caller-policy read and list results.
- a0db172: Ordinary and managed user-auth callers now receive exact-lifecycle endpoint caller rows from native caller policy. Controlled owner grants to managed actors capture their actual current parent lifecycle and covering immutable grants. The callout checks current approval, root, name, assignment and ancestor policy, uses core's native row builders, and rechecks authority after signing and native-key recording. Revocation denies new issuance without claiming terminal connection removal. Applications still need service-host approval and the asserted payload prerequisite. Native control endpoints retain their existing authority contracts.

### Patch Changes

- a7aa9e0: An approval's caller ceiling now admits only entries pinned to the approved instance (`instanceId` with `instanceOnly`), on a declared command, with exactly the target presence and mode that command admits. `any` and `ledger` entries are refused because no operator target policy is wired. Any other entry answers `bad-request` before the decision binds, and an empty ceiling stays valid. The service host operations that take an approval are new in this release, so no released deployment is affected. The internal caller-policy storage also treats a stored grant whose fields other than status match as already present, so a replay after deny-new adopts the row and never reactivates the grant, and it gains the step that records a revocation's cutoff marker and deadline once, refusing other values or another operation's intent.
- Updated dependencies [1caaf63]
  - @cotal-ai/core@0.94.0
  - @cotal-ai/workspace@0.94.0
  - @cotal-ai/lang@0.94.0

## 0.93.0

### Minor Changes

- 6703917: Connect personal native Claude conversations to signed-in meshes with separate identities, real lifecycle and own-event publication, durable request recovery, and exact-lifecycle retirement. Bind native wake readers to their conversation while retaining immediate idle and busy-boundary delivery. Capture lifecycle metadata through ordinary command hooks so the native connection does not depend on intercepting the built-in guard's protected events. Keep notification presentation off protected notes and skill output while retaining native sender attribution.

### Patch Changes

- babeb0c: A spawner whose grant covers its own event channel may now hand each child that child's own event channel, `events.<owner>.<child>`, and no other.
  
  The ledger's delegation rule checked a child's event channel against the spawner's post list like any other channel. A spawner that holds only its own event channel, such as a signed-in native conversation, could therefore never spawn on a mesh that requires events: the Manager adds each child's own event channel, and the ledger refused it. The spawner's own event channel is still checked against its parent up to the root, so a parent that may not post events still cannot pass them down, and a sibling's event channel is still refused.
- Updated dependencies [e27c44c]
- Updated dependencies [69b0538]
- Updated dependencies [6703917]
  - @cotal-ai/core@0.93.0
  - @cotal-ai/workspace@0.93.0
  - @cotal-ai/lang@0.93.0

## 0.92.2

### Patch Changes

- 736207e: `cotal spawn --foreground` on a remote user-auth mesh with no sign-in now exits 2 with `AUTH_REQUIRED`, before any request is sent. Before, it was reported as an unknown outcome (`OPERATION_UNKNOWN`, exit 3), which told a script the agent might have been provisioned. Any failure after the provisioning request, an endpoint 401 or 403 included, is still an unknown outcome.
- Updated dependencies [43a5715]
- Updated dependencies [736207e]
  - @cotal-ai/core@0.92.2
  - @cotal-ai/workspace@0.92.2
  - @cotal-ai/lang@0.92.2

## 0.92.1

### Patch Changes

- Updated dependencies [5a0b741]
  - @cotal-ai/core@0.92.1
  - @cotal-ai/workspace@0.92.1
  - @cotal-ai/lang@0.92.1

## 0.92.0

### Minor Changes

- 719ac35: Serve the public service endpoint authority route, `/service-endpoint-authority`, on both faces of a context opened with `serviceEndpoints` (still off by default, no CLI flag; without it the route answers 404). `GET` returns the receiver's account and space. `POST` takes one envelope whose IdP proof, under the pinned issuer and exact audience, derives the owner, who needs a current interactive cli or web row; the loopback capability is never read, and a service proof is refused. Register compiles the submitted closures against their content digests, admits ephemeral commands only and answers `approval-required`, or `pending` once approved; it never registers or issues a credential. Status reads the caller's own register operation. The full public idempotency key selects the engine binding, and the binding covers the public request digest, so a changed body is a conflict and another owner's equal request id is a separate request. The service endpoint host gains a create-only, operator-only `name-bind` written through the custody writer, and the host result parser gains its `bound` arm. A refused proof counts against the face's refusal budget.
- e242d82: Add the dormant service host operations behind the service custody writer: register admission, approve, refuse, revoke and the operation and proposal reads, over closed per-key records in the auth store. Each invocation writes only the keys its discovery located, and holds before any other write. Its effect connection has its own credential, which publishes only those keys and expires at the invocation's original deadline, rounded up to the whole second, with no renewal or reconnect. The index does not export them. An authority plane or hosted auth service opened with `serviceEndpoints` (off by default, no CLI flag) hosts them and gains an in-process `serviceEndpointHost` for decide, revoke and the two reads; register admission stays internal, so nothing in the product creates a proposal, and the embedder must authenticate the granter it passes. The host shares the plane's claim hold, account and actor ledger, refuses a restore or missing startup, reads through an ordinary renewing read-only discovery connection, trips on both plane fatal paths (also while the plane closes), and on close refuses every call from the moment close begins, waits for every call that entered and closes again every effect connection that did not close, failing with the claim still held while one remains, before the claim is released. The service host contract gains the typed results and closed parsers these operations return. Once an operation is bound, `pending`, `held` and `refused` results name it, revoke results report whether deny-new landed when they have evidence for it (another assignment's endpoint gate is `unknown` on every path that reads the gate), and completed results say whether they were applied now or returned from the record. Proposal and operation reads gain separate terminal views that carry no commands or cluster digests.
- 1db940e: Add authenticated cooperative workflow cancellation through the manager endpoint. The original caller can cancel under a live issued generation; signerless hosts also verify interactive owner or admin authority through the issuing host. Replies distinguish the durable revocation marker from an observed local drive outcome, preserve unknown write outcomes and retain the first marker. Read-only status inspection remains available after revocation without permitting new drive or checkpoint-answer authority. The run show view displays revocation separately from recorded state and returns a partial result with exit 4 when the marker cannot be read, in human and JSON output.

  Breaking: embedded RunHostDrive implementations must supply cancel(reason) separately from release(reason). Both language engines and the worker bridge propagate cooperative root cancellation. This does not preempt external tools, stop agent processes or prove resource cleanup. No new CLI or MCP convenience command is added.

- f276a46: Add distinct keyed workflow submission and caller-confined status contracts, immutable admission-store bindings, bounded original-callback admission attempts and pinned client helpers. Advance the manager cluster to revision 35 for the two new commands. Preserve legacy run-start behavior and retain incomplete submissions without later repair.
  Keyed requests carry a deadline of at most 30 seconds, measured on the receiving process's
  monotonic clock from the new `EpServeContext.receivedAtMonotonicMs`, with the caller's authority
  expiry checked on the wall clock. Launch capacity is reserved before the binding, an unfingerprintable keyed request no longer stops the issuer's observation reader, and
  the client helpers refuse a reply for other submission coordinates.
- b3441b1: Breaking: a service endpoint authority status query now names the operation it reads, `target: { kind: "operation", operation, requestId }` with `operation` one of `register`, `activate`, `renew`, `ready` or `revoke`, through the exported `ServiceStatusTarget` type. The old `{ kind: "operation", requestId }` no longer parses, so code that builds `ServiceAuthorityRequest` status queries or calls `parseServiceAuthorityRequest` on them must add the operation.

  The service endpoint authority route of a context opened with `serviceEndpoints` (still off by default, no CLI flag) now registers and serves an approved service. Once the owner's assignment is approved, the same register request publishes its contract artifacts and runs the native registration barrier, and answers `registered` with the witness and snapshot; a replay of a completed register answers from its registration stamp without another barrier. Activate (IdP or renewal proof) lands the activation fence and returns an access bearer of at most 60 s and a renewal proof of at most 24 h, never past the native root or approval; renew (renewal proof) returns fresh material; ready (access proof) records the service-reported status. Each of these requests first proves its caller, resolves the caller's own assignment and persists a nonsecret request intent before any effect, with at most 64 distinct requests per instance; a changed body under the same request id is a conflict. A register request id stays bound across both phases to the body and proposal it was admitted with, and material that cannot be minted before its expiry answers 503, so the replay mints it. Status reads the instance or any of these operations under a fixed precedence and answers 503 rather than guess. The context also composes the native service callout, so a current service's access bearer connects to the broker. Commands declaring a governed trait are refused as unsupported. Revoke, the Describe view, caller policy, terminal retirement and restore stay unsupported.

### Patch Changes

- 88cc5a1: Name the next step when an auth command has no space to act on or a grant cannot apply there.

  - On a static or open space, `cotal auth grants`, `grant` and `revoke` and their `cotal actor` spellings refuse with `UNSUPPORTED` and say that actor grants apply only to a space started with `cotal up --user-auth`. On any other space the refusal still points to the machine and root that hold its ledger, and a refused revoke says nothing was revoked instead of "no inert grant was written".
  - With no space to resolve, the auth grant commands and `cotal auth mint` refuse with a next step, such as `cotal up`. `cotal doctor auth` in a folder whose root holds no space adds a remedy to its partial result: run it in a space's root, which `cotal space` lists.
  - Bare `cotal auth` fills its Next lines with the `--space` you gave or the space it resolves, and points to `cotal space` when there is none, instead of printing an unfilled `--space <space>`.
  - The `cotal doctor` help line describes the report it prints, instead of promising it ends in `healthy` or a next command.

- Updated dependencies [88cc5a1]
- Updated dependencies [88cc5a1]
- Updated dependencies [88cc5a1]
- Updated dependencies [88cc5a1]
- Updated dependencies [1db940e]
- Updated dependencies [239d1c7]
- Updated dependencies [f276a46]
- Updated dependencies [c935e28]
- Updated dependencies [588a5a7]
- Updated dependencies [b3441b1]
- Updated dependencies [03d9e7b]
  - @cotal-ai/core@0.92.0
  - @cotal-ai/workspace@0.92.0
  - @cotal-ai/lang@0.92.0

## 0.91.0

### Minor Changes

- 5c85ef3: Add closed user-mode chat row, holder-index, quota and parent-pin foundations, and optional chat session methods to AuthProvider. Interactive and managed grants refuse aliases already present in the chat row space. Admission and public chat entry are not wired by this foundation.
- 5c85ef3: Apply the new terminal screens to status, help, settings, setup receipts and inventories. Add compact action guidance, command shorthands, named agent details and the live observer. Group guarded manager maintenance and channel metadata operations under their new command names.

  Validate the public recipient and agent-target arguments before installation or catalog preparation.

  Support explicit message file/stdin input, channel mentions and direct replies with non-echoing structured storage receipts. Show broker-derived channel membership without treating it as access or task progress.

  Consolidate workflow reads, file-based launches, offline language tools and own-seat turn handling under run/r with explicit source and outcome labels.

  Add account-provider selection, private device-approval guidance, structured sign-out receipts and a non-installing update availability report.

  Expose native managed-launch readiness and original request/goal attribution, verified self stop,
  hard despawn and manager supervision flags. Add non-echoing native terminal-input receipts,
  authorized endpoint contract/invocation reports, the full read-only watch view family, partial
  recorded team reads and account/actor authority reports. Keep unestablished live state explicit.

  Share protected owner-private local record access between endpoint references and service
  definitions. Add case-safe per-space service definition inventory, guided/file import, policy
  reports and guarded local removal, keeping existing process observations distinct from owned
  instances and serving readiness.

  Resolve saved endpoint targets through the canonical describe/invoke namespace. Pin the local
  reference revision through native calls, disclose the resolved target and preserve exact instance
  selection without broader-caller or class-queue fallback.

  Read authorized native endpoint registrations with explicit bounded-lag enumeration, leader-read
  coordinates and partial results for unreadable or omitted keys. Keep registration, reported status,
  process ownership and current serving responses distinct.

  Add the guarded history-clear screen with default-cancel scope review, explicit scripted confirmation,
  offline dry-run and per-stream native purge receipts. Preserve acknowledged partial work and unknown
  submissions without retrying destructive requests.

  Expose digest-verified action metadata to clients and add native endpoint action following with
  --wait. Retain original requests and accepted goal identity, use accepting-instance reconciliation
  and emit explicit bounded goal stream records without resubmitting an unknown action.

  Apply the shared report treatment to classified failures and expose safe original-request, accepted-
  goal and responder attribution without copying raw argument or native-detail objects into reports.

  Make spawn --file select a persona on its execution host, with the native shared manifest schema
  providing the team-deploy refusal. Add non-launching offline preview reports and a protected explicit
  foreground enrollment-file input without changing native launch fields or adding wire authority.

  Add a Linux process-service driver with machine/boot and process-creation ownership, exact
  instance selection, explicit multi-instance launch, bounded readiness/log reads and guarded
  stop/restart/removal. Distinguish owned process presence and HTTP reachability from endpoint
  serving, retain uncertain launch receipts and never fall back to PID-only or remote controls.

  Add ownership-aware completion installation, refresh and removal with finite JSON/plain receipts.
  Keep custom and modified shell material, preserve the stable offline dispatcher and refresh only
  existing recorded stubs through the current-generation updater without adding startup wiring.

  Add offline endpoint contract scaffolding and checking through the installed native cluster/schema
  compilers. Create files exclusively, derive digests from schemas and keep handler execution,
  serving authority and opaque attribute/event semantics separate from local validation.

  Expose native ephemeral endpoint casts with pre-publication journal refusal and non-execution
  receipts. Keep original request/binding attribution, broker denial and unknown outcomes distinct.

  Expose target-bound account signer export under auth signer with required protected output,
  inspected same-account replacement, public-only receipts and no operator-root or caller issuance.
  Share protected workstation file access across the credential, endpoint and service frontends.

  Add protected, explicitly unverified handle metadata inspection without signatures, redemption or
  caller issuance. Resolve literal nested help and scoped aliases through declared metadata while
  keeping help offline and provider imports behind validated execution.

  Move static credential minting into auth mint through a registered implementation action, with
  one shared flag grammar and public-only JSON/plain receipts. Keep source-root authority/profile
  checks, native provisioning and expiry metadata, use create-only default labels and explicitly
  report a reused nkey's new out-of-band lifecycle instead of claiming its old inbox was retained.
  Reject the top-level mint spelling before effects and keep explicit exports out of managed state.
  Name both roots when the selected root and current folder disagree about the signing authority.

  Expose one-shot native endpoint class scatter with frozen-set reconciliation, attributed member
  results and every native anomaly bucket. Keep pinned/targeted/journaled calls off this route,
  preserve classified mixed/unknown outcomes and retain useful result data in finite failure reports.

  Add exact-manager persona list/show/create with native ownership checks and bounded complete-file
  merging. Refuse unsupported metadata before submission, retain the actual responder/request and
  separate a confirmed save from a denied or unknown optional announcement without retrying it.

  Expose exact-target endpoint deregistration through the existing native guard as a registered
  operator action. Require a reviewed full class/instance, preserve TLS and selected static authority,
  refuse unsupported auth fallback, keep dry-run offline and report native deletion revisions or
  uncertainty without retry. Turn the old default-instance spelling into a pre-effect migration refusal.

  Add finite private-backup creation receipts after native cleanup, read-only manifest inspection
  and size/SHA-256 verification without staging or restore claims. Expose exact-attempt recovery
  and healthy fallback cleanup with default-cancel review, offline plans, revision rechecks and
  native owner/identity guards. Keep confirmed publication and incomplete cleanup distinct.

  Add public-only JSON/plain feedback receipts with bounded response metadata, explicit unknown
  submission outcomes and no redirect or retry. Accept protected key-file input, refuse raw keys on
  argv and keep submitted bodies, contact values, credentials and response text off diagnostic output.

  Move credential diagnosis and native static daemon repair onto shared JSON/plain reports. Add
  nonmutating observation intent at the existing local migration boundaries, retain acknowledged
  path moves/re-signs separately from adoption, keep prior broker refusals visible and avoid live
  agent or open-mode claims from absent/local credential files. Never expose secret fingerprints or
  raw credential/audit parser diagnostics in the new reports.

  Evolve workstation local-process providers with a versioned service ABI, closed bounded option
  schemas and package-bound cached declaration fingerprints. Validate definitions without provider
  imports, then route explicit adapter launches through the creation-pinned direct-process
  controller. Retain adapter provenance, exact native readiness coordinates and unknown hook
  outcomes. Check declared capabilities and keep service launch intents behind extension-removal
  guards without introducing wire grants, manager impact bypasses or implicit dependencies.

  Add declarative service presets with schema-derived parsing, scoped help/completion and guided
  creation. Validate declared protected path references without reading contents. Expose the native
  feedback-intake preset through the shared controller, using the guarded same-binary re-exec and
  existing intake implementation. Correlate post-listen startup with the exact child/launch,
  preserve TLS and private append-only storage, keep credentials on file references and refuse
  the former top-level intake launcher before effects. Separate controller-only providers from
  legacy PID inventory and retain startup/data receipts without claiming endpoint serving.

  Expose the independent delivery preset through its own registered local-process provider, using
  shared workspace custody metadata instead of an implementation import. Retain the native scoped
  store, SYS account scan, singleton lease and TLS checks, refuse legacy custody adoption and
  publish startup only after native readiness. Share private child-bound startup receipts and
  public-only target resolution between native adapters, while preserving the workstation path
  context without inheriting arbitrary credential or agent identity environment values.

  Expose caller-scoped manager stop-impact observations through the native status contract. Reuse
  its actual runtime seat policy, retain owner filtering and show pending lifecycle/retirement work
  without treating an observation as stop authority, a reservation or completed cleanup.

  Put manager gate repair and retained-seat maintenance on shared JSON/plain reports and default-
  cancel confirmations. Preserve the registered target/TLS policy, classify uncertain submitted
  effects without replay and separate native gate/custody receipts from serving or cleanup claims.

  Apply scoped grammar/help and shared account, inventory and native-request reports to Linear.
  Keep native MCP isError results distinct from unknown execution, bound human output without
  truncating JSON and preserve its existing serving/caller authority during the pending transitions.

  Give existing native Linear caller issuance a private create-only output preflight and shared
  receipts. Preserve original identity/lifecycle and uncertain provisioning/publication without
  replay, broader caller substitution, managed-launch claims or environment-export onboarding.

  Keep direct-service supervisor assignment distinct from unperformed OS discovery in instance
  and preview reports; a recorded none does not claim external supervision is absent.

  Prepare private, request/process-bound native stop handoffs and immutable phase observations.
  Keep cleanup unverified and existing reservations untouched; manager service control is not
  activated by these primitives alone.

  Expose the manager embedding's own registration/policy observation without exporting credentials,
  URLs or grants. Keep it distinct from fresh serving evidence and wire caller authorization.

  Provide a public-only native manager identity callback before endpoint construction and expose
  its actual per-process UID in status. This supplies launch-correlation data without treating
  identity metadata as serving readiness, ownership authority or a generic caller grant.

  Prepare private native identity bindings before endpoint construction. Preserve dotted endpoint
  class names under the native validator, keep epochs out of pre-serving identity data and require
  a separate attributed response before any serving or process-control inference.

  Add the native manager service preset with pre-endpoint identity binding, post-start signal-ready
  receipt and invoking-caller readiness/impact observations. Show the full native seat consequences
  before default-cancel confirmation and bind the unchanged scope to the live native reservation.
  Require immutable accepted/returned evidence plus original process exit before a stopped record;
  retain unknown requests without force kill or restart, and leave cleanup unverified. Keep generic
  and legacy signal paths from bypassing this boundary. The child never publishes its console URL.
  Foreground, OS-supervised and non-Linux manager service operation remain unsupported.

  Add the prepared native auth-service preset with shared daemon inputs, exclusive real-child PID
  custody and a private post-initialization startup receipt. Keep discovery capability and key
  material native and private. Refuse existing custody, remote brokers and TLS-required targets
  instead of reclaiming a daemon, weakening transport or generating new issuer material. Keep
  foreground/OS-service operation unsupported.

  Add the Linear service preset over the existing account, native static registration and renewal
  implementation. Bind its explicit root/registered transport and publish a private handler-
  initialization phase only after shutdown handlers exist. Keep process/initialization evidence
  separate from broker flush, fresh endpoint response and native deregistration completion. Refuse
  unsupported issuer/foreground/OS-service modes without substituting authority.

  Show checked installed preset metadata and declared readiness/foreground/instance/stop capabilities
  in service inventory. Keep unavailable or mismatched metadata partial with explicit warnings;
  metadata validation is not application readiness or OS-install support.

  Prepare full-instance/definition/host-bound supervisor receipts and non-echoing recorded-unit
  file observations. Keep loaded OS state/autostart unchecked, preserve missing/modified receipts,
  and refuse direct process controls or removal beside a recorded supervisor. OS installation and
  native unit control remain unimplemented; no unit is created or enabled by these readers.

  Claim the managed manager child's real native PID custody exclusively before endpoint startup,
  without adopting a contender or treating a starting record as readiness. Settle the same process
  and retain owner-bound release after native start; keep legacy entry behavior separate.

  Add bounded same-host status reads for unchanged recorded systemd user units. Report physical
  fragment, native states, invocation and exact process/launcher attribution without unit or
  environment bodies; keep missing/ambiguous/drop-in observations partial. Status does not reload,
  start/stop a unit, infer endpoint readiness or prove effective autostart.

  Prepare a built-in direct-process unit boot entry with complete controller/definition/instance
  validation before extension overlays, repair or package materialization. Require the recorded
  native invocation before same-PID process replacement, refuse managed-spawn handoffs and retain
  unknown starting evidence without retry. This does not install units or prove execution/readiness.

  Declare auth and Linear foreground service lifetime through the shared owned-child controller
  and native shutdown handlers. Print lifetime/output policy before launch, retain manager's native
  impact requirement, and prevent native service child boot from repairing connector packages.
  Process exit still does not prove endpoint, descendant, registration or authority cleanup.

  Route recorded systemd service logs through bounded native journal reads/following pinned to the
  original unit invocation, boot and UID. Preserve native cursors/timestamps and binary JSON, report
  record/query/diagnostic gaps, close only the reader on interruption, and refuse missing invocation
  evidence without substituting a direct-child file. Journal retention and cleanup stay unestablished.

  Expose the service install/uninstall paths with the same exact definition/instance
  selection and a typed unsupported boundary where native OS control is missing. Never route them
  through the old manager-only installer, allocate a stopped record or change autostart on refusal.

  Expose auth redeem with closed per-mode input and the selected native auth target. Refuse
  unsupported conferring-handle redemption before reading the file or spending authority, rather
  than substituting agent enrollment, session redemption or unverified artifact parsing.

  Move the dashboard package from its public command to an owned service preset with explicit
  protected static credentials and read-only intent. Preserve native HTTP/cookie/origin behavior,
  registered TLS, exclusive PID custody and private full-launch bootstrap records; publish only
  process initialization and non-secret reference paths. Refuse unsupported user-auth/open/OS
  routes without operator identity or mutation-transport fallback. Hide obsolete cached web commands
  and refuse them with an explicit matching-update remedy before loading code or repairing installs.
  Keep legacy process observations separate and migrate setup, tool hints and dashboard guides.

  Add auth mint --endpoint with closed channels/expiry/private-output inputs and the shared static
  signing-authority checks. Resolve a live digest-verified untargeted synchronous ephemeral surface,
  then use the native agent provisioner for its exact additional command rows and lifecycle footprint.
  Refuse targeted/journaled/action scopes without omitting rows. Publish a create-only non-secret
  issuance intent before native footprint work, block blind replay, preserve private output checks
  and report temporary provisioner close separately. Do not add spawn/run/admin authority, user-auth
  issuance, arbitrary raw-file caller derivation, managed launch or environment-export onboarding.

  Expose exact auth retire grammar with a typed unsupported boundary until a caller-owned native
  serve-gate retirement instrument exists; never borrow manager identity or use host loopback doors
  as a substitute. Prepend native journal reader output-close handling before the binary's global
  EPIPE exit; final stream output and reader cleanup remain observations, not assumptions.

  Show endpoint caller scope in the shared receipt: actual caller/lifecycle, described owner and
  responder, native expiry, explicit channels and bounded command rows with a JSON-preserving
  omission count. Label the local issuance request separately from native provisioning evidence.

  Consume paired native standalone endpoint caller files through registered static targets and saved
  references. Verify signatures against current validated issuer pins, matching user keys/time windows,
  native permission projections and principal tags before broker admission. Retain TLS and private
  snapshots; refuse arbitrary/profile/versioned/targeted/instance/scatter/admin/action authority without
  operator fallback, binding repair or unknown-effect replay. Show public caller binding and described
  file-scope limits in shared reports. Share the local intent contract with issuance and validate
  explicit dashboard credentials against the selected issuer before PID custody or initialization.

  Declare the endpoint watch/session/work and invocation handle paths with closed mode
  inputs and typed unsupported boundaries while native declaration/auth-slot adapters are absent.
  Refuse before broker/file access or subscription, cursor, session, lease, commit or redemption;
  never infer a generic subject, remote execution, verified attenuation or broader caller authority.

  Route one named down target through the existing owned-service stop controller and retain its
  native identity, confirmation, reservation and manager-impact policy. Keep down-labelled finite
  receipts, full-instance selection, offline preview and saved-definition completion. Refuse
  multi-service sets before effects until whole-set preflight exists, reject named agent-reap flags
  with the explicit manager-service remedy, and never fall back to a legacy component PID. Reject
  new receipt/acknowledgement flags on the bare-stack/manifest paths.

  Expose the existing direct endpoint/workflow stream definitions through one pure native config
  factory consumed by bootstrap. Retain creation order, options, retention-floor checks, independent
  ownership census and existing contract/authority hardening; do not add schema mutations or schema
  apply.

  Add a pure conservative diff for that native stream subset. Preserve not-observed, denied,
  not-found-without-authoritative-absence and target-mismatch states; compare only explicit fields,
  retain uninspected defaults and never emit creation/migration actions or enable apply. Add no
  full-space schema observation, authority policy or privileged reconciliation.

  Share native message/registry, contract, authority/session, issued/admission, membership and artifact
  creation inputs with a read-only resource catalog, retaining the existing TTL source, native guards
  and independent inventories. Keep SDK defaults, complete canonical policy, seeds/default delivery
  and reconciliation authority unestablished.

  Add a narrowed native stream-info facade and internal resource observer with structured SDK
  error classification, no message matching, credential substitution or authoritative absence.
  Share declared-field comparison with the endpoint subset; keep native KV/object verification
  required, expose uninspected fields and always disable apply.

  Share native registry seed ordering and profile-default patches with explicit no-write initialization
  definitions. Preserve seed-before-profile precedence and existing explicit delivery classes. Keep
  validation, strict revision observations and guarded application separate; do not infer a profile,
  expose patch bodies in diagnostics or claim legacy seeding gained revision safety.

  Share pure native contract, authority/session, issued/admission and artifact config checks between
  existing creators and schema comparison. Retain the guarded shadow/legacy-cap migrations outside
  readers, never run TTL write canaries during diffing, suppress raw native failure text and distinguish
  uncompared fields, unconfirmed checks and invariant matches from complete canonicality or authority.

  Add bounded read-only initialization observation over an existing selected registry handle. Validate
  native profile/patch inputs before key reads; retain revisions and tombstones and keep missing,
  denied, unavailable, malformed, mismatched and unvisited rows distinct. Preserve private values,
  explicit deadline/non-cancellation and incomplete field-policy labels. No bucket open/create,
  credential fallback, revision-guarded write plan or apply authority is introduced.

  Prepare a read-only existing-static schema inspection adapter with upfront native input validation,
  strict registered root/server/TLS selection, validated current full trust and one native temporary
  provisioner identity. Keep native mode/floor and registry read failures, private observations and
  local reader closure explicit. Do not expose mutation ports, substitute other authority, promote
  reported server metadata to account proof or connect an incomplete apply/public command path.

  Share the existing pure primary/Limits/no-global-eviction authority-store check through core for
  schema inspection and native lifecycle binding. Preserve the auth module's sibling import surface,
  existing checks and error class/text. Move no lifecycle/gate operation, connection, grant or repair
  into core, and keep complete field policy and apply authority separate.

  Attribute the first failed native primary/no-eviction invariant to structured field names from the
  same ordered check. Keep native diagnostic text private to its existing bind error, preserve its
  class/message and avoid parsing or echoing exception strings in schema reports. Field attribution
  is not full canonical policy, current binding, write authority or a completed migration.

  Prepare explicit registered open-mode schema inspection alongside static mode. Select the mode
  before connection, preserve registered TLS, load/mint no open-mode signer or identity and require
  the reported broker authentication mode to match. Keep user-auth unsupported, never retry an auth
  refusal anonymously, and retain private reads and disabled apply without public command wiring.

  Compare extra observed direct-stream fields with the existing first-party baseline, without
  normalizing absent settings from desired values or copying private SDK defaults. Classify
  nondefault undeclared/unmodeled settings as blocked and expose field names without their values.
  Reuse reserved NATS metadata policy; do not add KV/object expansion, full policy or apply.

  Prepare a public-only schema inspection projection and shared terminal view without connecting an
  incomplete public/apply path. Show target/profile, non-atomic resource/key observations, revisions
  and safe policy-field attribution. Omit raw configs, registry/patch contents, unknown field names
  and native diagnostics; retain unproven absence, incomplete policy and disabled apply labels.

  Add one bounded native NATS current-connection identity query and the temporary provisioner's
  self-only `$SYS.REQ.USER.INFO` publish grant, documented in the ownership matrix/profile summary.
  Require matching public user/account/server before static schema reads without system credentials,
  arbitrary-user queries or authority fallback. Ignore response permissions/expiry as ceiling or
  lifecycle evidence and keep apply/absence authority disabled; explicit open does not invent an
  identity. This is prepared source, not a native conformance or deployment claim.

  Compare native store subjects and explicit public KV/object creation options with their documented
  wire fields, including TTL/marker units, storage, history, limits and hardening. Do not fill SDK
  defaults or invoke constructors. Block unexpanded options, expose their count rather than values
  and keep full field/runtime/revision/apply policy separate.

  Compare observed existing registry rows using native seed-before-profile precedence, a closed
  known-field policy and private revision-pinned candidates. Preserve explicit delivery choices,
  block unknown fields and unreadable/deleted/missing rows, and expose only comparison states,
  changed field names and observed revisions. Do not turn a candidate into write authority or
  change legacy seeding; add no guarded application or public stack/update path.

  Bound the resource observer by one shared deadline, preserve unvisited rows and surface the
  budget separately from policy comparison. Deadline expiry is not request cancellation or
  authoritative absence; the caller still owns connection closure.

  Extend observed-extra-field policy to native KV/object backing streams using shared first-party
  baselines and scalar public KV input defaults, not private builders or missing-field filling.
  Retain native artifact direct-read tolerance and valid smaller TTL duplicate windows. Unknown
  or nondefault fields remain blocked, and runtime/full-schema/apply authority stay separate.

  Name only the existing TTL-enforcement, stock legacy artifact-cap and contract-shadow guard
  families in reconciliation reports. Share native constants/hardening fields, block other drift
  and unknown settings, and keep guard-required metadata separate from an accepted migration.
  Inspection runs no canary, state guard, creator, update or readback.

  Route multi-name down through whole-set owned-service selection, process-role preflight, stable
  definition reservations, explicit default-cancel confirmation and complete native-impact recheck
  before the first stop. Keep per-effect native guards, input-order execution and one attributed
  receipt. Stop on failure, retain unattempted members and never claim atomic rollback or cleanup.
  Dry-run imports no provider and reserves/stops nothing; duplicate names and multi-name instance
  selectors refuse. Bare-stack and manifest migration remain separate.

  Include selected-space owned service definitions/instances on the shared status screen and JSON
  result. Keep legacy pidfile rows separately labeled. Show full identities, process observations,
  historical readiness and supervisor-record evidence without endpoint or OS-state promotion;
  unavailable record families make the report partial rather than empty. Read no provider code
  and control no service. Recheck each held definition again immediately before its set-stop effect.

  Keep whole-set reservation/preflight and release errors in the attributed down receipt. Attempt
  all acquired-hold releases without claiming verified lock cleanup or erasing completed stops.
  Owned-service status warnings retain classified cause codes without native diagnostic bodies.

  Share desired native resource creation configurations across the first-party stream baseline,
  public scalar KV defaults, explicit options and hardening. Reject unexpanded inputs and include
  hardening at creation rather than adopting and updating an existing bucket. Keep creation input
  construction separate from mutation authority, existing-store repair and broker-store custody.

  Make up background by default with an explicit --foreground mode and --detach as the accepted
  background spelling. Reject conflicting intent before seed/effects, preserve each recovery
  request's recorded mode, and document the supervising-unit/container migration. This retains
  the native launch path.

  Extend the background-up systemd advisory to the exact native invocation/main PID, naming the
  unit and --foreground remedy without mistaking inherited terminal metadata for main-process
  ownership. Preserve inherited recovery-lock release when new mode validation refuses early.

  Connect setup's explicit start/detach flow after saved preparation. Validate script detachment
  before effects, keep configure-only and default-cancel Start decisions separate, and retain one
  finite setup envelope around the shared native managed-join observer. Local startup uses the
  prepared root and original CLI, pins the follow-on request to its recorded manager and never
  promotes command exit into readiness. Preserve safe failure/request/coordinator coordinates,
  saved preparation and unknown outcomes without retrying, rolling back or replacing a manager.
  Allow self-hosted setup startup to select one manager with --on before preparation writes;
  retain that request in receipts and next-step hints. Local setup retains its own manager
  pin and refuses an external selection.

  Show the resolved mesh in shared rich/plain report headers, including ps and failures,
  without re-resolving selection or changing JSON envelopes. Keep mesh context on live
  watch and history rows and membership snapshots.

  Route named Linux reset space through reviewed native local identity cleanup with
  provider-declared key inventory, full local trust validation, unchanged filesystem scope,
  stopped-custody checks and default-cancel confirmation. Restrict secret and raw deletions
  to the reviewed remaining tree, retain returned per-path receipts on partial/unknown outcomes,
  and remove only the unchanged eligible local registration after checking cleanup. Preserve
  personas, service definitions, packages, account logins and remote data; refuse unsupported
  provider, shared-root, foreign-material, TLS-first, remote and non-Linux targets.

  Add bounded all-new agent and mixed channel/agent team deployment on static/open
  meshes through an attributed, exact-manager native launch path. Persist one full intent
  before effects, create new live channel cards through a separate scoped create-only
  writer, then launch agents through the pinned manager. Sync each channel submission
  and returned revision, each original launch request, each accepted allocation before
  goal following, and each identity-matched joined result before continuing. Match both
  step families before saving the full receipt. Retain unknown phases and partial channel
  creates, allocations and joins without replay or rollback; expose them through team
  show/inventory and keep them behind down/reset custody guards. Refuse user-auth inline
  launch, reapply and unsupported manager/runtime selection rather than reusing the
  unsafe legacy writer.

  Extend the native manager slots read with an explicit bounded name query and optional
  retired rows at cluster revision 30. Preserve default nonretired listing, exact manager
  ownership and ordered slot/head observations so teardown can distinguish native terminal
  and cleanup facts from a stop acknowledgement or a missing live-map row.

  Route static agent-only team removal through the original manager and exact recorded
  incarnations, with native impact preview, default-cancel confirmation, root maintenance
  locking, synced original stop markers and matched retired slot/head plus cleanup receipts.
  Retain partial and unknown per-agent outcomes without replay. Keep original creation and
  removal history, and release only a fully receipt-matched deployment's known additive
  blocker in boot/down/reset/deploy guards. Mixed/channel, open/user-auth and legacy removal
  remain unsupported. Show accepted allocations without joined receipts in human deploy
  output as well as structured output.

  Add explicit static-space online handle signature inspection over native leader-served signer
  and issuer-namespaced revocation records. Reuse one protected file snapshot for verification
  and metadata; check raw signatures, issuer scope, parent links and containment without claiming
  presenter binding, holder currency or use authorization. Require current spec/status pairs and
  explicitly unrevoked sturdy handles, preserve offline unverified output by default, and never
  redeem a handle or persist/print the ephemeral reader credential. Refuse unsupported open/user
  authority instead of substituting a signer; report reader-close uncertainty separately.

  Add the independent executable-endpoint service preset for selected Linux static-auth roots.
  Compile and pin local contracts without handler execution, publish native contract artifacts,
  and register through scoped native serve issuance. Run bounded no-shell JSON handlers with a
  separate fixed argv and empty environment, retaining native schema validation, deadlines,
  process/pipe cleanup uncertainty and no effect replay. Distinguish initialized process evidence
  from current endpoint health, renew through the original issuer, pin native deregistration to
  the original revision, and block reuse of unsettled full local service instances.

  Correct reproduced source-build blockers in native registry-reader construction, protected
  record imports, scoped help validation, optional observations and typed terminal reports.
  Bind initialization reads through the public native KV API rather than private handle fields.

  Avoid creating a control directory or catalog lock for a no-account observation, while keeping
  malformed cache refusals and serialized refresh/application for existing signed-in accounts.

  Create a missing extension config root privately before its first lock so a group-writable
  umask does not make Cotal's own directory block completion installation. Keep existing
  permissions and the completion writer's protected-ancestor refusal unchanged.

  Classify local catalog-preparation cache and missing-login failures as pre-effect refusals,
  not unknown remote operations. Keep cache paths and recovery guidance without parser excerpts
  or cached values, and preserve existing-account refresh/application serialization.

  Point unknown-space refusals at the canonical space inventory instead of a removed command,
  and describe missing registration without claiming that its broker is down.

- 5c85ef3: Deprecate the daemon entries `supervise`, `deliver`, `auth-service` and `feedback-intake`. Each keeps its existing flags for units, scripts and containers written for earlier releases, help and completion no longer list them, and every run prints one stderr line naming its service preset (`manager`, `delivery`, `auth-service`, `feedback-intake`) and the release that removes it, `1.0.0` for all four. `deliver pending` warns the same way and names `cotal pending <agent>`. Stdout, behavior and exit codes are unchanged. The top-level `feedback-intake` entry runs again with its existing flags instead of refusing. `up` now starts its manager, delivery daemon and auth service through hidden twins of `supervise`, `deliver` and `auth-service` with the same flags and runner and no warning, so only a unit, script or container someone can change prints it. The process checks that recognise a running manager or delivery daemon accept the twins' command lines too.

  Background `cotal up` that is the main process of a systemd unit now names that unit and the `--foreground` remedy on every route it takes, including the controller-owned stack and a refresh of a running stack. It still changes no mode and no unit. A foreground run, a dry run and `up -f` print nothing.

  The `solo` container in `deploy/` runs `spawn scout --foreground`. `docs/UPGRADING.md` gains the persisted-caller section: the command mapping, the deprecated entries and their removal release, the literal `up --foreground` replacement for systemd and launchd callers, the owned-unit and downgrade notes, and the container change.

- 5c85ef3: `cotal ps`, `cotal models` and `cotal runtimes` write one structured document with `--json` and a plain report with `--plain`, and exit by the structured outcome table. A read that could not read part of what it was asked for, such as a manager that did not answer a census, is `partial` and exits 4, with a warning naming each part it could not read. A mesh a structured command cannot resolve or reach is refused before any request with a stable code (`TARGET_NOT_FOUND`, `TARGET_UNAVAILABLE`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, `DEPENDENCY_UNAVAILABLE` and others) and exits 2, and under `--json` that refusal is one envelope. The user-auth provider names why it could not issue credentials (signed out, service unavailable, refused), so that refusal carries the right code. `cotal version --json` with an unreadable extensions manifest is now `partial` and exits 4. A connector's `listModels` can return `unavailable` with a reason when its install has no catalog to list; the manager then reports it `supported: false` instead of a failed read, and OpenCode 2.x does so instead of failing `cotal models`. An installed connector the manager cannot load makes `cotal models` partial with its load error, and a home folder reached through a symlink is no longer read as a project with a stopped mesh.

  Breaking: `cotal ps --json` writes one envelope whose `result.items` are the manager rows, instead of one row per line. An incomplete manager census exits 4 instead of 1, and a mesh `ps` or `models` cannot reach exits 2 instead of 1. The human reports of `ps`, `models` and `runtimes` are tables, and `ps --wide` prints one record per seat. See the upgrade notes.

- 5c85ef3: Add a read-only auth-provider server preflight and require it before a controller user-auth stack writes state. Validate the first IdP requirement, existing pin and first-enable JWKS through the native provider, without provisioning, pinning or granting authority. Refuse missing or unreachable IdPs with a typed cause and remedy before maintenance or trust creation, and repeat authoritative checks during preparation.
- 5c85ef3: Wire user-mode chat sessions end to end below the command surface. The auth service admits a session per holder hash under the person's own `cli` grant, serves `/chat-session/open`, `/chat-session/bearer` and `/chat-session/retire`, re-checks the session, holder index and pinned grant before and after signing each bearer of at most 900 s, mints the plain agent leaf for a chat principal at connect, and sweeps, retires and compacts sessions. The auth provider implements the three optional chat methods and keeps each session on the route its open resolved; an open may name the IdP and exchange position the caller resolved, and the provider refuses any other. The CLI gains an internal user-mode session factory over a real endpoint.
- a263632: Add the `dm-reader` exchange view and the purpose-bound IdP proof it rides. An embedding can now read one user's own DMs with a credential that holds only that user's DM durable. The callout mints consumer info, next message and ack on the user's own `dm_` durable plus its connection inbox, and nothing else; core gains the matching `dm-reader` profile. The view is loopback-only and needs no ledger scope. It is exchanged only for a proof on the new `dmReaderAudience` IdP pin field, which must differ from `audience`, carrying `purpose: "dm-reader"` and the requested actor, the actor's current lifecycle and this space. The bearer and its broker connection expire no later than the proof.

  Breaking for embedders that put a `purpose` claim on ordinary IdP tokens: the ordinary verifier now refuses any token carrying `purpose`, at every door that takes a human proof.

- a9a78ec: Add a typed trusted-host `interactiveManagerSelection: "local-primary"` runtime option to `runAuthService` and `openAuthAuthorityPlane`. It selects the genuine local Manager up front for unpinned human Manager control and refuses an unavailable local Manager without remote substitution. Explicit selectors, managed and issued instance bindings, command scopes and the absent-option default stay unchanged. The policy affects all interactive Manager control, not only ps; it adds no CLI flag or automatic up/recovery wiring.
- 5c85ef3: Record managed-grant custody and serialize ledger reads, decisions and writes in one synchronous transaction. Bind conditional revocation to the lifecycle and custodian, preserve legacy row reads without adopting them, and define the lease-first optional retirement-only composition. Full recovery authority is not enabled.

### Patch Changes

- 5c85ef3: Report `cotal actor grant` and `cotal actor revoke` honestly when the actor row changes or disappears while the predecessor's lifecycle retires. When the auth service reports that the command retired the lifecycle, the command now ends `partial` (exit 4) with the retired lifecycle under `changed` and a remedy to re-read `cotal actor list`, instead of `unknown` (exit 3). When the service reports that the lifecycle never started or was already retired, or the row has no lifecycle, the command retired nothing, so the same race refuses with `CONFLICT`, as does a first grant that finds another grant landed while it waited for the ledger lock. A retirement answer without a readable result now ends `unknown` before anything is written, instead of letting the grant or revoke continue.
- 5c85ef3: Make the auth commands agree with each other and classify their refusals.

  - `cotal actor list`, `grant` and `revoke` now resolve their space and root as `cotal auth grants`, `grant` and `revoke` do. With no space to resolve they refuse with `TARGET_NOT_FOUND` instead of assuming `main`, and on a root without the space's user-auth ledger `actor list` refuses with `UNSUPPORTED` instead of reporting no rows.
  - Grant usage is checked before any space or authority is read, under both spellings. A grant or revoke missing `--sub` or `--owner`, or a grant missing an ACL flag without `--full`, refuses with `USAGE_INVALID` (exit 1) and names every missing input in one refusal, where `actor grant` used to end with exit 5 and `auth grant` named one input per run. `actor` also refuses a flag that does not belong to its verb, as `auth` does.
  - `cotal login` against a provider that cannot be reached or stops answering refuses with `DEPENDENCY_UNAVAILABLE` (exit 2) and a `--idp` remedy, instead of printing the raw transport error with exit 1. No session is cached.
  - `cotal doctor auth` reports every credential with no expiry claim as a finding, including an agent credential that `cotal auth mint` wrote without `--expires-in` or `--expires-at`, so that root no longer reads as having no findings. The mint default is unchanged.

- 19ce005: Refuse `cotal actor grant` and `cotal actor revoke` plainly when the predecessor's lifecycle retirement did not run. When the auth service is not running, refuses the connection, or answers that the retirement did not run, the command now refuses (exit 2) with `DEPENDENCY_UNAVAILABLE`, `PERMISSION_DENIED`, `CONFLICT` or `UNSUPPORTED`, says the actor row was not changed, and names the recovery, usually `cotal up`. It used to report every such failure as `unknown` (exit 3). The auth service's `/interactive-lifecycle/retire` door now answers every refusal it makes before the retirement barrier, its token checks and authority head read included, with `outcome: "not-executed"`. A retirement request that may have reached the barrier, such as a timeout or an error answered without that outcome, stays `unknown`, now with its own reason.
- 5c85ef3: Refuse an interactive grant that found no row when another grant for the same actor lands while it waits for the ledger lock, instead of overwriting it.
- 0e40d19: Files written in place under `~/.cotal` or a project's `.cotal` are no longer written through a symlink. The manager's own delivery-aware marker, the `agent-bearer` health file, the onboarding marker, the `setup` log and personas, the web session file and detached log, the feedback store, persona files saved by `saveAgentFile`, the seat custody record, payload, exit record and log, the Claude seat home and plugin marketplace, the Codex host log, the Jcode launch record, the `ext` extensions prefix `package.json`, and the isolated broker's config rewrite and watchdog now refuse a symlink and leave it unchanged. A file rewritten in place is set to `0600` through the open file. `hardenPrivate` on a file now uses the same no-follow descriptor. A directory is still hardened to `0700` by its path, so a symlinked `~/.cotal` or `.cotal` is not refused there. The manager and native service custody no longer chmod their pid records by path, since those are created `0600`. The broker ports report refusal names the report's path, and a failed close no longer hides it.
- 5d5a2ab: Make usage errors and prompts behave as documented. Every CLI question, including the typed-name confirmation of `space delete`, the `--plain` removal questions of `channel remove` and `persona remove`, and the `manager` and `login` questions, now treats Ctrl-D on an empty line or a closed input as the cancel Ctrl-C gives, instead of hanging or exiting 13 with Node's unsettled-await warning. `up` refuses an invalid `--max-sessions`, `--max-file-store` or `--restore-only` value, and a restore flag combination it cannot run, as a usage error before anything runs instead of an unconfirmed outcome. `--json`, `-j` and `--plain` may come before the command word, and a leading `--` ends the leading flags. A command that takes its words raw refuses them there. A usage refusal from a command's own checks, from `clean` and from `help` with an unknown subcommand prints the error, its remedy and the command's help, like the parser's own usage errors. `space delete` names a prepared space that is not running and how to start or forget it, its dry run exits 0 when it reads its whole scope, `space forget` no longer calls a stopped space never started, and the `-y` help reads correctly for delete.
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [d079080]
- Updated dependencies [5c85ef3]
- Updated dependencies [3deea9d]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [0e40d19]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5d5a2ab]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [ef78ab0]
- Updated dependencies [a263632]
- Updated dependencies [5c85ef3]
- Updated dependencies [28ae779]
- Updated dependencies [bb14d28]
- Updated dependencies [15c96da]
- Updated dependencies [964aaea]
- Updated dependencies [c550cf3]
- Updated dependencies [1eacf50]
- Updated dependencies [5c85ef3]
  - @cotal-ai/core@0.91.0
  - @cotal-ai/workspace@0.91.0
  - @cotal-ai/lang@0.91.0

## 0.90.1

### Patch Changes

- 2087c68: Stop counting unpinned manager-caller selection refusals against the public face's refused-exchange budget. When an owner has several live remote managers, or none, the exchange is refused only after its credential verified, so it is not probing. A session that no manager launched carries no manager pin and polls turn-pending this way every 15 seconds, so a host with eight or more such sessions used to keep its shared bucket full, and every other refusal from that host answered 429 instead of its reason. These refusals now always carry their own reason and leave the budget untouched.
  - @cotal-ai/core@0.90.1
  - @cotal-ai/workspace@0.90.1
  - @cotal-ai/lang@0.90.1

## 0.90.0

### Minor Changes

- 88ab21e: Refuse ordinary lifecycle mutation and connect paths for immutable service UID custody, including stamped-root retries and activation recovery. Preserve ordinary reservation records and keep service issuance, cancellation and retirement unavailable until their separate authority prerequisites are implemented.
- 7b94728: Add host-only fresh revocation custody and sealed finite leader snapshots for private tool-result prerequisites. Existing stores and lost custody refuse. Runtime clock qualification remains explicitly unavailable, so this does not enable result serving or material issuance.
- b928aaa: Add immutable local scoped-Describe receive context and complete-envelope fingerprints, plus an explicit bounded read-only service Describe client contract. Define closed service-authority contracts, provider HTTP client hooks, host control types, registration-bound access and renewal primitives, native service gate approval guards and credential-root access checks, native caller-policy storage, create-only application-service name bindings and caller-capability policy checks. Add focused transport and structural checks and document the read-only serving-grant reader. Native service registration remains unavailable until host lifecycle support is implemented.

  Keep create-only native authority writes closed over deleted key history, including concurrent caller-policy creation and pending service gates.

  Bind service serving-issuance evidence to broker connection coordinates and verify it after the native gate CAS.

  Add a host-only service-callout mint seam with principal attribution, a separate client inbox nonce and an original fixed expiry.

  Bind native service issuance receipts to the registered witness and epcred connection, and retain expired evidence until qualified retirement.

  Compose an optional sealed native service callout with current root authorization, registered serving grants, connection-bound receipts and fixed-expiry encrypted responses. Production registration and lifecycle wiring remain unavailable.

### Patch Changes

- a793730: Add a package-internal dormant writer for native service custody bootstrap and endpoint-first cancellation. Nothing in the product calls it and it is not exported. It shares closed record shapes with the unchanged active-root reader, acts only under a genuine plane-claim hold re-read before and after each write, and bounds every request by the caller's original deadline. Bootstrap requests after the plan step are also bounded by the root plan's expiry, while cancellation keeps only its own deadline. Bootstrap holds instead of reporting an active root whose expiry its final check observes. It grants no approval, serving, terminal retirement, alias release or rotation.
- 7657577: Refuse a native service endpoint gate as a session serving gate. The auth session redemption hooks now reject a service-family gate before they return a serving pin or stage any caller or serving ledger row, including a restage whose saved pin was taken while the gate was ordinary.
- Updated dependencies [88ab21e]
- Updated dependencies [b928aaa]
  - @cotal-ai/core@0.90.0
  - @cotal-ai/workspace@0.90.0
  - @cotal-ai/lang@0.90.0

## 0.89.0

### Minor Changes

- dc458a4: Add a host-only, short-lived account census credential and a bounded pinned-server connection reader. The credential grants only one account's CONNZ request and account-qualified replies. Incomplete observations remain unknown; the reader does not grant eviction or prove terminal retirement.

### Patch Changes

- 15bc2d7: Bound an exchanged bearer by its IdP proof's expiry at signing time. The exchange now carries the proof's absolute `exp`, and a `session-caller` session's `exp`, through the credential hook to the issuer, which signs the earlier of `now + ttl` and that ceiling and refuses once it has passed. A slow `mintConnectCredential` hook could previously push the bearer, and the NATS user JWT the callout mints from it, past the proof's expiry, or mint a bearer after the proof had expired.
- Updated dependencies [dc458a4]
- Updated dependencies [bab4ca8]
- Updated dependencies [2905ae9]
  - @cotal-ai/core@0.89.0
  - @cotal-ai/workspace@0.89.0
  - @cotal-ai/lang@0.89.0

## 0.88.0

### Minor Changes

- f2d461b: Add opt-in host-custodied tool-result consent signing and a closed capability-gated admission door. Verify fresh same-owner password proof and current holder and target lifecycles, then record each signed consent id create-only before release. Unknown persistence outcomes return no consent and never retry automatically. Only the auth mint writer receives consent persistence authority. Private result serving remains unavailable.

### Patch Changes

- Updated dependencies [fc923a5]
- Updated dependencies [cb09213]
- Updated dependencies [a3ae00f]
  - @cotal-ai/workspace@0.88.0
  - @cotal-ai/core@0.88.0
  - @cotal-ai/lang@0.88.0

## 0.87.0

### Minor Changes

- c06cf5b: History reads on observer and admin credentials no longer leave consumers behind. `channelHistory`, `multiChannelHistory` and `dmHistory` used to read through nats.js ordered consumers that these profiles could not delete, so each read left two or three consumers for five minutes. A dashboard polling history filled the stream's consumer limit, and every later read failed with "maximum consumers limit reached". The reads now use the connection's own reader names, `hist_<readerId>_<n>` with `n` in `0..7`, and delete each reader when its step ends. A static credential's `readerId` is its nkey. Under the auth callout it is the server's id and the client id the server assigned the connection, so a client cannot claim another connection's readers by choosing its inbox nonce. A connection runs at most eight history reads at once per stream, and a read past that waits for a free name. A consumer found under one of the names is never deleted, and a create that returns an existing consumer is never read through; the read moves to a free name.

  The observer profile gains `$JS.API.CONSUMER.DELETE.<CHAT>.hist_<readerId>_<n>` for those eight names, and admin also gains them on `<DM>`. Each row names one consumer of this connection and no other. Breaking: a static observer or admin credential minted before this release has no such row, and a current client's history read on it fails and says to remint it. Remint those files, and upgrade the auth service before or with the hosts that read history on a user-auth mesh. The auth callout's `permissionsFor` hook now receives the connection's reader id as a third argument, and the function `calloutPermissions` returns requires it.

- e84b6c6: The auth service serves `POST /manager-instances` on both faces: the signed-in human's own Manager instances, read-only. It verifies the same IdP proof the human exchange verifies, derives the owner the same way, and answers `{ v: 1, owner, complete: true, instances }`, each instance with its placement and the verdict selection reads (`candidate`, `not open`, `not registered`, `not this owner's`, `unknown`). Selection is now built on the same list, and the plane `openAuthAuthorityPlane` returns gains `listManagerInstances`. A listed candidate is registration evidence, not proof that the instance answers. Browser-origin requests are refused as on every exchange route, and a failed gate read answers 503, never an empty list.
- 8d513aa: Add a consent-only verifier for pinned signed password authentication within five minutes and a host-only proof decision door. Retain validated authentication provenance without changing ordinary bearer exchange. Private tool-result consent, issuance and serving remain unavailable.

### Patch Changes

- Updated dependencies [e84b6c6]
- Updated dependencies [c06cf5b]
- Updated dependencies [af82e8d]
- Updated dependencies [0f92fa4]
- Updated dependencies [5d686ff]
- Updated dependencies [970bf2d]
- Updated dependencies [9755079]
- Updated dependencies [70aa27b]
- Updated dependencies [e6bb48f]
  - @cotal-ai/core@0.87.0
  - @cotal-ai/workspace@0.87.0
  - @cotal-ai/lang@0.87.0

## 0.86.0

### Minor Changes

- be2c0d8: Every auth-callout success now records its broker-generated user key before the minted JWT leaves. `startAuthCallout` takes a required `recordIssuance`, and refuses to start without one. The authority plane's recorder writes one create-only `natkey.<userNkey>` row in the space's auth bucket with the bearer's own space, owner, actor, lifecycle, credential and view and the minted JWT's `iat`/`exp`, then re-checks the connect authority before the response. A failed write, an existing row for the key, or a revocation seen by that re-check is a signed deny. The plane removes rows only after their `exp` plus the clock tolerance, at boot and on a timer (`nativeIssuancePruneMs`, default 60 s), with the bucket's marker TTL on each purge marker; a corrupt row fails the open or fences the plane. Core adds `nativeIssuanceKey`. Connections admitted before this change, and static JWTs, have no row.

### Patch Changes

- f1c80e4: `cotal agent-bearer --manager-call` is now told to name a manager with `--manager-instance <instanceId>` when an owner has more than one live manager. Before, it was told to use the instance argument, which only an agent's tools take. The exchange names `--manager-instance` for every actor-token caller, because `cotal agent-bearer` is that arm's one client, and the connector renames it to the `instance` argument when it runs the command for a tool. The refusal still refuses and still lists the owner's live manager instance ids.
- 9f12f90: The first IdP pin is now written by exclusive create. Two processes enabling user auth on one state dir at once used to both succeed, each holding its own IdP while `idp.json` named only the last writer. Now one pin wins: the other caller adopts it when it names the same IdP and is refused with the usual re-key message when it does not.
- b62ddda: When every remote manager an owner registered has exited, the manager-caller refusal now tells the owner to start one with `cotal supervise`. It used to suggest naming an instance with `managerInstanceId`, which cannot revive a dead manager. The call is still refused and is never routed to the local manager.
- 720a01d: The auth service now records a manager-caller connection's credential expiry in the issued evidence it writes for that connection's generation. After the credential expires, the generation no longer resolves and is refused with `generation <id> expired at <exp> (SPEC 13.15)`. A run admitted while the generation was live keeps its admission and keeps renewing.
- 56fbdb4: A manager-authority answer whose body is not JSON now fails the request with an error that names the operation, the endpoint and the HTTP status. Before, the client replaced such a body with an empty object, so a 200 answer resolved as an empty result the endpoint never sent, and a refusal read the same as a refusal with an empty JSON body.
- 8d97d8a: Callers can name a manager instance wherever a user-auth mesh with several live managers for one owner asks them to. `cotal models` and every hosted `cotal run` verb take `--on <instance>`, and MCP `cotal_run` and `cotal_personas` take an `instance` argument under the same rules as `cotal_spawn`'s. A `cotal` command run from a managed seat's shell now selects the manager that launched the seat (`COTAL_MANAGER_INSTANCE`), as the seat's tools already did, unless `--on` names another. The ambiguity refusal still refuses, and now lists the owner's live manager instance ids and names the caller's own remedy: `--on <instanceId>` for the CLI, the `instance` argument for an agent's tools. Before, it named `--manager-instance`, which only `cotal agent-bearer` takes, so none of these callers could answer it.
- Updated dependencies [598d0dd]
- Updated dependencies [be2c0d8]
- Updated dependencies [140c0d4]
- Updated dependencies [1d92ef7]
- Updated dependencies [91663dc]
- Updated dependencies [31dccc4]
- Updated dependencies [15043fa]
- Updated dependencies [1dd5baf]
- Updated dependencies [1fd3cb4]
- Updated dependencies [fba88b0]
- Updated dependencies [b7f4af7]
- Updated dependencies [7a2c574]
- Updated dependencies [add70b8]
- Updated dependencies [e754d4f]
- Updated dependencies [664e9df]
- Updated dependencies [8d97d8a]
- Updated dependencies [830d66b]
- Updated dependencies [516c8f6]
- Updated dependencies [00f631a]
- Updated dependencies [ab30526]
- Updated dependencies [df063ef]
- Updated dependencies [958e6cb]
- Updated dependencies [ee42687]
- Updated dependencies [d4a745f]
- Updated dependencies [3c0a830]
- Updated dependencies [4f49cea]
- Updated dependencies [6d5462d]
- Updated dependencies [c2e7648]
- Updated dependencies [12344fb]
- Updated dependencies [1eaf6e3]
- Updated dependencies [3b93aa2]
  - @cotal-ai/core@0.86.0
  - @cotal-ai/workspace@0.86.0
  - @cotal-ai/lang@0.86.0

## 0.85.0

### Patch Changes

- Updated dependencies [6e10d50]
- Updated dependencies [ff09b5c]
- Updated dependencies [7840cea]
- Updated dependencies [d5e7a87]
  - @cotal-ai/core@0.85.0
  - @cotal-ai/workspace@0.85.0
  - @cotal-ai/lang@0.85.0

## 0.84.0

### Patch Changes

- Updated dependencies [6d48a0b]
- Updated dependencies [b4c8812]
- Updated dependencies [9229264]
  - @cotal-ai/core@0.84.0
  - @cotal-ai/workspace@0.84.0
  - @cotal-ai/lang@0.84.0

## 0.83.0

### Patch Changes

- d663fa4: Allocate a fresh numbered actor for implicit foreground user-auth launches without replacing an existing session or grant. Preserve explicit names, enrollments and managed handoffs, and retry only typed name collisions. Refuse backward connector-store migration even with force or reset, remove unsafe downgrade advice, and make the shell installer identify PATH shadowing and use its absolute installed launcher in next steps.
- Updated dependencies [d663fa4]
  - @cotal-ai/core@0.83.0
  - @cotal-ai/workspace@0.83.0
  - @cotal-ai/lang@0.83.0

## 0.82.2

### Patch Changes

- @cotal-ai/core@0.82.2
- @cotal-ai/workspace@0.82.2
- @cotal-ai/lang@0.82.2

## 0.82.1

### Patch Changes

- Updated dependencies [9061234]
- Updated dependencies [423d250]
- Updated dependencies [b526a5e]
  - @cotal-ai/workspace@0.82.1
  - @cotal-ai/core@0.82.1
  - @cotal-ai/lang@0.82.1

## 0.82.0

### Patch Changes

- 4f52881: Accept canonical space names in workflow admission records, including underscores, while preserving the separate endpoint-name grammar and rejecting malformed spaces.
- fa8f7da: `cotal up --user-auth --idp <url>` on a space that already pins an IdP now compares the normalized URL with the pin. Re-running the command that created the pin with a trailing slash was refused as a re-pointed IdP that "would re-key every derived owner", although both spellings name the same IdP. A malformed later value now gets the same URL refusal as a first enable, and a different IdP is still refused.
- 8fd9427: The manager-service authority request now refuses a redirect, as the other manager-authority requests already did. Before this, a 307 or 308 from the pinned endpoint re-sent the login proof to the address it named and returned that host's answer as the manager's authority material. All remote manager-authority requests now go through one endpoint lookup and one request path, so the redirect refusal and the refusal messages are the same for each of them.
- Updated dependencies [4f52881]
- Updated dependencies [6afa12f]
- Updated dependencies [7c6c109]
- Updated dependencies [9a93a58]
  - @cotal-ai/core@0.82.0
  - @cotal-ai/workspace@0.82.0
  - @cotal-ai/lang@0.82.0

## 0.81.1

### Patch Changes

- @cotal-ai/core@0.81.1
- @cotal-ai/workspace@0.81.1
- @cotal-ai/lang@0.81.1

## 0.81.0

### Patch Changes

- 8f7bd97: `cotal actor revoke` now reads the delivery daemon's eviction reply through the same check the lifecycle barriers use. It prints `verified gone` only when the reply names the revoked principal, has well-formed counts, and reports a complete scan with no connection left. A reply for another principal, or one that claims `verifiedGone` with an incomplete scan or surviving connections, used to print `live connections closed now (1 kicked, verified gone)`; it now prints the `INCOMPLETE` line with the reason the reply was refused.
- Updated dependencies [c166107]
  - @cotal-ai/core@0.81.0
  - @cotal-ai/workspace@0.81.0
  - @cotal-ai/lang@0.81.0

## 0.80.0

### Patch Changes

- fe13981: Add an internal host-private environment-manager admission index with first-wins coordinate selection and broker-enforced write-once bindings. Require native message-deletion and purge protection, and refuse republishing of private metadata. This does not verify provider confirmation, expose an admission API or issue bootstrap credentials.
- a64403e: Add an internal one-shot environment bootstrap issuer that binds its fixed-profile JWT to the native credential ledger and both lifecycle and registration fences. Repeated or uncertain signing attempts remain held. This does not expose an admission API, deliver bootstrap files or enable hosted execution.
- 06bd47c: Refuse environment-manager gates on existing manager authority paths, and reserve the ordinary native gate before releasing direct-store preparation credentials. This does not implement environment admission or stock hosted execution.
- e00402f: Add fixed environment-manager guest permission builders and a retained endpoint-gate family marker. These primitives do not yet implement host admission, stock manager bootstrap or hosted agent execution.
- d4f711a: Preserve the initial native manager-gate revision so an aborted environment registration cannot be restored by a same-input reservation replay.
- 6488bc7: Add internal environment-manager registration reservation groundwork with native lifecycle activation, immutable operation staging and family-bound gate freezing. This does not expose an admission API or issue bootstrap credentials.
- Updated dependencies [5417401]
- Updated dependencies [71e6311]
- Updated dependencies [3614fdd]
- Updated dependencies [e00402f]
- Updated dependencies [80f66fd]
- Updated dependencies [0835254]
  - @cotal-ai/core@0.80.0
  - @cotal-ai/workspace@0.80.0
  - @cotal-ai/lang@0.80.0

## 0.79.0

### Patch Changes

- d242385: The auth service now builds its data account's signing context in one place. The authority plane's own mints, the remote manager credentials it issues and the delivery-admin endpoint all sign through it, where before the delivery-admin endpoint and the manager-service issue path each spelled their own copy. Credentials are unchanged.
- 7e72329: The run attempt and run revoke parsers now parse their own registered-manager envelope. They used to rewrite the request into a run admission with a placeholder `run` and hand it to the admission parser. A `manager-run-attempt` that carries a `run` field is now refused as an unknown field, where it was accepted and the field dropped. Attempt and revoke refusals name their own kind and carry the `manager run attempt request` or `manager run revoke request` prefix. The manager-service authority parser also refuses a `session` request whose `session` carries a key other than `id`, `endpoint`, `sessionId`, `epoch` and `exp`, and returns a session built from the checked fields, where it returned the caller's own object.
- fbc3e2d: Whether a consumer info or delete found no consumer is now decided by one predicate, `isConsumerNotFound` in `@cotal-ai/core`, which accepts only the broker's structured `ConsumerNotFound` error. It no longer accepts a bare `name` of `ConsumerNotFoundError` or a string `code`, so the run journal's replay cleanup no longer swallows those shapes. The stream, KV scan, run wait, delivery `pending` and auth scanner sites use it in place of their own copies, and `isJetStreamMissing`, the structured check it builds on, is exported beside it.
- Updated dependencies [50747b1]
- Updated dependencies [fbc3e2d]
- Updated dependencies [c535d98]
- Updated dependencies [36b03b0]
- Updated dependencies [2bd492c]
- Updated dependencies [5e9a618]
- Updated dependencies [7cb89f9]
- Updated dependencies [aaa6bc9]
- Updated dependencies [db962ae]
- Updated dependencies [4aafb0d]
- Updated dependencies [92590e8]
- Updated dependencies [c03f2af]
- Updated dependencies [79ace0f]
  - @cotal-ai/workspace@0.79.0
  - @cotal-ai/core@0.79.0
  - @cotal-ai/lang@0.79.0

## 0.78.1

### Patch Changes

- aa8c947: The auth plane now derives the remote manager's serve surface from the cluster document core parsed, instead of re-checking the raw document with its own field checks. Activation parses the submitted `ai.cotal.manager` document with core's parser, and standing renewal and run attempts use the document core verified at registration. A manager cluster that declares a journal-class command, which core admits and registers, is now refused with `EpEnvelopeError` `failed-precondition` naming the command. Before, it was refused with a plain `Error` and no code, as was an activation request that submits no manager cluster document, which is now refused `bad-request`. The stock manager cluster is all ephemeral, so stock activation, renewal and runs are unchanged.
  - @cotal-ai/core@0.78.1
  - @cotal-ai/workspace@0.78.1
  - @cotal-ai/lang@0.78.1

## 0.78.0

### Minor Changes

- c4cd8dc: `POST /manager-service-authority` now applies the exchange face's refusal budgets, as `POST /exchange` does. A missing or wrong loopback capability counts in the invalid-capability window, and a refused IdP token or request counts against the face's refused-exchange budget, per peer on the public face. After 30 refusals in a minute a further refusal answers 429, where the route used to answer 401 or 403 without limit. `ManagerServiceAuthorityCtx` now requires the `failures` and `badCaps` windows, so a host that builds it without them no longer compiles; see the upgrading guide.
- 70fb24e: `SecretStore` gains `create(key, value)`, a write that stores the value only while the key is absent and resolves whether it did. `FsSecretStore` implements it with an exclusive create. `ensureCalloutAuth`, `ensureIssuer`, `ensureOwnerSecret` and the hosted auth plane's instance identity now write their first value through it and adopt the stored value when another caller created it first. Before, two concurrent first calls on one space each minted a value, the later `put` replaced the earlier one, and the earlier caller kept a value the store no longer held: one IdP subject could derive two owners, a bearer could be signed by a key the stored issuer does not publish, and a prepared broker could preload a callout account the auth service never loads. A store of your own must now implement `create` as one atomic step; see the upgrade guide.

### Patch Changes

- af7fd7a: `handleManagerServiceAuthority` now answers a body over 64 KiB with 413 and a body that is not JSON with 400 itself, and answers a JSON `null` body with the same 400 as a body without `idpToken`. Before, those rejections escaped the returned promise, so a host that served the export behind its own `http.createServer` exited on such a request instead of answering it. The auth service's own listeners already answered 413 and 400.
- Updated dependencies [a7f39aa]
- Updated dependencies [981b567]
- Updated dependencies [8b92413]
- Updated dependencies [a74b832]
- Updated dependencies [d04629a]
- Updated dependencies [905a78b]
- Updated dependencies [8344353]
- Updated dependencies [f9a71ce]
- Updated dependencies [b9499b3]
- Updated dependencies [c2d8362]
- Updated dependencies [70fb24e]
- Updated dependencies [de3c0f7]
- Updated dependencies [a32e955]
- Updated dependencies [7d13389]
  - @cotal-ai/workspace@0.78.0
  - @cotal-ai/core@0.78.0
  - @cotal-ai/lang@0.78.0

## 0.77.1

### Patch Changes

- @cotal-ai/core@0.77.1
- @cotal-ai/workspace@0.77.1
- @cotal-ai/lang@0.77.1

## 0.77.0

### Minor Changes

- 6979e05: `validateUserToken` and the `IdpConfig` of `verifyIdpToken` and `createIdpBridge` no longer take `clockToleranceSec`. Both verifiers allow a fixed 5 seconds of clock skew, the default they already applied. Nothing in the repository passed the option, and a `NaN` value, such as `Number()` of an unset environment variable, turned off the expiry, not-before and issued-at checks so an expired or post-dated token was accepted, while a large value widened them by that many seconds.

### Patch Changes

- Updated dependencies [6861390]
- Updated dependencies [7d1b600]
  - @cotal-ai/core@0.77.0
  - @cotal-ai/workspace@0.77.0
  - @cotal-ai/lang@0.77.0

## 0.76.0

### Minor Changes

- 19fac82: Remove `allowManagerAuthority` from the exchange policy that `handleManagerServiceAuthority` takes. Both exchange faces set it to `true`, so its refusal could never fire, and the route table alone decides which face serves `POST /manager-service-authority`. The docs and source comments now list that route on the public listener, which has always served it. A policy object literal that sets `allowManagerAuthority` no longer compiles, and a JavaScript caller that set it to `false` is no longer refused by the handler; see the upgrading guide.
- 15d10c9: Refuse competing patched same-host consuming sessions without replacing their logical inbox owner. Preserve live control listeners and existing foreground actor material. Make fresh local foreground grants and departure cleanup generation-aware. This containment does not fence other hosts, broker URL aliases or older clients.
- 31b22ae: Issue managed seats' manager-caller run authority when their current persona scope and fresh same-owner parent grant both carry run. Preserve the signed permission ceiling, actor-row lifecycle source, interactive issuance and ordinary legacy commands.
- 3d0a5f9: Add an owner-bound platform supervisor authority door to the hosted auth service. It reuses native manager registration and renewal, checks a current administrative assignment, confines issuance to one owner and lifecycle, and records the registration credentials' signed permission ceilings before returning material. Recorded permissions match the authority-plane signed native set at issuance and every renewal without widening. `endPlatformSupervisorAssignment(owner)` ends an assignment the host recorded `ended`: it retires the manager gate and the issued generations, so registration, activation and renewal refuse previously returned material by name before it expires.

### Patch Changes

- 97f953f: `cotal actor revoke` now mints its live-connection eviction credential with a 60 second lifetime instead of the supervisor profile's 24 hour default. The revoke-time eviction, the barrier evictors and the liveness oracles that call the delivery daemon's `ctl.delivery-admin` rail now share one connection helper, so the lifetime and the non-participating endpoint options are decided in one place.
- b8a41c5: The auth-ledger and records scanners now run every sealed scan through one shared plane-guard helper, `guardedScan`, beside `ScanGuard`. It used to be written out three times: once in the ledger scanner and once in each of the records scanner's obligation and manager goal-index scans. A change to the before-and-after claim check is now made in one place. No behavior changes.
- a5c18a0: A `renewRunDriver` renewal now checks the run it renews through one `holdsRunFence` predicate in `@cotal-ai/auth`, read through one run observer in the auth service. The renewal decision and the re-check right before issuance each kept a hand-written copy of the read and of the run fence comparison, so a change to what makes a run renewable could reach one copy and leave the other weaker or stricter without any suite noticing. Both still refuse with their own `conflict` message.
- 5f17642: The hosted auth fence smoke takes its injected-store baseline after each plane's first start, which now puts the plane's instance identity into the store, so its store cells check that the fence and close write nothing on top of that record.
- 0eb8eff: `@cotal-ai/core` exports `REMOTE_MANAGER_AUTHORITY_OPERATIONS`, the frozen list of manager-service authority operations, and `RemoteManagerAuthorityRequest["operation"]` is derived from it. The auth request parser checks the operation against the same list and builds its refusal from it, so an operation added to core is admitted by the host instead of compiling cleanly and being refused at runtime with the old list. The refusal now reads `operation must be one of prepare, activate, renew, session, retire, renewStandingBundle, renewRunDriver, transferReader`.
- Updated dependencies [58a725f]
- Updated dependencies [7829cbb]
- Updated dependencies [8e0876b]
- Updated dependencies [d85ca1a]
- Updated dependencies [20c93a1]
- Updated dependencies [715928c]
- Updated dependencies [a4b0467]
- Updated dependencies [08d92b7]
- Updated dependencies [35fdda8]
- Updated dependencies [7b34e9a]
- Updated dependencies [d153172]
- Updated dependencies [ea15e8d]
- Updated dependencies [9adcf1c]
- Updated dependencies [15d10c9]
- Updated dependencies [0eb8eff]
- Updated dependencies [ba76f78]
- Updated dependencies [f2a4bde]
- Updated dependencies [8be669e]
- Updated dependencies [42b28aa]
- Updated dependencies [720dbc3]
  - @cotal-ai/core@0.76.0
  - @cotal-ai/workspace@0.76.0
  - @cotal-ai/lang@0.76.0

## 0.75.0

### Minor Changes

- b48a740: Add the closed manager-run-revoke issuing-host request, authorized by the recorded admission owner or a fresh admin grant. Route signerless RunHosting revocation through it and return the existing create-only marker on repeats.

### Patch Changes

- ed0785d: `@cotal-ai/core` exports `isAccountNkey`, the shape rule for an account nkey public key, and every site in core, `@cotal-ai/auth` and `@cotal-ai/delivery` that checks an account public key calls it. The run admission and run attempt parsers now refuse an `accountPublicKey` that is not an account nkey as a bad request. They accepted any non-empty string before, which only the later comparison with the assigned account refused.
- 0c924f4: A hosted auth context started through `startAuthService` now keeps the auth plane's instance identity, whose serve seed is a private nkey, in its injected `SecretStore` under the new `authInstanceKey(space)`, with the other auth secret kinds. It used to write that record under `stateDir`, which the hosted contract documents as non-secret state. The first start of an upgraded context puts the earlier record into the store, removes the file and keeps the instance. A store and `stateDir` that hold different identities refuse the start. `@cotal-ai/workspace` exports `removeAuthInstanceIdentity`. A CLI root keeps its record where it was.
- cb3a177: The manager-service authority and maintenance request parsers now check the registered-manager envelope through core's `parseRemoteManagerEnvelope` instead of their own copies of its rules, so a change to a shared envelope rule reaches them too. `parseRemoteManagerEnvelope` takes an optional fourth argument, `registrationProof`; pass `false` for a request that must carry no proof, such as `prepare`. Some refusal wording changes with it: a lifecycle-token refusal names `manager-service authority` or `manager-service maintenance`, a missing or malformed proof on any registered-manager request reads `requires a sha256 registrationProof` without the operation, and a proof on `prepare` reads `must not carry registrationProof`.
- d269d1d: Core exports `serviceContractTable(rows)`, which builds a service's command contracts, compiled on first access, and the schema artifacts its registration publishes. The auth, manager and Linear service contracts call it instead of carrying their own copies of the lazy table and the artifact loop, so a fix to either reaches all three. Importing a contract module still compiles nothing, and the published artifacts and the behaviour of `AUTH_CONTRACTS`, `MANAGER_CONTRACTS` and `MANAGER_STATUS_CONTRACT` are unchanged.
- Updated dependencies [6286d29]
- Updated dependencies [ed0785d]
- Updated dependencies [625659e]
- Updated dependencies [0c924f4]
- Updated dependencies [b48a740]
- Updated dependencies [597fa25]
- Updated dependencies [cb3a177]
- Updated dependencies [5f5196f]
- Updated dependencies [d269d1d]
  - @cotal-ai/core@0.75.0
  - @cotal-ai/workspace@0.75.0
  - @cotal-ai/lang@0.75.0

## 0.74.0

### Patch Changes

- Updated dependencies [f3e6f95]
- Updated dependencies [328d59b]
- Updated dependencies [ac251fd]
- Updated dependencies [e3498d9]
  - @cotal-ai/core@0.74.0
  - @cotal-ai/workspace@0.74.0
  - @cotal-ai/lang@0.74.0

## 0.73.0

### Minor Changes

- 8182b64: The IdP URL, the pinned JWKS URL, the space-catalog link and `cotal sync`'s account binding now share one plain-http rule: `https://`, or `http://` on a loopback IP literal, decided by core's `isLoopbackLiteral`. Before, each spelled its own host list, so `cotal login --idp http://127.0.0.2/api/auth` and `http://[::ffff:127.0.0.1]/api/auth` were refused, `http://localhost/api/auth` signed in but dropped its same-origin catalog link, and the JWKS pin accepted any scheme on `127.0.0.1` or `localhost`, such as `ftp:` or `ws:`. Every loopback literal now passes and `localhost` is refused everywhere, because a hosts entry would choose the IdP and the keys the callout trusts. A mesh with an IdP pinned on `localhost` must move its pin to `127.0.0.1`; see the upgrading guide.

### Patch Changes

- Updated dependencies [9873985]
  - @cotal-ai/core@0.73.0
  - @cotal-ai/workspace@0.73.0
  - @cotal-ai/lang@0.73.0

## 0.72.1

### Patch Changes

- Updated dependencies [07fe6b3]
  - @cotal-ai/core@0.72.1
  - @cotal-ai/workspace@0.72.1
  - @cotal-ai/lang@0.72.1

## 0.72.0

### Minor Changes

- c5a45ab: Expose the auth context's owned connection inventory and terminal `closed` signal (#3054). Underlying connection close failures now reject with their labels instead of being suppressed. Add a read-only, space-bound `readPlaneClaim` export (#3270) and an account-scoped `observeAccountLivenessWithCreds` observer over the existing native CONNZ sweep.

  UPGRADING (`@cotal-ai/auth`): After `close()` or `drain()`, await `handle.closed` to prove all owned connections ended. `handle.connections()` returns a detached snapshot, including replaced readiness readers and short-lived clients. A close failure leaves the end signal pending while a connection remains live. Repair the failure and retry `close()` before awaiting the terminal signal. Read another process's claim with `readPlaneClaim(kv, space)` using that account's leader-only auth bucket. An unclaimed space returns `undefined`. Deleted or malformed claim rows refuse, and the package now exports `PlaneClaimRow` and `PLANE_CLAIM_KEY`.

  UPGRADING (`@cotal-ai/core`): Use `observeAccountLivenessWithCreds({ servers, observerCreds, accountId, options })` with the same account-scoped membership-observer credentials used by the tuple query. It returns connection labels, server ids, cids, identities and the sweep's `gotAnyReply`, `truncated`, `sweepComplete` and topology facts. Zero rows prove absence only with a complete sweep and the single-server proof. Credentials are never widened and the observer performs no eviction. Trusted endpoint composition roots may use `EndpointOptions.onConnection` to retain custody of each opened transport and await its terminal signal.

### Patch Changes

- 7aa94be: A broker error on the auth service's connect reader connection no longer denies every connect. The reader treated any async error, such as one refused publish or subscribe, as a lost connection: it stopped serving and only came back on a reconnect, which a connection that never dropped does not get, so every connect was denied with `unavailable` until the link dropped or the service restarted. The reader now goes down only when the connection is lost, and an auth error that makes the client drop the link still denies until the reconnect re-proves the reader. The service log names the broker error instead of reporting a lost connection.
- Updated dependencies [c5a45ab]
- Updated dependencies [18e7e91]
  - @cotal-ai/core@0.72.0
  - @cotal-ai/workspace@0.72.0
  - @cotal-ai/lang@0.72.0

## 0.71.0

### Patch Changes

- 976fe67: A failed auth plane open now closes every connection it opened and releases its plane claim, wherever the open fails. A JetStream timeout or error on the remote manager issuer's first request, after the auth admin listener came up, used to leave the authority connections, both scanners and the listener open with the claim still held, so a hosted retry on the same space was refused by the leaked claim. The open now records each resource's close as soon as it opens and unwinds them in reverse from one place.
- Updated dependencies [b9daf53]
- Updated dependencies [3518435]
- Updated dependencies [726a750]
- Updated dependencies [3400d53]
- Updated dependencies [518351a]
  - @cotal-ai/core@0.71.0
  - @cotal-ai/lang@0.71.0
  - @cotal-ai/workspace@0.71.0

## 0.70.2

### Patch Changes

- d873500: Plane-claim release no longer caches a rejected KV operation. A hosted `close()` that cannot reach the claim row still rejects, but it can be retried after the broker reconnects without reopening the scanners. The exported `planeClaimRefusal()` reports `release-unreachable` for this retryable refusal and `lost` when another claim owns the row; a release also accepts its own already-released row after an uncertain write acknowledgment.
  - @cotal-ai/core@0.70.2
  - @cotal-ai/workspace@0.70.2
  - @cotal-ai/lang@0.70.2

## 0.70.1

### Patch Changes

- cd3c155: The doc comment on `reconstructRemoteManagerServeGrant`, which ships in `dist/manager-contract.d.ts`, now says what the function does: it is the activation entry and derives the serve grant from the submitted `ai.cotal.manager` document through `remoteManagerServeGrantFromCluster`. It described a canonical manager surface mirrored from the manager package that activation was checked against, and the module holds no such value. No runtime change.
- 0a21b56: The `renew` arm of the manager-service authority now checks the manager gate's owner against the same actor set it mints the supervisor and executor credentials from. It recomputed its own copy before, which only matched because both copies were derived from the same instance id. No behavior changes.
- Updated dependencies [9c99ee5]
- Updated dependencies [da6dba0]
- Updated dependencies [032522a]
- Updated dependencies [5c6c92d]
- Updated dependencies [6d81d61]
- Updated dependencies [fe54eb0]
- Updated dependencies [1ef1396]
- Updated dependencies [66a0f19]
- Updated dependencies [2be1384]
- Updated dependencies [25237f0]
- Updated dependencies [6bd6099]
- Updated dependencies [ed1e171]
  - @cotal-ai/core@0.70.1
  - @cotal-ai/lang@0.70.1
  - @cotal-ai/workspace@0.70.1

## 0.70.0

### Minor Changes

- 392bfeb: The user-auth service's instance identity no longer travels with a mesh's trust folder. It now lives in the root's own space segment, `.cotal/space.<space-hex>/auth-instance.json`, beside the manager's identity. It used to land in `.cotal/auth/space.<space-hex>/.cotal/auth/auth-instance.<space-hex>.json`, because the auth plane passed its user-auth state dir where the identity helpers expected a workspace root, so copying `.cotal/auth` to another root, as the docs describe for a mesh you did not start, copied it too and an auth service started there came up as the original instance. A record at the older place is moved on the first start and the instance is kept; both places holding a record is refused, and so is a symlink or other non-regular entry at the older place of the auth or manager identity, which the manager used to skip, minting a new identity. A hosted context started through `startAuthService` keeps its identity in its own `stateDir`, moved the same way from `<stateDir>/.cotal/auth/` to `<stateDir>/.cotal/space.<space-hex>/`. `openAuthAuthorityPlane` now takes a required `identityRoot`, the root whose space segment keeps that identity, and no longer derives it from `dir`.
- b543926: `validateUserToken` no longer takes `maxTtlSec`. It caps a bearer's lifetime at the cap of the bearer's view, the same cap the issuer applies at mint: 900 seconds, or 300 for a `transfer-writer` bearer. Nothing in the repository passed the option, and a `NaN` value, such as `Number()` of an unset environment variable, turned the lifetime check off so a bearer of any lifetime was accepted. A caller that needs a shorter-lived bearer mints one.
- fd07b1e: `remoteManagerClient.remoteManagerAuthorityRequest` takes an operation's coordinates as one named object instead of trailing positional arguments, and `remoteManagerRegistrationProof(owner, registration, contractArtifacts?)` computes the registration proof from the manager's identity coordinates instead of a request built with a placeholder proof. The proof digest and the wire request are unchanged.
- 2639a13: `AuthProvider.userCredentials` no longer returns `managerInstanceId`. A `manager-caller` credential's instance is the signed `act.managerInstanceId` claim in its bearer, the one `userViewAuth` checks. The reference provider copied the exchange response's field beside it, and nothing compared the two, so a provider whose result named a different instance than its bearer satisfied the contract while the CLI used the bearer's. `userViewAuth` also decodes each minted bearer once, through one typed decoder, where the manager-caller check read a second untyped decode.

### Patch Changes

- 2cbfe9c: `@cotal-ai/core` exports `isUserNkey`, the shape rule for a user nkey public key, and every parser in core and `@cotal-ai/auth` that checks a user nkey calls it. `mintPublicUserJwt` now refuses a non-string `publicId`, such as a boxed `String`, as every other site already did. Decisions for string ids do not change.
- b413e2a: `authorizeRemoteManagerRenewal` now takes its run observation as the exported `ObserveManagerRun`, built on core's new `HostedRunAttempt`, instead of an inline shape whose `state` was a plain `string`. `observeHostedRunAttempt` returns `HostedRunAttempt`, so its `state` is a `RunState`. A misspelled or unknown run state in an observation, or in a comparison against one, now fails the typecheck where it used to compile. Renewal accepts and refuses the same runs as before.
- 4dcfa0b: The run admission and run attempt requests from a registered manager now refuse a `requestId` outside the 22-64 character idempotency token grammar and an `actor` that is not an owner token, as the other registered-manager requests already did. The manager-service authority request also refuses such an `actor`. Core exports `parseRemoteManagerEnvelope`, the one parser for the fields every registered-manager request carries, and the auth parsers call it in place of their own copies.
- cce8dad: `@cotal-ai/core` exports `singleDocumentClosure(document)`, which returns the §13.7 closure manifest `{ v: 1, root, members: [] }` of one self-contained document and the manifest's closure digest. It builds the manifest with `buildContractClosureManifest`, so every closure manifest core mints follows one rule. The auth and manager service contracts and `VOID_SCHEMA_DIGEST` now build their closures with it instead of each writing the manifest by hand, and the platform host example in `docs/embedding.md` uses it. Every digest they produce is unchanged.
- Updated dependencies [392bfeb]
- Updated dependencies [66df6c0]
- Updated dependencies [0ec35c2]
- Updated dependencies [015f805]
- Updated dependencies [2cbfe9c]
- Updated dependencies [1b11c4e]
- Updated dependencies [c088c5c]
- Updated dependencies [b413e2a]
- Updated dependencies [7986785]
- Updated dependencies [12bfc34]
- Updated dependencies [4dcfa0b]
- Updated dependencies [fd07b1e]
- Updated dependencies [8dc360c]
- Updated dependencies [cce8dad]
- Updated dependencies [c7e0c0a]
- Updated dependencies [2639a13]
- Updated dependencies [668f6b0]
- Updated dependencies [83a6352]
- Updated dependencies [15b7920]
  - @cotal-ai/workspace@0.70.0
  - @cotal-ai/core@0.70.0
  - @cotal-ai/lang@0.70.0

## 0.69.0

### Minor Changes

- d29d4d3: A remote manager now verify-evicts its credential family through its host with one maintenance request per 256 holders instead of one per holder. The `evict-family-principal` request carries `principals`, 1 to 256 distinct holders, in place of `principal`, and the result carries `evictions`, one `EvictionResult` per principal in request order, in place of `eviction`. The host reads the caller's `epcred.manager.<instanceId>` family once per request, refuses the request when any named holder is outside it, and evicts the set in one `evictPrincipals` sweep. Before, each restart cost one host request, one family read, one credential mint and one daemon sweep per holder, so the host's work grew with holders times family rows. `registerRemoteManagerAuthority` now takes an `evict` that answers one verdict per holder for a set, `makeDeliveryAdminHolderEvictor` answers one `EvictionResult` per holder, and the registration barrier's `evictMax` option is removed, since every evictor now takes up to `EVICT_PRINCIPALS_MAX` holders per call. A remote manager and its issuing host must upgrade together.

### Patch Changes

- 6efcb8a: `deviceLogin` and `establishIdpSession` now await `onPrompt`, which may return a promise. Polling starts only after the prompt settles, and a rejection from it fails the login instead of escaping as an unhandled rejection. The device code's lifetime also bounds the prompt, so one that never settles fails the login at expiry.
- d8adc43: `handleManagerServiceAuthority` now takes `ManagerServiceAuthorityCtx`, exported from `@cotal-ai/auth`, which holds only the fields the handler and its dispatcher read. A host that serves the manager-authority route with a context it builds itself no longer casts that context to the full private handler context, so a dispatcher arm missing from it is now a compile error. It used to typecheck and then fail with `is not a function` on the first request of that kind.
- 259f570: The manager cluster parser that activation, standing renewal and run-attempt admission share now words its refusals for the document instead of an activation request: "found no canonical manager cluster document", "the manager cluster document carries a malformed command declaration" and "the manager cluster document declares command <name> twice". A standing renewal or run-attempt admission that fails on its registered manager cluster no longer reports an activation that never happened. No other behavior changes.
- a4e4015: Every plane-claim refusal now carries a `PLANE_CLAIM_REFUSED` detail, and `planeClaimRefusal(err)` returns its reason (`corrupt`, `live-peer`, `unknown`, `concurrent`, `fenced`, `released` or `lost`), so a host can retry contention and stop on a corrupt row without matching message text. The `startAuthService` handle's `close()` now rejects when the context did not release its plane claim, either because the row is no longer its own or because the release write failed. It used to resolve in both cases, and only stderr told them apart. The CLI daemon reports such a close on its exit line and exits 1.
- 39efad7: The auth service's authority plane no longer rebuilds the data account's signing context inside remote manager maintenance, run admission and run attempt issuance. The serve-executor and run-admitter mints, the run admission's issuer window, and the run-driver, run-mediator and run-operator mints now use the plane's `issuerAuth()`, so a change to how the plane signs reaches them with the plane's other issuer windows and mints. No behavior changes.
- c55b463: An auth-service context started by the CLI composition no longer carries a made-up hosted context. The shared builder gave every handle a `readiness()` and, with no assigned context, reported the store's data account with an empty lifecycle UID, a key no assignment names and `startAuthService` itself refuses. Only `startAuthService` now attaches `readiness()`, and it reports the context it was assigned.
- 9e59f0a: The ledger scanner, the records scanner and managed-agent enrollment now share one keyed serialization helper instead of three private copies. The two scanners' copies never removed a key, so their module maps kept one entry for every space a process had ever scanned. The shared helper removes a key once its last queued call settles, which the enrollment copy already did. Scans still run one at a time per space, and a scan still runs after an earlier one fails.
- 886c3e5: The managed-agent host doors (enrollment, prepare-retirement, and runtime create and status) now run one current-registration check instead of three hand-kept copies of the open gate, serve principal, serve epoch, and registration proof checks. The order and codes are unchanged. An enrollment refused for an absent or frozen gate now reads `enrollment found no current open manager gate for instance <id>`.
- 426d72e: The issuing host now admits a run that a signerless manager forwards only if it saw the caller publish that `run-start` request on the broker, and only once. Before, it checked the forwarded subject's caller against live issuance and its publish ceiling, so a registered manager could get an admission, and then driver and mediator credentials, for any live caller whose ceiling permits `run-start` on it without that caller asking. The host's issuer connection now also watches the `run-start` request subjects on both manager routes, read-only, the way it already watched `run-resume` and `run-answer`. A forward it did not observe, or a second forward of one it did, is refused as `permission-denied`. The manager's request is unchanged.
- 93716c3: The loopback check that lets plain http carry a credential now has one definition, `isLoopbackLiteral` in `@cotal-ai/core`. `agent-bearer --exchange-url`, the pinned exchange, enrollment redeem, the managed handoff reader and workspace `isLoopbackHost` all call it, so a fix to the rule can no longer reach only some of them. It parses the address, so every IPv6 spelling of `::1` is loopback and a dotted host that is not an IPv4 literal, such as `127.0.0.09`, is not. `isLoopbackHost` keeps only the legacy IPv4 canonicalization a `nats://` host needs.
- Updated dependencies [f5cb8e1]
- Updated dependencies [2d45766]
- Updated dependencies [03a7405]
- Updated dependencies [a256e2f]
- Updated dependencies [3f3d04a]
- Updated dependencies [4500563]
- Updated dependencies [1bdc7f2]
- Updated dependencies [94996e5]
- Updated dependencies [5eb1e24]
- Updated dependencies [69232cd]
- Updated dependencies [02c0a2d]
- Updated dependencies [93716c3]
- Updated dependencies [3a1716d]
- Updated dependencies [9772fd4]
- Updated dependencies [06429be]
- Updated dependencies [adab793]
- Updated dependencies [d29d4d3]
- Updated dependencies [539266a]
- Updated dependencies [b584718]
- Updated dependencies [0c5b205]
- Updated dependencies [98d2b41]
- Updated dependencies [f409b46]
  - @cotal-ai/workspace@0.69.0
  - @cotal-ai/core@0.69.0
  - @cotal-ai/lang@0.69.0

## 0.68.0

### Minor Changes

- 6141e7b: The issuing host no longer signs an answering run operator for a checkpoint token a participant manager names. The manager's request now names the run and step it answers (`operator.answers: { runId, stepKey, amend? }`), and the host requires that run admitted on the manager's instance, reads the pause's token off the run's journal under a read it mints for that run, and requires a served answer to name the same run and step as the request it observed. Before, a manager could be issued the answer and settle writes for another instance's waiting pause. The pause lookups `openCheckpointToken`, `settledPauseToken`, `stepPauseToken`, `CheckpointNotOpen` and `CheckpointNotAmendable` move to `@cotal-ai/lang`; `@cotal-ai/runtime` still exports the first four. A participant manager and its issuing host must upgrade together.

### Patch Changes

- 171a177: The manager serve grant no longer takes a serve actor it never read. `reconstructRemoteManagerServeGrant` now takes the request, the owner and the observed gate, and `remoteManagerServeGrantFromCluster` no longer computes and discards the manager actors. The grant is unchanged: it is derived from the gate and the cluster document alone.
- 9b439e8: `mintPublicUserJwt` in `@cotal-ai/core` now takes only what it signs with: the space and the account's public key and signing seed. The auth service passed it that partial context behind a cast that turned the type check off for every remote-manager credential it signs. It now passes the context typed. Its authority plane also opens the auth KV view once and reads every manager issuance gate through one helper, where each operation used to reopen the view and rebuild the gate inline. The activate arm's duplicate missing-gate check, which could never run, is gone.
- f81a132: The docs index and the platform control authority design page no longer call the door unreleased. It shipped in 0.60.0 and its readiness read in 0.62.0. The delegated user launch intent design page now says it shipped in 0.62.0, with its host incarnation members in 0.65.0. No behavior changes.
- Updated dependencies [6141e7b]
- Updated dependencies [4120c97]
- Updated dependencies [218006f]
- Updated dependencies [681c5b0]
- Updated dependencies [585fdb2]
- Updated dependencies [a5256fd]
- Updated dependencies [0d806ae]
- Updated dependencies [b38a683]
- Updated dependencies [d5ea4d2]
- Updated dependencies [54e0199]
- Updated dependencies [9b439e8]
- Updated dependencies [41a7e66]
- Updated dependencies [f018376]
- Updated dependencies [6a1789b]
- Updated dependencies [237c813]
  - @cotal-ai/core@0.68.0
  - @cotal-ai/lang@0.68.0
  - @cotal-ai/workspace@0.68.0

## 0.67.0

### Minor Changes

- f389576: `cotal spawn --resume <id> --detach --on <instance>` carries a Claude session held on the operator's host to a manager on another host, as `docs/design/resume-transfer.md` lays out. The CLI finds the transcript with the connector's new `resumeTranscript` locator and writes it into a JetStream Object Store bucket owned by the target instance, in chunks sized to the broker's `max_payload`, as a chain that an interrupted carry continues. The manager's new operator-only `transcript-receive` command stages it, removes the broker object, and issues a one-time `resumeClaim` that `spawn` consumes; a re-run of the same bytes moves none. The seat forks the transcript in a seat-private Claude home that authenticates with an environment credential, and `cotal ps --wide` names the source host, session, digest and carry time. The manager cluster document moves to revision 21. Two one-shot credentials carry it on an authenticated mesh: a `transfer-writer` the CLI mints from the space's signing seed for the one transcript it hashed, or on a user-auth mesh exchanges from the operator's login as the new `transfer-writer` view (scope `admin`), and a `transfer-reader` the target manager mints for its own bucket on each receive or sweep, or that the host issues a remote manager through the new manager-service `transferReader` operation. A carried seat records the digest of the transcript Claude forked, and the manager stops a seat whose record does not match the carried bytes, including one whose launch was uncertain and that joined later. Space deletion lists the transfer buckets and deletes them: `deleteSpace` given the space's trust material mints its own `teardown` naming them, and it now throws naming every stream it could not delete instead of reporting success. The console space picker deletes a space this host registered as a static-auth mesh that way. The `transfer-writer` view, and the broker connection minted from it, lives at most five minutes, the static credential's lifetime.

### Patch Changes

- 5b0da88: Breaking: the issuance-gate types now carry the op rule the gate parsers already enforce. `EpGateRow`, `EndpointGateRow` and `EpGateState` declared `op` optional in every state, so each reader re-derived it with placeholders, assertions and fallbacks for a case the parsers refuse. They are now a union on `state` over a shared `GateOp`: `open` carries no op, and `frozen` and `retired` always carry one. A reader that has checked the state reads `op` directly, and an in-memory gate or barrier that freezes or retires without recording its op no longer compiles. Because they are no longer interfaces, an `interface` that extends one fails with TS2312; declare it as an intersection such as `type CustomGateRow = EpGateRow & { custom: string }` instead. The endpoint gate's mint fence and registration barrier also read the `epgate` row through one shared reader and one mapping into `EpGateState`, so the two `observe` members can no longer refuse a DEL marker or carry the row's fields differently. Gates that parsed before parse the same way, and the refusals are unchanged.
- cd59891: `docs/embedding.md` now shows how a host builds `platformControl.host`. Registration reads the closure manifest `{ v: 1, root, members: [] }` at `clusterDigest` and the cluster document at its `root`, so `artifacts` carries both and `clusterDigest` is the digest of the manifest. `members` stays empty because single-document clusters are the only ones registered, and the instance id is a lifecycle token. A minimal one-command example built from `contractDigest`, `VOID_SCHEMA_DIGEST` and `mintLifecycleUid` is included. No behavior changes.
- 73567e2: The auth decisions that read a manager's gate now take `ObserveManagerGate` instead of restating its result, and `ObserveManagerGate` takes its fields from core's `EpGateState`. `authorizeRemoteManagerRenewal`, `admitRemoteRun`, `authorizeRemoteRunAttempt`, `authorizeRemoteManagerGoalIndexScan`, `authorizeRemoteManagerMaintenance`, `authorizeRemoteManagerAdmin` and `AuthorizeRemoteRetainedAgentValidationArgs` each wrote the gate's fields and state union out again, so a change to the exported type reached none of them and the typecheck stayed green. The retirement decision and the platform control view of a manager's gate also take their fields from `EpGateState`. Every decision accepts the same gates as before.
- 79e5268: Every request that carries a manager's `identities` now goes through one parser, `parseRemoteManagerIdentities`, and one name list, `REMOTE_MANAGER_IDENTITY_NAMES`, both exported from core. The run admission and run attempt parsers had their own copy, which checked only that each id was a string. A non-nkey id got through to the proof check and was refused there as `permission-denied`, and a wrong key set got a message that did not name the expected keys. Both now refuse with the same `bad-request` messages as the other manager requests: "identities.<name>.id must be a user nkey" and "identities must contain exactly supervisor, executor, serve, goalWriter, sessionLedger". The auth parsers, the credential checks in authority issuance and the manager's standing renewal checks now use the shared list too, so a change to the identity set happens in one place.
- c3601f9: A logged-in user's workflow run on a `cotal supervise` participant manager can spawn, turn and despawn agents that user owns and receive their typed answers. The run's spawn takes the admin reach of the user who started the run, read from that user's actor-ledger row when the spawn runs, so a space that requires the event plane no longer refuses it and a revoked login demotes it. The host pins each run mediator it signs for a participant manager to a placement on that manager's own instance, so a program may place a spawn there; a placement on any other instance is refused at `run start`. A completed run now releases a seat by the identity its spawn terminal records, so a seat the host enrolled at its own lifecycle UID is despawned instead of left running.
- 562a56b: `@cotal-ai/core` now exports `UserCredentialsRequest`, the one request type `AuthProvider.userCredentials` takes. The reference provider uses it for both the local and the remote client arm: the remote arm takes the request object instead of each coordinate as a positional parameter, and both arms send the `/exchange` body from one builder. A coordinate can no longer reach one arm's exchange body and miss the other's, and two coordinates of the same type can no longer be swapped at the remote call. The exchange body on the wire is unchanged.
- Updated dependencies [48f18d0]
- Updated dependencies [e85e1fd]
- Updated dependencies [55061ff]
- Updated dependencies [5b0da88]
- Updated dependencies [e65ec69]
- Updated dependencies [79e5268]
- Updated dependencies [bb0b14e]
- Updated dependencies [3069425]
- Updated dependencies [ae5b3cd]
- Updated dependencies [954a78b]
- Updated dependencies [f389576]
- Updated dependencies [562a56b]
  - @cotal-ai/core@0.67.0
  - @cotal-ai/workspace@0.67.0

## 0.66.1

### Patch Changes

- Updated dependencies [568f718]
  - @cotal-ai/workspace@0.66.1
  - @cotal-ai/core@0.66.1

## 0.66.0

### Minor Changes

- 658c1b8: Breaking: the `ai.cotal.ep.lifecycle-blocked` refusal detail now reports only the state the refusing site read. `headState` is optional and set only where the lifecycle head was read; a new `gateState` (`frozen` or `retired`) is set where the issuance gate was read. A gate frozen by a takeover, a registration or another retirement used to report `headState: "retiring"` over an active head or a service instance with no head, and a retired gate reported `headState: "retired"` with no head. `blockedOp` is the gate's own op kind instead of defaulting to `registration`, and `registerServiceInstance` refuses a frozen gate observed without a valid op (a string `opId` and one of the four op kinds) as `internal`. The manager's reserved-name refusal no longer claims a head state. A client that read `headState` from a gate refusal must read `gateState`.

### Patch Changes

- a07f732: The docs now state the first process epoch. SPEC §13.7 and `docs/embedding.md` say that the first registration of an instance commits epoch 0, that epoch 0 is open and serving like any later epoch, and that each later start of the same instance commits the previous epoch plus one, so a consumer or sweeper never treats 0 as absent or not ready. `docs/embedding.md` also states that `awaitHostFence` takes any non-negative safe integer epoch, 0 included, and refuses any other value with `bad-request`. No behavior changes.
- af779f9: Core exports `registerServingInstance`, which runs `registerServiceInstance` and then authorizes the instance's serve grant and writes its `ready` status at the `processEpoch` and `registrationRevision` that registration committed, both fenced on the registration barrier's read of the issuance gate. It returns `{ registrationRevision, processEpoch, grant }`, and an optional `status` adds fields to the ready status. The auth plane's own boot registration, the manager's boot registration and `registerRemoteManagerAuthority` now call it instead of assembling the grant and status by hand, so the epoch these steps run at comes from one place. Their behavior is unchanged.
- 611b71f: `cotal auth-service` now answers a remote manager's managed-agent enrollment and retirement preparation itself instead of refusing both for a host platform to intercept. A signed-in participant running `cotal supervise` can spawn a detached user-mode agent and terminally release it against a stock host. Enrollment runs the existing door checks, writes the managed grant at a fresh host-chosen lifecycle UID under the supervising actor's delegation envelope, provisions that UID's durables, and returns the daemon's public exchange URL for the agent's bearer; a failed provision revokes the grant. A retry carrying the same token digest answers the same UID while the supervising actor's current grant still covers it, and an enrollment of a name whose grant still stands is refused with `conflict` until its retirement is prepared. Retirement preparation releases the target UID's broker footprint and then revokes its grant. Enrollment needs the daemon's public exchange face. A platform that keeps these writers in its own storage still intercepts both kinds and uses the verify-enrollment door.
- Updated dependencies [a07f732]
- Updated dependencies [be53e2d]
- Updated dependencies [658c1b8]
- Updated dependencies [af779f9]
  - @cotal-ai/core@0.66.0
  - @cotal-ai/workspace@0.66.0

## 0.65.0

### Patch Changes

- ba5468d: A platform composition that hosts the auth context can now get the host incarnation that a delegated user intent pins as its executor (SPEC 13.16). `PlatformControlInput` takes an optional `host: { endpoint, clusterDigest, artifacts }`: the reverse-DNS endpoint of the host process that runs the intent flights, the closure digest of its §13.7 cluster and every contract artifact that closure needs. The auth plane self-authorizes that one name, and a single-label name is refused at start. With it, `AuthServiceHandle` gains `registerHostIncarnation(instanceId)`, which publishes the artifacts, registers that instance through the same ceremony the auth plane runs for its own `auth` endpoint, and returns `{ instanceId, processEpoch }` with the epoch that registration committed, `observeHostGate(instanceId)`, the sweeper's point-in-time read of that endpoint's issuance gate over the context's own connection, and `awaitHostFence(instanceId, processEpoch)`, which resolves with the gate once it is no longer open at that epoch, or with null once it is absent. A host that registers its persisted instance id at every start fences its predecessor and advances the process epoch, so a restarted host reads its earlier incarnation as gone. A start whose confirming read of the gate finds that a later start of the same instance registered is refused with `conflict`. The returned epoch stays current only until the next start registers, which can happen before the call returns, so the host arms `awaitHostFence` with it before it admits or recovers any flight and stops serving when the hook resolves. `docs/embedding.md` and `docs/design/delegated-user-launch-intent.md` describe all three members. Core's KV issuance gate adapters (`serveIssuanceGateKv`, `provisionEndpointGateOpen`, `endpointRegistrationBarrier` and `readEndpointGateGeneration`) tokenized the endpoint name twice, and the registration repair cursor rebuilt its key from the token, so every reverse-DNS endpoint threw before it reached its gate or partway through its registration. They now carry the name and leave the key builders to tokenize it. Single-label endpoints are unchanged. Core's `registerServiceInstance` also returns the `processEpoch` its completing reopen committed, so a caller no longer reads the epoch back from a gate that a later registration may already have advanced; the auth plane's own registration takes it from there.
- Updated dependencies [ba5468d]
- Updated dependencies [451ffee]
- Updated dependencies [f01aa7c]
- Updated dependencies [2cef9e6]
  - @cotal-ai/core@0.65.0
  - @cotal-ai/workspace@0.65.0

## 0.64.0

### Patch Changes

- Updated dependencies [6c79419]
- Updated dependencies [d121d21]
  - @cotal-ai/core@0.64.0
  - @cotal-ai/workspace@0.64.0

## 0.63.0

### Minor Changes

- c975258: A logged-in user can now run hosted workflows on a user-auth space. The auth callout issues an interactive user's `manager-caller` view as an issuance (SPEC 13.15): it chooses the generation, records evidence whose one source is the user's actor-ledger row, and writes the accepted row under a token derived from the connection's inbox nonce, renewing that generation on a reconnect whose ceiling is unchanged. `cotal run` and the other manager calls read the generation back with the new `issuedUserCaller` and ride `ep.v1`, so `cotal run start` against a participant manager started with `cotal supervise` is admitted. The issuing host admits a run from a user caller only for the manager's registered owner, and a participant manager now forwards the served subject of every caller resume and answer, which the host checks against the run's owner and the caller's live issuance; a legacy-rail resume is refused. The issuing host subscribes to those resume and answer request subjects itself and issues for a forwarded one only when it observed that request, only once, and only for the run a resume's envelope names or the endpoint and amendment an answer's envelope names, and never for a request bound to another manager instance or epoch or declaring another class or pinning another contract than the manager registered for that command. Every answering operator issuance must carry that served subject, and an amendment's carries `answers.amend: true`, which the host accepts only for a pause settled with an accepted answer, so `cotal run amend` works on a participant manager. A user caller starts, resumes and answers runs only on the participant manager that user registered, and a static caller keeps its admission there. A managed seat's manager call keeps the legacy rail when the broker refuses its accepted-row read, which surfaces as a request error caused by the permission violation. Revoking or re-granting the actor makes its issuances dead at the next resolution. New exports: `connectionAcceptedToken`, `actorLedgerSource`, `actorLedgerSourceBucket`, `parseActorLedgerSource`, `issuedUserCaller` and `isDerivedOwner` in core, and `ledgerActorSourceIsLive` and `UserCallerIssuer` in auth. `manager-caller` joins the issuable profiles, and the `issuer` profile gains the per-key read of the accepted store. SPEC §13.15 gains a **User-auth issuance** paragraph and §14.8 a **User-auth runs** paragraph, both insertions; `docs/design/user-auth-run-start.md` records the path, and `docs/cli.md`, `docs/workflows.md` and `docs/run-a-mesh.md` describe it. `docs/run-a-mesh.md` also says the stock auth service refuses managed-agent enrollment and retirement preparation for a host platform to intercept.

### Patch Changes

- Updated dependencies [62ebc6b]
- Updated dependencies [22e210a]
- Updated dependencies [cb6a0bf]
- Updated dependencies [5738154]
- Updated dependencies [101c9b0]
- Updated dependencies [9d5cc09]
- Updated dependencies [c975258]
  - @cotal-ai/core@0.63.0
  - @cotal-ai/workspace@0.63.0

## 0.62.0

### Minor Changes

- bcf66d6: Add a delegated user intent: SPEC §13.16, a design record, and the host decisions it needs. A signed-in user admits one launch or one retirement on the host's authenticated route, and a platform control holder consumes that intent once from its current registration, epoch, assignment revision and lifecycle. `@cotal-ai/core` adds the closed request types and parsers for the user's intent and the holder's execution, `parseRemoteDelegatedUserIntentExecutionResult`, and `resolveReadAcl`, the read-list resolution `provisionAgentDurables` already used. `@cotal-ai/auth` adds `authorizeDelegatedUserIntentAdmission` and `authorizeDelegatedUserIntentExecution`, the record, pin and flight types, `delegatedUserIntentHoldsAlias` and `joinOrStartDelegatedUserIntent`, `AuthServiceHandle.observeManagerGate`, which a platform composition's handle carries so the host reads the holder's gate over the context's own connection, and `AuthServiceHandle.activateManagedLifecycle`, which activates a delegated launch's lifecycle at its pinned UID before any row or durable and mints nothing, so a launch the host compensates or the user retires reaches the terminal barrier even when its agent never exchanged. Admission derives nothing from the request: it takes the owner the host derived from the verified IdP subject, requires `spawn` on the user's own fresh ledger row, binds the account's current platform assignment and the holder's open gate, and dry-runs the envelope walk from the user's principal over the read list the writer will provision. Execution compares the request with the record and with the fresh assignment, gate epoch and registration proof, and returns the user's owner and parent for the host's writers. The holder gains no grant, no decision reads `supervise`, and the `platform-control` view's same-owner rule is unchanged. Stock dispatch refuses both kinds as `unimplemented`; a host that owns an intent store and the enrollment and retirement writers composes the decisions on its own routes. `@cotal-ai/manager` adds `remoteAuthority.executeDelegatedUserIntent`, `StartAgentOpts.delegatedIntent` and `Manager.retireDelegatedAgent`: a delegated launch takes the hosted enrollment arm with the intent's execution and refuses material under any owner but the intent's, and `retireDelegatedAgent` stops a delegated agent only after the host confirms `retired: true` for its exact target and operation id. A delegated agent's name, including one whose launch failed at any step after the host's enrollment answer, stays held until then.
- 231d226: A platform composition can now ask whether its assigned control manager is serving. With the `platformControl` input, `startAuthService` returns a handle with `platformControlReadiness(instanceId)`, which answers that manager instance's `status` reply and refuses any instance the current assignment does not name, or one whose gate another owner holds. The auth context reads over its own connection, whose grant is that instance's `describe` and `status` and its own reply rail. The connection renews in process like the context's other connections and never leaves it, so a pooled control host no longer needs a human or operator credential, a per-read control instrument, or the manager's process id to tell whether the manager is up.

### Patch Changes

- Updated dependencies [bcf66d6]
- Updated dependencies [97a2382]
- Updated dependencies [877909b]
- Updated dependencies [5ef9a67]
- Updated dependencies [565036c]
- Updated dependencies [9236a12]
- Updated dependencies [b36bebf]
  - @cotal-ai/core@0.62.0
  - @cotal-ai/workspace@0.62.0

## 0.61.0

### Minor Changes

- 1eca3e0: `startAuthService` takes an optional `publicFace` input with the CLI's public face settings (`port`, `url`, `trustedProxy`, `advertisedServer`, `agentProvisioningUrl`) and checks them by the CLI's rules. An embedded context can now serve the public exchange, JWKS and discovery bundle, and its handle carries `publicUrl`. The handle also carries the per-start `cap` that `runAuthService` writes to `auth-service.json`, so a host can call its own loopback host actions. A public face without a port refuses to start. The new `PublicFaceInput` type names the input.

### Patch Changes

- @cotal-ai/core@0.61.0
- @cotal-ai/workspace@0.61.0

## 0.60.0

### Minor Changes

- 6ca4d8e: Add the platform control authority: a closed `platform-control` view, beside the unchanged human `manager-service` view, that lets a host platform run one pooled control manager per assigned account without a human session (SPEC §13.1, §13.6, §13.9). `startAuthService` takes an optional `platformControl: { observeAssignment }` input, and the returned handle then carries `platformControlAuthority`, a typed in-process door served on no listener. It issues the existing manager-service request family under a host-derived `p_` platform owner (`platformControlOwner`), reads the backend's assignment fresh on every call, reuses the registration proof, process epoch and all-duty renewal unchanged, confines maintenance to the assigned instance, and refuses `prepare` and `activate` while a named predecessor manager is still registered. It refuses IdP tokens, another account, a stale assignment, another owner's instance, unknown fields (a nested `session` field included) and the managed-agent kinds. `@cotal-ai/core` adds the `PlatformControlAuthorityRequest`, `PlatformControlInnerRequest`, `PlatformControlAuthorityResult` and `PlatformControlAssignment` types, the `p_` owner grammar, and an opt-in `allowPlatform` on the principal owner checks and on CONNZ attribution (`principalFromConnz`). Only the platform family's own boundaries opt in: the issuance gate row, the credential holder row, the eviction and liveness sweeps with the delivery daemon's executors, the manager goal-index scanner, the run driver caller, and, for the platform holder only, the retirement target, retained-validation target and admin caller parsers. The membership feed and the message drop guards still refuse a `p_` owner. Presence has no owner check, so a platform endpoint's roster card appears under its `p_` owner. `startAuthService` also forwards a trusted-host `standingRenewableTtlSeconds` to the authority plane. The human remote-supervision path is unchanged.

### Patch Changes

- 9f22cf0: The public exchange suite (`smoke:remote-exchange:live`) now has a mutation fixture, `implementations/auth/smoke/mutations/remote-exchange.json`, for its security cells: the capless loopback 401 that pairs the public 200, the per-peer refusal throttle, a valid credential still minting from a throttled key while a refusal's reason is withheld, and the one sentence an unknown agent and a wrong secret share. Its per-peer isolation and budget-separation cells now probe with a refused exchange and require its own 401 sentence. They probed with a valid credential, which mints even from a full bucket, so they stayed green with every peer sharing one bucket and with public refusals charging the loopback budget. Service behaviour is unchanged.
- Updated dependencies [3b616a2]
- Updated dependencies [6ca4d8e]
  - @cotal-ai/core@0.60.0
  - @cotal-ai/workspace@0.60.0

## 0.59.0

### Minor Changes

- 70bcfe3: Breaking: `cotal actor grant` no longer turns an omitted ACL flag into the wide default, so a bare grant that used to succeed now needs `--full`. A grant must name `--scope`, `--allow-subscribe` and `--allow-publish`, or pass `--full` to take `spawn,role:default`, `>` and `>` for the ones left off. Otherwise it refuses, writes nothing, and prints both forms. Dropping one flag from a narrow event-plane reader grant used to mint a row that read or posted to every channel, or could spawn, with a success line as the only sign. The hints printed by `cotal login`, `cotal status`, `actor list` and the not-granted refusal now include `--full`.
- c389563: Hosted runtime create and status for managed agents. Core adds the closed `manager-managed-agent-runtime-create` and `manager-managed-agent-runtime-status` kinds on the manager-service-authority transport, with parsers that refuse any unknown top-level or target field, including `providerRef`, `handle`, and `name`. Core also adds a result builder and binder whose `state`, `readiness`, and optional `retirementPhase` come from closed sets. The auth service adds `authorizeRemoteManagedAgentRuntimeCreate` and `authorizeRemoteManagedAgentRuntimeStatus`. Each applies the enrollment door's gate, epoch, and proof checks, reads `supervise` from the manager actor's own ledger row, and returns only `{ owner, instanceId, actor, target }`. The loopback verify-enrollment door serves both kinds, and stock dispatch refuses them with `unimplemented`. The manager client adds `remoteManagedAgentRuntimeRequest` and `remoteManagedAgentRuntimeState`. The enrollment result gains an optional, display-only `runtimeIntent: { state: "reserved" }`, which older hosts omit and the manager never treats as authority.

### Patch Changes

- 5bec8b2: `cotal attach` now opens a seat's session on a user-auth mesh. The CLI presents its bearer identity together with the session grant to the auth service's exchange, which issues a `session-caller` view bearer only after it confirms, against the redeemed `session.<id>` row and the serving manager gate, that this owner and actor hold that session. The callout re-checks the same row and mints the same `session-caller` rails with the grant's expiry that the static path mints. No local seed is read or written.
- 608f5f4: Re-attach doc comments that had drifted away from the declarations they document. A `/** */` block followed directly by another one documented nothing, so editor hovers and the published type declarations showed no doc for the intended declaration (for example `Manager`, the `plane3` field and `AclResolver`). Each such block now sits above its declaration, is merged into the block it duplicated, or is removed when its declaration no longer exists. A new `pnpm check:doc-comments` check, run as part of `check:docsbundle`, refuses a doc block followed directly by another in shipped source.
- efe37a9: A remote manager whose authority request is refused by an older host, for a field that host's auth service does not know, now reports version skew. After the host's reason, the refusal names the manager's Cotal version and the field, and says the manager needs a host at that version or later. This covers every manager-authority request, including the all-duty renewal and hosted-run admission. The field is still sent.
- aa12a1a: Gate reconciliation no longer scales with credential family size. `cotal reconcile-gate`, manager boot self-heal and remote manager maintenance revoke the family's ledger rows 16 at a time, then verify-evict every distinct holder in one shared scan, KICK and verify sweep through the new `evictPrincipals` delivery-admin verb instead of one connection and one sweep per holder. The sweep keeps up to 16 KICK requests in flight, so a family whose holders are still connected no longer pays one broker round trip per connection. Holders a sweep verifies are still recorded durably when another holder is not verified, and an interrupted sweep records none.
- Updated dependencies [70bcfe3]
- Updated dependencies [1cf7f72]
- Updated dependencies [5bec8b2]
- Updated dependencies [6c01470]
- Updated dependencies [cfc3b95]
- Updated dependencies [b669a73]
- Updated dependencies [350c87b]
- Updated dependencies [608f5f4]
- Updated dependencies [43c4179]
- Updated dependencies [4a12111]
- Updated dependencies [569cb6f]
- Updated dependencies [b4c69bf]
- Updated dependencies [f485c49]
- Updated dependencies [5f13124]
- Updated dependencies [fb1bc26]
- Updated dependencies [c389563]
- Updated dependencies [06f48f4]
- Updated dependencies [eb2681e]
- Updated dependencies [fb1bc26]
- Updated dependencies [438e9ed]
- Updated dependencies [446ed23]
- Updated dependencies [15c16ff]
- Updated dependencies [8ce6be3]
- Updated dependencies [08194ec]
- Updated dependencies [aa12a1a]
- Updated dependencies [d90f9f2]
- Updated dependencies [499bd8a]
- Updated dependencies [569cb6f]
- Updated dependencies [d0b1da3]
- Updated dependencies [37075a2]
- Updated dependencies [8d8d69a]
- Updated dependencies [c7bfc2d]
- Updated dependencies [6145abc]
  - @cotal-ai/workspace@0.59.0
  - @cotal-ai/core@0.59.0

## 0.58.0

### Minor Changes

- 95ae645: The auth retirement rail is a conforming registered endpoint with a describable contract. The requester calls it through the generic client in the exact target mode. A legacy body is refused as unsupported-version.

### Patch Changes

- 274c783: Start the bootstrap membership renewal fixture with a genuinely expired credential and verify broker refusal before renewal. This avoids depending on different JWT bytes when two fresh issuances occur in the same wall-clock second. Keep the native renewed-credential, stable-identity and broker-acceptance checks, with explicit mutation controls.
- 2cb1d72: Add `startAuthService`, an account-scoped auth-service context with readiness, drain and close that installs no process signal handlers, never exits the process and never selects a root from the working directory. `openAuthAuthorityPlane` now takes its local manager identity as an explicit `localManager` input instead of reading it from the cwd-selected root.
- 7c54825: Distinguish native consumer deletion acknowledgments and observed disappearance from uniquely attributable removals. Refuse live KV CAS successors, preserve exact-target INFO grants, and propagate unknown uniqueness through Manager reconciliation. Count ACL and membership rows removed by a competing purge as observed disappearances, not prior absence or this caller's deletion.
- 397bc60: Deprovisioning returns truthful bounded resource accounting distinguishing deleted resources from absent no-ops across repeated teardown attempts. Key existence and tombstone state are verified through exact Direct Get checks before purging KV keys, ensuring repeated deprovisioning reports zero deleted entries. Partial broker failures record refused resources and raise DeprovisionError with partial accounting rather than discarding earlier progress.
- 7b3924c: Retire a lifecycle's durable membership rows through target-pinned exact-key grants. Complete inventory derives channels from validated native keys, including wildcard-covered and unnamed channels, so unreadable values cannot hide rows from cleanup. An unavailable inventory retains undiscovered rows and holds retirement pending retry. Other principals and successor lifecycles remain untouched. Retirement fixtures now use complete zero-row responses only for empty synthetic inventories, and the user-mode test verifies held retirement until genuine delivery returns.
- 59672dd: Register the remaining hosted-runtime smoke entrypoints in stable CI fragments and report native assertion counts through canonical completion markers. Refresh the explicit-TLS call-site census. Make the resume fixture retain its first successful held-slot observation or require durable completion with a new epoch, and exercise completion before the probe as a separate regression gate.
- 1721738: Support signerless manager run hosting through typed host admission, initial-attempt and renewal operations. Renew the complete standing credential family while preserving held identities, serve epochs and last-good credentials on refusal. Keep pooled managers off local PTY launch paths and enforce the execution host boundary. Update the native lifecycle and mutation checks for these paths.
- Updated dependencies [0589316]
- Updated dependencies [59a7e64]
- Updated dependencies [95ae645]
- Updated dependencies [fba1537]
- Updated dependencies [576f622]
- Updated dependencies [2457692]
- Updated dependencies [ee6de5d]
- Updated dependencies [e9ef5b3]
- Updated dependencies [7c54825]
- Updated dependencies [2c31f95]
- Updated dependencies [397bc60]
- Updated dependencies [7b3924c]
- Updated dependencies [1721738]
  - @cotal-ai/core@0.58.0
  - @cotal-ai/workspace@0.58.0

## 0.57.0

### Patch Changes

- Updated dependencies [e7c702a]
- Updated dependencies [6f64bcc]
- Updated dependencies [42448fa]
- Updated dependencies [33357d9]
  - @cotal-ai/core@0.57.0
  - @cotal-ai/workspace@0.57.0

## 0.56.1

### Patch Changes

- Updated dependencies [6b76946]
  - @cotal-ai/core@0.56.1
  - @cotal-ai/workspace@0.56.1

## 0.56.0

### Patch Changes

- ac53a09: `cotal update` no longer reads a remote user mesh's manager for continuity, since that manager runs
  under another install and its exchange's answer cannot change the local install; the mesh is named
  and skipped, and the install proceeds. A refused remote exchange that supplies no reason now says
  the face withheld it instead of presenting the HTTP status as the reason (#2158).
- Updated dependencies [e506040]
- Updated dependencies [8dc7c92]
- Updated dependencies [99cad7b]
- Updated dependencies [1218786]
- Updated dependencies [ef8889d]
  - @cotal-ai/core@0.56.0
  - @cotal-ai/workspace@0.56.0

## 0.55.0

### Minor Changes

- 92ae52c: Add a loopback door, `POST /managed-lifecycle/retire` (`MANAGED_RETIRE_PATH`), that lets a host finish a managed agent's terminal retirement when the remote manager that should request it is gone. It carries the interactive door's guards, requires the managed grant to be revoked at that lifecycle first, and runs the rail's `managedRetirementOpId(uid)` operation. The rail and the door share one in-process flight, so they never execute the same retirement twice.
- 2e13607: Let a remote participant supervisor spawn and terminally release a HOST-OWNED managed agent (#1972). A registered participant holds no ledger writer, no JetStream provisioner, and no signing seed, so `cotal spawn <actor> -d --on <instanceId>` previously failed in auth preflight and a despawn refused outright.

  `@cotal-ai/core` adds the two closed wire operations and their parsers: `manager-managed-agent-enrollment` and `manager-managed-agent-prepare-retirement`. An enrollment carries the SHA-256 digest of the agent's standing actor token and never the token, and carries no lifecycle UID at all; a prepare-retirement's `opId` must be `managedRetirementOpId(target.lifecycleUid)`.

  `@cotal-ai/auth` adds `authorizeRemoteManagedAgentEnrollment` and `authorizeRemoteManagedAgentPrepareRetirement`, which require `supervise` at the caller instance's current open manager gate with the host-issued registration proof, plus the loopback door `POST /manager-service-authority/verify-enrollment` (`VERIFY_ENROLLMENT_PATH`) that a host platform calls for the decision while it owns every write. The door derives the caller's scope from the local ledger rather than the request body. `dispatchManagerAuthorityRequest` refuses both kinds with `unimplemented`, since stock owns no such storage, and the provider gains the `enrollRemoteManagedAgent` and `prepareRemoteManagedAgentRetirement` clients.

  `@cotal-ai/manager` adds the `remoteAuthority.enrollManagedAgent` hook and takes it in `provisionUserAgent`: the participant generates the actor token, writes it at 0600 before the request, sends only the digest, adopts the HOST's chosen lifecycle UID, and launches `agent-bearer --exchange-url`. `prepareAgentRetirement` now performs the host release instead of throwing.

### Patch Changes

- 84e0175: The bare-grant default is described as `spawn,role:default` everywhere it is described, and the launch smoke asserts the full scope.
- e4f1d2d: A managed grant without a lifecycle uid is refused at the ledger instead of being minted one.
- f7f23d3: The user-spawn smoke grades the remedy's route selector in its own cell, so the two remedy mutants are held by two cells.
- Updated dependencies [888e9bc]
- Updated dependencies [810814b]
- Updated dependencies [8472dc3]
- Updated dependencies [f272f71]
- Updated dependencies [a83dd80]
- Updated dependencies [db9a969]
- Updated dependencies [d284ee6]
- Updated dependencies [4f48629]
- Updated dependencies [2e13607]
- Updated dependencies [d3d6742]
- Updated dependencies [fd58782]
- Updated dependencies [357af9f]
  - @cotal-ai/core@0.55.0
  - @cotal-ai/workspace@0.55.0

## 0.54.0

### Patch Changes

- b4317fd: Add a short-lived manager-caller view that binds user-auth control requests to one live manager instance on the instance rail.
- Updated dependencies [e6badb8]
- Updated dependencies [34beea1]
- Updated dependencies [b4317fd]
  - @cotal-ai/core@0.54.0
  - @cotal-ai/workspace@0.54.0

## 0.53.0

### Minor Changes

- 104921c: Let remote user-auth managers renew registration executors and recover stopped or frozen manager registrations through host-scoped eviction and guarded reconciliation.

### Patch Changes

- Updated dependencies [d1f9703]
- Updated dependencies [104921c]
- Updated dependencies [83617ab]
  - @cotal-ai/workspace@0.53.0
  - @cotal-ai/core@0.53.0

## 0.52.1

### Patch Changes

- 5784ec9: Bind the user-auth service readiness wait to the daemon process, not a clock alone. A same-root `cotal up` refresh run right after a broker reload killed the old auth-service daemon used to give up at a fixed 15s while the replacement daemon it launched was still binding, then a second identical `up` succeeded: a one-shot false "auth service not ready". `ensureAuthService` now passes the pid it launched (or found live) into the provider's `ready()`, which waits past the base timeout up to 60s while that pid is provably alive, ends the wait at once when the pid exits ("exited before becoming ready"), and refuses at the bound naming the live pid, the pid record, and the service log ("alive and still starting"). `AuthServiceSpec.ready` in core gains optional `pid`/`maxWaitMs` inputs; callers that pass none keep the old clock-only behavior.
- Updated dependencies [5784ec9]
- Updated dependencies [f17791d]
  - @cotal-ai/core@0.52.1
  - @cotal-ai/workspace@0.52.1

## 0.52.0

### Patch Changes

- 50998a8: `cotal status` answers for a user-auth space whose material is a remote registry entry (a discovered space or a `meshes add --from` registration) instead of a local provisioning: the bare-status login row shows the signed-in subject from the entry's pinned IdP (grant reads as "not checkable on this machine", since the ledger runs where the space was provisioned), and `status --components` probes the manager as the signed-in login — the same credential `ps` uses — instead of minting static creds or connecting with none. A user-mode components row that cannot obtain that credential states the reason on the row (verdict `refused`), never a raw Authorization Violation. In user mode the manager row grades `serving` on the manager's own typed service answer, because the manager-lease sweep is a host credential an interactive bearer does not hold. The bare-status delivery responder axis stays `unknown` in user mode, as its comment states. Status still never static-mints on a user-auth mesh, and a signed-out machine still gets the offline "not signed in" row with the exact login command and no network round trip. Refs #1832.
- Updated dependencies [5ee8eef]
- Updated dependencies [2e7558d]
- Updated dependencies [5b2c19f]
- Updated dependencies [d69aefd]
- Updated dependencies [b3db3a2]
- Updated dependencies [c44aaf8]
- Updated dependencies [fe81419]
- Updated dependencies [93b42cd]
- Updated dependencies [a069948]
- Updated dependencies [cf5a5cb]
- Updated dependencies [ab0808c]
- Updated dependencies [6b375c8]
  - @cotal-ai/core@0.52.0
  - @cotal-ai/workspace@0.52.0

## 0.51.0

### Minor Changes

- 491e923: The public user-auth exchange now mints `channel-writer` and `channel-purger` for a signed-in
  human whose ledger row carries `admin`, so a remote owner can run `cotal channels set/default`
  and a dashboard channel delete without a loopback capability. `admin`, `purger`, `deployer`, and
  `manager-service` stay loopback-only. A managed-agent secret exchange still never mints a view.
  This is not full remote channel management: `cotal web` still asks for the read-only admin view
  at startup.
- ec8649b: Preserve the closed required-events registration policy and enforce it across discovery, launch,
  grant coverage, direct connector sessions, and trusted upgrades of existing manual registrations.

### Patch Changes

- db18070: Apply a signed-in account's space catalog to the registry under the provider's catalog lock, and
  record in the cache whether the snapshot was applied in full. A command that dies or is stopped
  while applying no longer leaves a partial registry that fresh and not-modified refreshes accept:
  the next command applies the cached snapshot again first. `prepareSpaceCatalogs` and
  `syncSpaceCatalogAfterLogin` now take the consumer's `apply`.
- a0c8a59: Discover a signed-in account's advertised spaces lazily, cache validated snapshots, and add `cotal sync` for explicit refreshes.
- f178611: Preload every persisted per-space auth-callout account when a shared broker starts, and refuse incomplete user-auth state before writing its resolver config.
- 21407fd: Allow foreground seats to redeem one-time remote user-auth enrollments, bootstrap stock mesh records, and launch without a cached human login.
- Updated dependencies [db18070]
- Updated dependencies [64d723e]
- Updated dependencies [ade42d5]
- Updated dependencies [4f153ab]
- Updated dependencies [eb65c9b]
- Updated dependencies [314a12c]
- Updated dependencies [4dd4b90]
- Updated dependencies [92a8938]
- Updated dependencies [ec8649b]
- Updated dependencies [949d4d1]
- Updated dependencies [949d4d1]
- Updated dependencies [f50e20d]
- Updated dependencies [a0c8a59]
- Updated dependencies [c18c055]
- Updated dependencies [f178611]
- Updated dependencies [21407fd]
- Updated dependencies [26d864b]
  - @cotal-ai/core@0.51.0
  - @cotal-ai/workspace@0.51.0

## 0.50.1

### Patch Changes

- Updated dependencies [c499a85]
  - @cotal-ai/core@0.50.1
  - @cotal-ai/workspace@0.50.1

## 0.50.0

### Patch Changes

- Updated dependencies [ba91ad5]
- Updated dependencies [06eccc3]
- Updated dependencies [6f248ac]
- Updated dependencies [5e23b1d]
- Updated dependencies [44cdcc2]
- Updated dependencies [6cc504b]
- Updated dependencies [87dda9f]
- Updated dependencies [fc6f0b1]
- Updated dependencies [aaedc42]
- Updated dependencies [4ab8b4b]
- Updated dependencies [fe813fe]
- Updated dependencies [55dae63]
- Updated dependencies [7df3498]
- Updated dependencies [438c629]
- Updated dependencies [a211c52]
  - @cotal-ai/workspace@0.50.0
  - @cotal-ai/core@0.50.0

## 0.49.0

### Minor Changes

- 18f3df0: Validate retained remote managed agents through the authenticated host authority service

  Remote supervisors now send the retained actor token and sentinel credential only to the manager
  authority route derived from the verified exchange origin. The host fresh-checks the interactive
  operator's `supervise` grant, the host-authenticated current manager registration proof, the open
  gate and serving epoch, the target owner, and the current retained managed row. It returns only the
  non-secret authority shape.

  The manager requires the host-issued activation receipt and independently binds every response
  coordinate and authority field to the retained inventory. Missing, malformed, substituted, stale,
  redirected, cross-origin, and widened responses fail closed.

- 6fd855f: Add a target-pinned hosted manager retirement phase that preserves host release ordering, uses the existing crash-resumable auth barrier, bounds activation to the canonical contract artifacts, and keeps remote manager maintenance on fresh host-owned admin authorization without copying host ledger state to participants.

### Patch Changes

- Updated dependencies [a9c9849]
- Updated dependencies [b0aeca4]
- Updated dependencies [348b8b7]
- Updated dependencies [9a334ae]
- Updated dependencies [18f3df0]
- Updated dependencies [9ff5c22]
- Updated dependencies [cf6ced5]
- Updated dependencies [36d1779]
- Updated dependencies [e3f2d21]
- Updated dependencies [062881a]
- Updated dependencies [159c5f0]
- Updated dependencies [c9ea091]
- Updated dependencies [5079c89]
- Updated dependencies [5395c7c]
- Updated dependencies [6fd855f]
- Updated dependencies [186fc62]
- Updated dependencies [1636927]
- Updated dependencies [dd6fea0]
- Updated dependencies [6fb1d64]
- Updated dependencies [b00f3c1]
- Updated dependencies [13f29e1]
  - @cotal-ai/core@0.49.0
  - @cotal-ai/workspace@0.49.0

## 0.48.2

### Patch Changes

- @cotal-ai/core@0.48.2
- @cotal-ai/workspace@0.48.2

## 0.48.1

### Patch Changes

- @cotal-ai/core@0.48.1
- @cotal-ai/workspace@0.48.1

## 0.48.0

### Patch Changes

- Updated dependencies [b6c843f]
  - @cotal-ai/core@0.48.0
  - @cotal-ai/workspace@0.48.0

## 0.47.1

### Patch Changes

- @cotal-ai/core@0.47.1
- @cotal-ai/workspace@0.47.1

## 0.47.0

### Patch Changes

- 0855cb7: Grade each ambient `process.env` spread on its own, and strip `COTAL_` from the user-spawn auth-service child.
  - @cotal-ai/core@0.47.0
  - @cotal-ai/workspace@0.47.0

## 0.46.0

### Patch Changes

- Updated dependencies [9d745af]
- Updated dependencies [18a0024]
  - @cotal-ai/core@0.46.0
  - @cotal-ai/workspace@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [299a353]
- Updated dependencies [38d7bb7]
  - @cotal-ai/core@0.45.0
  - @cotal-ai/workspace@0.45.0

## 0.44.0

### Patch Changes

- @cotal-ai/core@0.44.0
- @cotal-ai/workspace@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies [890d08a]
- Updated dependencies [e5412a1]
- Updated dependencies [7ff0c21]
  - @cotal-ai/core@0.43.0
  - @cotal-ai/workspace@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [a87709c]
  - @cotal-ai/core@0.42.0
  - @cotal-ai/workspace@0.42.0

## 0.41.4

### Patch Changes

- @cotal-ai/core@0.41.4
- @cotal-ai/workspace@0.41.4

## 0.41.3

### Patch Changes

- Updated dependencies [436f7d4]
  - @cotal-ai/core@0.41.3
  - @cotal-ai/workspace@0.41.3

## 0.41.2

### Patch Changes

- @cotal-ai/core@0.41.2
- @cotal-ai/workspace@0.41.2

## 0.41.1

### Patch Changes

- @cotal-ai/core@0.41.1
- @cotal-ai/workspace@0.41.1

## 0.41.0

### Patch Changes

- Updated dependencies [de258fb]
- Updated dependencies [bac1e00]
- Updated dependencies [5ec7feb]
  - @cotal-ai/core@0.41.0
  - @cotal-ai/workspace@0.41.0

## 0.40.0

### Patch Changes

- @cotal-ai/core@0.40.0
- @cotal-ai/workspace@0.40.0

## 0.39.1

### Patch Changes

- @cotal-ai/core@0.39.1
- @cotal-ai/workspace@0.39.1

## 0.39.0

### Patch Changes

- Updated dependencies [2277e28]
  - @cotal-ai/core@0.39.0
  - @cotal-ai/workspace@0.39.0

## 0.38.0

### Patch Changes

- Updated dependencies [21d9552]
  - @cotal-ai/workspace@0.38.0
  - @cotal-ai/core@0.38.0

## 0.37.0

### Minor Changes

- 9021896: Make the runtime pid/log namespace per-space. The manager and delivery daemon now record themselves
  as `.cotal/manager.<spaceKey>.pid`, `.cotal/manager.<spaceKey>.log`,
  `.cotal/manager.<spaceKey>.delivery-aware`, `.cotal/delivery.<spaceKey>.pid` and
  `.cotal/delivery.<spaceKey>.log`, through the same `{space}` expansion `auth-service.<spaceKey>.pid`
  already used. The five names were root-scoped constants, so one workspace root hosted one manager and
  one delivery daemon by filename: a second space booting in the same root overwrote the first space's
  record, and every reader of that file then answered about the wrong process. `status`, `down`, `up`,
  `clean` and `spawn -f` take the space they are answering about.

  Existing single-space meshes keep working across the upgrade. Reads admit a pre-segmentation
  root-scoped record while it is the only spelling present, byte-exact, so a `cotal down` still finds
  and stops a daemon started by the previous build instead of orphaning it. Writes are always the
  canonical space-keyed name, and each start reclaims a provably dead pre-upgrade record first, so an
  ordinary upgrade does not leave both spellings behind. A live pre-upgrade daemon is refused rather
  than overwritten, and both spellings present is reported as ambiguous rather than guessed.

  A folder-wide command reads its space off the runtime records the folder holds. `resolveRuntimeSpace`
  decodes the space out of the record filenames and prefers a space whose record is running over dead
  residue; two spaces running under one root throws and names both. The previous read came from the
  `.cotal/auth` account records, which an open mesh (`broker: { auth: false }`) never writes, so a bare
  `cotal down` in such a folder answered with the default space and walked past its own manager once the
  records became space-keyed.

  `MANAGER_PIDFILE` and `MANAGER_DELIVERY_AWARE_MARKER` move from `pid.ts` to `local-process.ts` and
  are now `{space}` templates; both are still exported from the package index. `RESERVED_COTAL_CHILDREN`
  no longer lists the five root-scoped runtime names.

### Patch Changes

- 9ff2363: Fix the boot crash-resume so a retirement whose head terminal never landed is resumed at the next auth-service boot. A crash between the barrier's last two durable writes (the gate terminal, then the head terminal) left the gate retired by the operation while the alias head stayed `retiring` — non-current and not replaceable per SPEC 13.1 — and the boot's owed-ness check, which read the gate alone, skipped that intent on every boot. The alias could never mint and could never be replaced. Owed-ness now reads the gate AND the alias head: a retirement whose gate terminal landed by its own operation resumes exactly while that operation's uid still owns a non-terminal head, re-entering the same barrier so only the head tail is finished (nothing past the gate terminal is re-revoked or re-drained); a retired head at the uid and a successor's head are the completed cells and stay skipped. A same-op despawn retry already repaired this state through the retire-lifecycle rail; the boot path was the dead letter. Adds a mutation-proofed smoke that stages the crash window deterministically and proves both repair triggers.
- 0d45f44: Reached manager-surface smokes read count, revision, and names from the shipped cluster document. The resolve-rtt probe asserts injected-wait occupancy, not wall-clock versus count times RTT.
- Updated dependencies [e5e68ed]
- Updated dependencies [c31de91]
- Updated dependencies [d4779db]
- Updated dependencies [6926b34]
- Updated dependencies [d2c0fd3]
- Updated dependencies [7e45495]
- Updated dependencies [135ddaf]
- Updated dependencies [e703873]
- Updated dependencies [6c1cefe]
- Updated dependencies [00ac9d9]
- Updated dependencies [c09d750]
- Updated dependencies [b20644b]
- Updated dependencies [74c9a1b]
- Updated dependencies [bfd650c]
- Updated dependencies [e6c6947]
- Updated dependencies [b36bf50]
- Updated dependencies [3cc980d]
- Updated dependencies [9021896]
- Updated dependencies [d94b617]
- Updated dependencies [eb3b429]
- Updated dependencies [17046ac]
- Updated dependencies [b7b932e]
- Updated dependencies [8eff985]
- Updated dependencies [b88edd9]
- Updated dependencies [063151b]
  - @cotal-ai/core@0.37.0
  - @cotal-ai/workspace@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [7c5995b]
  - @cotal-ai/core@0.36.0
  - @cotal-ai/workspace@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [4919a53]
  - @cotal-ai/workspace@0.35.0
  - @cotal-ai/core@0.35.0

## 0.34.0

### Patch Changes

- de00f4a: Retire an interactive actor lifecycle through the local auth authority plane before `cotal actor grant` rotates it or `actor revoke` removes it, so copied bearers are invalidated and later grants can create a real successor.
- Updated dependencies [22c3182]
  - @cotal-ai/core@0.34.0
  - @cotal-ai/workspace@0.34.0

## 0.33.9

### Patch Changes

- @cotal-ai/core@0.33.9
- @cotal-ai/workspace@0.33.9

## 0.33.8

### Patch Changes

- @cotal-ai/core@0.33.8
- @cotal-ai/workspace@0.33.8

## 0.33.7

### Patch Changes

- Updated dependencies [576ac7d]
- Updated dependencies [7119b4c]
  - @cotal-ai/core@0.33.7
  - @cotal-ai/workspace@0.33.7

## 0.33.6

### Patch Changes

- @cotal-ai/core@0.33.6
- @cotal-ai/workspace@0.33.6

## 0.33.5

### Patch Changes

- @cotal-ai/core@0.33.5
- @cotal-ai/workspace@0.33.5

## 0.33.4

### Patch Changes

- Updated dependencies [1858932]
  - @cotal-ai/core@0.33.4
  - @cotal-ai/workspace@0.33.4

## 0.33.3

### Patch Changes

- @cotal-ai/core@0.33.3
- @cotal-ai/workspace@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies [ffdde4d]
  - @cotal-ai/core@0.33.2
  - @cotal-ai/workspace@0.33.2

## 0.33.1

### Patch Changes

- @cotal-ai/core@0.33.1
- @cotal-ai/workspace@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [ba74c84]
  - @cotal-ai/core@0.33.0
  - @cotal-ai/workspace@0.33.0

## 0.32.0

### Patch Changes

- @cotal-ai/core@0.32.0
- @cotal-ai/workspace@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [4ef59c3]
  - @cotal-ai/core@0.31.0
  - @cotal-ai/workspace@0.31.0

## 0.30.2

### Patch Changes

- @cotal-ai/core@0.30.2
- @cotal-ai/workspace@0.30.2

## 0.30.1

### Patch Changes

- Updated dependencies [aea08f9]
  - @cotal-ai/core@0.30.1
  - @cotal-ai/workspace@0.30.1

## 0.30.0

### Minor Changes

- ef01887: Add closed, host-issued remote manager-service authority for registered user-auth participants. It requires the dedicated `supervise` scope, restricts manager registration and credentials to one owner and opaque instance, and uses a lifecycle-bound prepare, activate, and renew flow with fail-closed renewal and same-owner descendant provisioning.

### Patch Changes

- 6d03de0: The public exchange face no longer refuses a request that would have succeeded. The
  refused-exchange throttle was enforced before the request body was read, so a full bucket denied
  every request from that peer key, including callers holding a valid IdP JWT or actor token. On
  the public face the default peer key is the socket address, so in the reverse-proxy topology the
  docs recommend, every client shares one bucket and thirty unauthenticated POSTs denied the
  public mint path for a rolling minute. The gate is now evaluated up front but enforced only on a
  genuine credential failure, so a throttled peer still mints with a valid credential while a
  failed exchange is answered 429 rather than its specific reason.
- c6db901: The auth provider name is one exported constant shared by the provider and the discovery bundle, and the seam between the served document and the consumer that registers from it is now tested live.

  The auth-service's public face serves `/.well-known/cotal-mesh`, and that document is exactly what
  `cotal meshes add --from <origin>` fetches and registers from. The document's shape was fixed
  separately; what was still held only by agreement is the provider NAME. It appeared as a bare
  `"cotal"` literal at three sites, two of which are the two ends of one contract: the name the
  registered `AuthProvider` answers to, and the name the served document advertises. A document naming
  a provider other than the one serving it parses cleanly — the consumer requires a provider name, not
  any particular one — and registers an entry that resolves to nothing. Those sites now read a single
  exported `AUTH_PROVIDER_NAME`.

  The regression guard lives at the composition root (`bin/smoke/discovery-bundle-consumable`), which
  is the only tier permitted to import both the auth daemon and the CLI's consumer — the seam the
  original defect hid behind is precisely the boundary those two packages may not cross directly. It
  starts a real auth-service against a real broker and IdP, fetches the document over the wire, and
  hands the raw bytes to the shipped `checkUserBundle`. Nothing in it constructs the shape it hopes to
  see. That crossing is the part that had never existed: both sides had passed review because each
  side's own tests build the shape that side expects, so the producer's smoke asserted the fields it
  had just written and the consumer's smoke fed itself a hand-written fixture.

  The provider-name cell compares the served name against `cotalAuthProvider.name` — the registered
  provider's own identity — rather than against a string the test also chose, so it grades the outcome
  (the two names agree) instead of the mechanism (both sites read one constant). Grading the mechanism
  would pass a tree where both sites moved together, which is the failure this is for.

  Scope, stated exactly: this unifies the provider name and proves the served document parses. It does
  not change the document's shape or its fields, and registration applies further gates after that
  parse — `checkServer`, TLS intent, and the dial policy on the bundle's `server` — so a deployment
  that cannot publish an honestly dialable broker coordinate is still not registrable, and nothing
  here weakens those gates or invents a coordinate to satisfy them.

- Updated dependencies [0e673ff]
- Updated dependencies [569f4d3]
- Updated dependencies [b282f70]
- Updated dependencies [0323f5b]
- Updated dependencies [ef01887]
- Updated dependencies [196dddb]
  - @cotal-ai/core@0.30.0
  - @cotal-ai/workspace@0.30.0

## 0.29.2

### Patch Changes

- Updated dependencies [8531c13]
  - @cotal-ai/core@0.29.2
  - @cotal-ai/workspace@0.29.2

## 0.29.1

### Patch Changes

- @cotal-ai/core@0.29.1
- @cotal-ai/workspace@0.29.1

## 0.29.0

### Minor Changes

- 1f025c3: `cotal spawn` works against a mesh registered from a remote bundle. A user-mode
  agent's credentials must be granted where the space's signer lives, so a laptop
  spawn previously refused with a message about missing local material. A mesh may
  now advertise an agent-provisioning endpoint in its discovery bundle
  (`cotal up --agent-provisioning-url <https://…>`, carried as
  `userAuth.endpoints.agentProvisioningUrl`); spawn POSTs the operator's login
  bearer there, lands the returned material 0600, and runs the same bearer
  preflight before launch. A remote mesh that advertises none now refuses by
  naming that fact and the operator's remedy, instead of blaming absent local
  state. The endpoint is https-only (it receives the login bearer) and redirects
  are refused, matching the registration fetch discipline.

  The login proof itself never crosses the CLI package: the provisioning POST is
  a new optional `AuthProvider.postAgentProvisioning` seam on core's provider
  interface, implemented by `@cotal-ai/auth` — the CLI keeps its no-auth-import
  boundary.

  Also fixes `finalizeUserBundleEndpoint`, which replaced the bundle's endpoints
  object and would have dropped any sibling field the composer set.

### Patch Changes

- Updated dependencies [1f025c3]
  - @cotal-ai/core@0.29.0
  - @cotal-ai/workspace@0.29.0

## 0.28.2

### Patch Changes

- Updated dependencies [53f66c2]
  - @cotal-ai/core@0.28.2
  - @cotal-ai/workspace@0.28.2

## 0.28.1

### Patch Changes

- Updated dependencies [2a383fe]
  - @cotal-ai/core@0.28.1
  - @cotal-ai/workspace@0.28.1

## 0.28.0

### Minor Changes

- 1f44ca6: Add an optional reverse-proxy-facing auth exchange listener with generated mesh discovery, credential-based public proof, isolated throttling, and `cotal up --user-auth` configuration.
- 716f97c: The public exchange face's /.well-known/cotal-mesh bundle is now actually consumable by
  `cotal meshes add --from`: the trust pins ride a `userAuth` arm (provider "cotal", idp pins,
  pinned exchange endpoint) exactly as `checkUserBundle` records them, instead of the flat
  idp/endpoints shape the consumer refused. New `--advertised-server <url>` on `cotal up` /
  `auth-service` (with `--exchange-public-port`) sets the broker address the bundle advertises —
  what participants dial through the reverse proxy (e.g. wss://…/mesh-ws) — instead of the
  loopback/LAN address the callout itself dials.
- e26f4d1: Allow an already-granted managed agent to refresh its bearer through a pinned HTTPS public exchange URL without local auth-service state or capability material.
- 44738b2: A remotely-registered user mesh now connects with stock cotal end to end, including over a websocket broker address.

  `cotal meshes add <space> --from <url>` already landed a complete remote trust
  position (IdP pins, public exchange URL, sentinel creds); the auth provider now
  CONSUMES it at connect when no local user-auth material exists: login session →
  fresh IdP JWT → the pinned exchange's capless public face → bearer + the
  registration-landed sentinel. Nothing is discovered at connect time, the
  transport rule (HTTPS, loopback-literal http only, names get no exception) is
  checked before the IdP round trip, and every refusal names its exact remedy.

  Brokers published through an HTTPS edge are dialable as `wss://host/path`:
  core picks the websocket transport by scheme at every dial site (endpoint,
  reachability, probe), `hostPort` defaults ws/wss to the web's ports, and
  `join-target` classifies `wss://` as TLS-bearing (the handshake is the
  transport's own) while `ws://` gets exactly the plaintext fences `nats://`
  gets. The canonical server string keeps the URL path — behind an edge the
  path is part of the broker's address.

### Patch Changes

- Updated dependencies [09b6a3b]
- Updated dependencies [b8ee849]
- Updated dependencies [9216d21]
- Updated dependencies [86f6b10]
- Updated dependencies [a84cb62]
- Updated dependencies [45db9f8]
- Updated dependencies [e377c7b]
- Updated dependencies [44738b2]
  - @cotal-ai/core@0.28.0
  - @cotal-ai/workspace@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies [900f630]
  - @cotal-ai/workspace@0.27.0
  - @cotal-ai/core@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [aa1fe5f]
  - @cotal-ai/workspace@0.26.0
  - @cotal-ai/core@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0
  - @cotal-ai/workspace@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [b7cc4fa]
  - @cotal-ai/core@0.24.0
  - @cotal-ai/workspace@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [5634356]
  - @cotal-ai/workspace@0.23.0
  - @cotal-ai/core@0.23.0

## 0.22.0

### Patch Changes

- dfad94f: Fix two refusals that told an operator to run a grant which silently widened the row

  `cotal actor grant` is an upsert of the WHOLE row. Every flag the operator does not name is filled
  from the wide default: `>` read, `>` post, `spawn,role:default` scope. Two refusals printed a
  re-grant that named `--scope` and nothing else, so following either one reset the row's channel ACLs
  to everything.

  The elevated-view refusal is the sharper of the two. Asked for a view the grant lacks, it printed
  `cotal actor grant <actor> --owner <owner> --scope <current+needed>` and called that "the upsert
  replaces the scope list". An operator adding one view to a deliberately narrow row reset that row's
  read and post sets to `>` and `>` in the same paste, and the same sentence sent them to
  `cotal actor list` to confirm, where the widened row reads as confirmation that it worked. The row
  is a human operator's, and the ACL is minted fresh at every connect, so it takes effect on the next
  one with no restart.

  The missing-spawner refusal has the longer reach. Repairing a broken delegation chain, it printed
  `cotal actor grant <actor> --owner <owner> --scope spawn` and stopped, authoring a spawner that
  reads and posts on every channel. A spawner's own ACL is the ceiling every agent beneath it is
  attenuated against, so one pasted repair set a whole-plane ceiling for everything spawned under it
  from then on.

  The two doors now differ, on purpose. The elevated-view refusal has the row in hand, so it prints
  every field it is replacing, values included. The two delegation refusals have no row to copy from,
  so they print NO runnable command at all and name the flags and the wide default in prose instead:
  a line carrying channel values would invent them, and a line short of all three flags widens on
  paste. Both say what leaving a flag off means. `docs/cli.md` no
  longer tells a reader that a re-grant adds to the current scope, the `cotal actor grant` usage line
  now states what an omitted flag defaults to, and the two remaining hints that name a bare grant say
  that it is the full envelope, matching the wording `cotal login` already used.

  Both refusals are gated by cells that parse the service's own refusal string rather than matching a
  hardcoded command, so the text and the assertion cannot drift apart, and a mutation per site reverts
  each refusal to its shipped text and reddens that cell.

  The strings are not new. Every release from v0.11.0 to v0.21.0 carries all three, which is the whole
  life of the per-user actor ledger. Nothing about the on-disk row changes here, so no migration is
  needed, but an operator who followed either refusal should check the affected rows with
  `cotal actor list`: a widened row cannot be told from a deliberately full one, since the row records
  only when it was granted, not what it held before.

- Updated dependencies [57d3a57]
  - @cotal-ai/workspace@0.22.0
  - @cotal-ai/core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [4cf5f72]
- Updated dependencies [219d33c]
- Updated dependencies [9c2412c]
  - @cotal-ai/core@0.21.0
  - @cotal-ai/workspace@0.21.0

## 0.20.1

### Patch Changes

- Updated dependencies [2752fe7]
  - @cotal-ai/core@0.20.1
  - @cotal-ai/workspace@0.20.1

## 0.20.0

### Patch Changes

- @cotal-ai/core@0.20.0
- @cotal-ai/workspace@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [48c6631]
- Updated dependencies [10d9cd6]
- Updated dependencies [a1bc784]
- Updated dependencies [a7267b3]
- Updated dependencies [ce1c248]
- Updated dependencies [5e95736]
- Updated dependencies [19931dd]
- Updated dependencies [6074c26]
- Updated dependencies [24687a3]
- Updated dependencies [17f14be]
- Updated dependencies [87c4130]
- Updated dependencies [cb9e1ad]
- Updated dependencies [c038730]
- Updated dependencies [758e1e3]
- Updated dependencies [be624af]
- Updated dependencies [8572a5d]
  - @cotal-ai/core@0.19.0
  - @cotal-ai/workspace@0.19.0

## 0.18.0

### Minor Changes

- 0ab9b4d: Move the auth plane's retirement rail off the retired `ctl` surface onto the endpoint subjects

  The auth plane served its generic "retire a lifecycle" operation on
  `ctl.auth-admin.<owner>.<actor>`, a rail the spec retires in full and states must
  not be handled. Rows written onto a deleted rail are defects rather than
  exceptions to it, so the rail moves to
  `ep.one.auth.retire-lifecycle.handle.<target triple>.<caller triple>.<nonce>`
  instead of the cut growing a carve-out.

  Two things get stronger on the way. The reply is now derived from the parsed
  request, so there is no argument through which a caller- or payload-supplied
  reply target could arrive; and the request and reply planes are disjoint, so the
  listener credential cannot express a request subject at all. The per-despawn
  requester credential now pins both its caller triple and exactly one target
  incarnation, so a leaked requester cannot be re-aimed at another lifecycle.

  Serve-time authorization additionally requires that the serve registration a
  request names belongs to the requesting principal. The previous two-token
  subject could not express the caller beyond a recyclable alias, so the rail
  accepted any registered instance's registration. This is alias-level binding:
  the registration is keyed by an id that is stable across restarts and carries no
  lifecycle uid, so a same-principal predecessor presenting the current epoch is
  still accepted.

  The spec rows also described an authorization mechanism the implementation had
  already replaced, and now describe what ships.

  This is a subject-plane migration, not a completed endpoint migration. The rail
  carries the endpoint subjects but still exchanges the pre-v0.4 request and reply
  bodies, registers no service record, serves no `describe`, and has no contract
  artifact — so a generic endpoint client can neither discover nor invoke the
  command. That gap is tracked separately, with the acceptance test being that a
  generic client can do both. The one acceptance-path hole is closed here rather
  than deferred: the request carries an id, the reply echoes it, and a reply that
  does not echo is refused, so a wrong-id success cannot clear a retirement hold.

  The requester's grant pins its target with the `handle` mode, which is normatively
  redemption-minted. This path is not: there is no issuer-signed artifact, no
  redemption step, and no lineage — the row is built directly from the minting
  manager's coordinates under root authority. It is used because it is the only
  target mode that can pin an exact incarnation, and the serve-time handler
  re-checks that triple against the current mapping. This is a documented
  deviation, not compliant handle semantics, and it is stated at the mint site and
  in the ownership matrix row. It resolves with the same tracked work as the
  envelope, since the mode and the envelope are one wire-conformance surface.

### Patch Changes

- Updated dependencies [0ab9b4d]
- Updated dependencies [208ad1f]
- Updated dependencies [665b378]
- Updated dependencies [4d14037]
- Updated dependencies [f6b8b27]
- Updated dependencies [d361951]
  - @cotal-ai/core@0.18.0
  - @cotal-ai/workspace@0.18.0

## 0.17.0

### Patch Changes

- 14ff831: Stop reading another user's live process as dead.

  Asking the kernel about a process has three answers, not two: it is there, it is gone, or it is
  there but not ours to signal (`EPERM`). A two-state probe folds the third into "gone", and the
  caller then acts on a running process as if it had died.

  The repo already had a tri-state contract that gets this right, documenting itself as "consumed
  everywhere". Two production files imported it. Sixteen other production call sites probed inline,
  and **seven of the fourteen files handled `EPERM` correctly on their own while seven did not**, so
  this was a coin flip repeated fourteen times rather than one broken helper.

  Fixed, with the wrong answer named at each site:

  | site                       | what the old probe did                                                                        |
  | -------------------------- | --------------------------------------------------------------------------------------------- |
  | `manager-proc.managerUp`   | reported no manager, so `ensureManager` starts a second one onto a live one                   |
  | `delivery-proc.deliveryUp` | same, for the delivery daemon: two daemons on one fanout                                      |
  | `auth` `agent-bearer`      | "the user-auth service is not running, restart it with `cotal up`" about a service that is up |
  | `auth` provider            | same misread on the readiness path                                                            |
  | `cli ext`                  | printed "stale pidfile" about a live extension, which is advice to delete it                  |

  Both `up` functions also parsed their pidfile with `Number.isFinite`, which admits fractional and
  out-of-range values `process.kill` throws on. They now use the contract's bounded parser.

  The contract moved from `implementations/cli/src/lib/pid.ts` to `@cotal-ai/workspace`, the widest
  tier that may hold a local-process concept. **"Consumed everywhere" was never reachable and the
  claim hid the gap:** `extensions/*` peer-depend `core` only, and a pid probe is not a wire concept,
  so reaching them would mean leaking a local concern into the standard. The two extension-side
  probes keep their own copies by construction, and the module now says so instead of overclaiming.

  Presence questions require PROOF (`=== "alive"`); only destructive questions preserve on doubt
  (`!== "dead"`, which is why `down.ts` is written that way and is untouched). An earlier revision of
  this change had the presence sites preserving too, and review reproduced what that buys: a permanent,
  silent, retry-proof false-up, where the control plane reports `running: true` three times over
  against an unreachable manager. The demonstrated defect was `EPERM` alone, and widening past it was
  unforced.

  Covered by a new broker-free suite, `smoke:pid-contract`. The errno-to-state mapping is a pure
  exported function tested exhaustively, so there is no fixture to skip: the first revision reached the
  `EPERM` rule only by probing pid 1 and hoping the process was unprivileged, and as root or in a
  container that cell skipped while the suite still printed a passing banner over a deliberately broken
  implementation. The suite also drives the CONVERTED CALLERS through real pidfiles, because the first
  revision tested only the primitive and a reviewer inverted all five call sites without reddening a
  single check.

  `unknown` is REACHABLE on a real kernel, not merely under a test shim. A Linux seccomp
  `SECCOMP_RET_ERRNO` filter, or an LSM policy through `security_task_kill()`, can answer
  `kill(pid, 0)` with an arbitrary errno without executing it, and libuv preserves it. Review proved
  this with a live seccomp BPF filter and no interposition. So both ways of folding the third state
  into a boolean are wrong, and both fail SILENTLY: preserving reports a control plane that is not
  there and no retry clears it, while requiring proof launches a second manager over one that may be
  live.

  `ensureManager` and `ensureDelivery` therefore REFUSE on `unknown`, loudly, naming the pid, naming
  seccomp/LSM as the expected cause inside sandboxes, and saying what to check. `managerLiveness` and
  `deliveryLiveness` expose the state the booleans cannot carry; `managerUp`/`deliveryUp` remain
  `=== "alive"` for display, with a doc note sending any caller that ACTS on the answer to the
  tri-state.

  Honest coverage limit, stated in the suite's own output rather than implied away: no cell here
  exercises `unknown`, because no `parsePid`-accepted input produces one from this process. The refusal
  is verified by a seccomp BPF harness outside the suite.

- a74a768: Sandbox the temp root in the smokes that mint a mesh fixture there, so a `.cotal` left above the temp base (`/tmp/.cotal` on Linux CI runners) can no longer capture the fixture and make a suite grade a live mesh. One shared implementation in `bin/smoke/_scratch.ts`, used by `spawn-from-anywhere`, `down-target`, and both `ps` suites. The dead-manager cells now assert that the manager was found, was alive, and is dead, instead of skipping their own kill when the pid file is missing.
- Updated dependencies [975cad1]
- Updated dependencies [c76a49d]
- Updated dependencies [fd361fe]
- Updated dependencies [2768f5b]
- Updated dependencies [019afc3]
- Updated dependencies [3539f20]
- Updated dependencies [f85ffbf]
- Updated dependencies [141c4dd]
- Updated dependencies [14ff831]
- Updated dependencies [11cd652]
- Updated dependencies [9e13648]
- Updated dependencies [185e721]
  - @cotal-ai/core@0.17.0
  - @cotal-ai/workspace@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [531d37d]
- Updated dependencies [498055c]
  - @cotal-ai/workspace@0.16.0
  - @cotal-ai/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [f89560a]
  - @cotal-ai/core@0.15.0
  - @cotal-ai/workspace@0.15.0

## 0.14.11

### Patch Changes

- @cotal-ai/core@0.14.11
- @cotal-ai/workspace@0.14.11

## 0.14.10

### Patch Changes

- @cotal-ai/core@0.14.10
- @cotal-ai/workspace@0.14.10

## 0.14.9

### Patch Changes

- Updated dependencies [a4c082a]
  - @cotal-ai/workspace@0.14.9
  - @cotal-ai/core@0.14.9

## 0.14.8

### Patch Changes

- Updated dependencies [84f6200]
  - @cotal-ai/core@0.14.8
  - @cotal-ai/workspace@0.14.8

## 0.14.7

### Patch Changes

- Updated dependencies [12ad5e3]
  - @cotal-ai/workspace@0.14.7
  - @cotal-ai/core@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [ed62069]
  - @cotal-ai/workspace@0.14.6
  - @cotal-ai/core@0.14.6

## 0.14.5

### Patch Changes

- @cotal-ai/core@0.14.5
- @cotal-ai/workspace@0.14.5

## 0.14.4

### Patch Changes

- @cotal-ai/core@0.14.4
- @cotal-ai/workspace@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [fce3199]
  - @cotal-ai/workspace@0.14.3
  - @cotal-ai/core@0.14.3

## 0.14.2

### Patch Changes

- @cotal-ai/core@0.14.2
- @cotal-ai/workspace@0.14.2

## 0.14.1

### Patch Changes

- @cotal-ai/core@0.14.1
- @cotal-ai/workspace@0.14.1

## 0.14.0

### Minor Changes

- 7a46ce5: W4 multi-space-per-broker: split broker trust from per-space accounts and harden the broker-vs-space boundary.

  Broker trust (`operator` + system account) is now persisted once per broker in `auth/broker.json`, and each space keeps only its own data account in a flat, injective, case-safe `auth/account.<key>.json` beside it (`<key>` is hex of the space name, so two case-differing spaces can never collide on a case-insensitive filesystem). Core splits the provisioning surface to match: `createBrokerAuth` mints broker trust, `createSpaceAccountAuth(broker, space)` signs one tenant's account under it, and `serverConfig(broker, spaces, opts)` (breaking signature change) renders one operator with N space accounts.

  That same injective hex key now keys EVERY tenant-keyed namespace, not just the account file: the per-space user-auth state dir (`auth/space.<key>/`, with a one-time byte-exact rename of pre-hex layouts on first touch), the auth secret-store keys built over it (callout/issuer/owner-secret/service-keys), the machine mesh registry (`~/.cotal/meshes/space.<key>.json`, with legacy records swept on write/remove), and the auth-service pid/log files. Previously each of those case-folded, so `alpha` and `Alpha` could silently share state, registry records, and owner secrets. The hex key is injective only over well-formed strings, so the one builder now rejects a space name carrying an unpaired surrogate (which UTF-8 folds to U+FFFD, collapsing distinct names) before any key is derived. The auth-service pid/log files also carry a pre-hex-name upgrade path: `down`/`status` admit the old `auth-service.<encoded>.pid` byte-exact so an upgrade across the re-key never orphans the running user-auth callout signer, failing loud if both the old and new name are present.

  Broker-wide lifecycle operations (`down`, `clean store|all`, `backup`, `up --restore`, and the `clean restore-attempt|restore-fallback` recovery verbs) refuse on a root that hosts more than one space, naming the tenants they would have taken out, since none can be scoped to a single space. The tenant list is one validated inventory shared by the guards, `cotal status`, and the target resolver: each record's authoritative `space` must round-trip against its filename, and anything else occupying the account namespace (unparseable, mismatched, or a non-regular entry such as a symlink) counts as corrupt and makes the guards refuse rather than undercount.

  The broker record write is now two-sided fail-closed. `saveBrokerAuth` still refuses a different operator over an existing record; a same-operator system-account change is guarded by a persisted GENERATION with successor semantics: `rotateSystemAccount` bumps `BrokerAuth.gen` in memory and the write is accepted only as the direct successor of the current record, so a stale pre-rotation copy can never resurrect a retired `$SYS` (including one minted within the same second, where the JWT issue time cannot order the two; equal-generation writes with a different system account are refused, and only a byte-identical re-save is the idempotent no-op). The generation is runtime-validated on both sides and at the rotate step: only true absence reads as 0 (migration), while any present malformed value, explicit null included, refuses as a corrupt record. And with `broker.json` absent it refuses any operator that did not verifiably sign every existing account record (so a lost broker file cannot be "repaired" into orphaning the tenants; a same-operator restore still passes).

  The user-auth on-disk marker no longer keys on the bare existence of a path (which a space named `broker.json` or `creds` could alias into user-mode); it requires the provider's pin inside a real state directory, and the pin check is errno-disciplined: only ENOENT reads as absent, while EACCES and friends throw instead of silently flipping a user-auth space to static mode. The pre-hex state-dir migration refuses, rather than guesses, the one genuinely ambiguous case (a space literally named `space.<hex>`, whose legacy directory name is also another space's canonical segment).

  `cotal status` never crashes on trust material it cannot read: it reports the tenant list including corrupt records on a multi-space root, and frames any account record that will not load or compose (a malformed account JWT, or one signed by a foreign operator) as an unloadable record with repair guidance, exiting 0. Target resolution fails loud with a typed error rather than silently picking one tenant or crashing: an ambiguous-target on a multi-account root, on `--server` when the named broker's root holds several tenants on disk (one registered or not), and whenever the tenant list is unreadable; an unreadable-auth when a record cannot be composed into usable trust. The tenant inventory validates each record's account shape (so a semantically empty record is corrupt, not a phantom tenant), while the broker-binding check that a record cannot be validated without a broker stays at the consumer, keeping the broker.json-missing repair path from over-classifying every account as corrupt.

### Patch Changes

- 02b3243: feat(secret-store): move SpaceAuth (the signing authority) behind the SecretStore seam

  The space trust bundle (`.cotal/auth/auth.json`) is the last and highest-blast-radius durable secret kind. It now flows through the pluggable `SecretStore` seam, so a hosted composition injects its own KMS/Vault store and no signing seed lands on the hosted disk.

  - New `@cotal-ai/workspace` API: `getSpaceAuth(store, expectedSpace?)`, `putSpaceAuth(store, auth)`, `deleteSpaceAuth(store)`, and `SPACE_AUTH_KEY` (`auth/auth.json`), byte-for-byte the current local path under `workspaceSecretStore`. `getSpaceAuth` validates via the new `@cotal-ai/core` `validateSpaceAuthForRead`, which accepts both a full trust bundle (fully chain-validated) and a stripped signer projection (the `mint --signer`/container form — account keys validated structurally), and never echoes stored seeds/JWTs/space labels in errors. `putSpaceAuth` is the single `sys.signingSeed` strip site.
  - `remintDaemonCreds(root, expectedSpace, store?, { preflight? })` reads the signer through the same resolved store as the daemon cred; `expectedSpace` is required and validated against it. It never overwrites the last-good daemon cred with an unproven one: proof is a broker `preflight` (the manager's live probe, which gates every candidate when supplied) OR authority continuity (the candidate is signed by the same account key as the current broker-accepted cred — what the offline `doctor auth --fix` relies on). A same-label alternate account (full or stripped) is neither, so it is refused rather than clobbering the last-good.
  - The manager reads its signer from the injected `ManagerOptions.secretStore` (`getSpaceAuth(this.secrets, this.space)`); `up`, `mint`, `backup`, `restore`, `doctor`, `spawn`, and the delivery dev-mint helper go through the store. `loadSpaceAuth` remains the sync FS reader for name-only/presence callers and the static-auth single-machine mint composition.
  - `cotal clean all` deletes `auth/auth.json` through the store as its absolute-last step, so a partial-failure reset re-runs against the correct space.

  Closes "no signing seed at rest on a hosted disk"; the remaining hosted gap is signer isolation (the seed is still decrypted in-process at the manager's uid), not custody.

- Updated dependencies [02b3243]
- Updated dependencies [7a46ce5]
  - @cotal-ai/core@0.14.0
  - @cotal-ai/workspace@0.14.0

## 0.13.2

### Patch Changes

- Updated dependencies [c3afdaa]
- Updated dependencies [2ed747d]
- Updated dependencies [9625ec6]
- Updated dependencies [6960658]
  - @cotal-ai/core@0.13.2
  - @cotal-ai/workspace@0.13.2

## 0.13.1

### Patch Changes

- @cotal-ai/core@0.13.1
- @cotal-ai/workspace@0.13.1

## 0.13.0

### Minor Changes

- 5491661: v0.4 endpoint control surface: a breaking wire revision (SPEC section 13).

  Adds the endpoint control surface: the `ep` request rails and grant grammar, the
  message envelope and error catalog, the callable-service verbs, and the session
  and virtual-endpoint composites. Deletes the v0.3 `ctl` rail (the hard cut).
  Requires nats-server 2.12 or newer, since the auth marker store uses native
  per-message TTL; clients read the server version from the pre-auth INFO and fail
  loud below the floor.

  Completes the agent lifecycle end to end: registration, admission, despawn,
  retirement, and safe name reuse, backed by a lifecycle registry, a credential
  ledger, and a retirement barrier. Durables are keyed by lifecycle uid, so a
  manager-resumed agent recovers its original incarnation rather than re-minting,
  and readiness is incarnation-exact. The connectors forward the lifecycle uid into
  spawned children so a child joins as its intended incarnation.

  From v0.4 an AgentCard MUST advertise `protocolVersion "0.4"`; a participant that
  omits it is treated as pre-0.4 and is not addressed on the endpoint rails.

### Patch Changes

- Updated dependencies [5491661]
  - @cotal-ai/core@0.13.0
  - @cotal-ai/workspace@0.13.0

## 0.12.0

### Minor Changes

- 4e0e641: Add the pluggable `SecretStore` seam (core `get`/`put`/`delete` contract + filesystem default) and route the durable hosted secret kinds through it: the delivery daemon creds and the auth store's callout account, issuer keys, owner secret, and service-key projection. Local `cotal up` is unchanged (the workspace `.cotal`-rooted filesystem store lands byte-for-byte on the existing paths); a hosted composition injects its own backend via `runAuthService`/`runDelivery`. `AuthProvider` methods now take a caller-composed `store`, and the new required `deprovisionSecrets` plus `clean all`'s seam-first ordering make a full local reset safe against split authority.

### Patch Changes

- Updated dependencies [be66729]
- Updated dependencies [47d2584]
- Updated dependencies [4e0e641]
  - @cotal-ai/core@0.12.0
  - @cotal-ai/workspace@0.12.0

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
