# @cotal-ai/linear

## 0.95.0

No changes in this release.

## 0.94.7

No changes in this release.

## 0.94.6

No changes in this release.

## 0.94.5

No changes in this release.

## 0.94.4

No changes in this release.

## 0.94.3

No changes in this release.

## 0.94.2

No changes in this release.

## 0.94.1

No changes in this release.

## 0.94.0

No changes in this release.

## 0.93.0

No changes in this release.

## 0.92.2

No changes in this release.

## 0.92.1

No changes in this release.

## 0.92.0

### Minor Changes

- 88cc5a1: A Linear account with no record now refuses with `TARGET_NOT_FOUND` and the `cotal linear account add` route, in `linear account show` and when a `linear` service starts. The service refuses in its launch plan, so no child is started and no failed process exit is reported. A record that exists but cannot be read is still `DEPENDENCY_UNAVAILABLE`. The service checks the account in the Cotal home of the process that starts it, and refuses with `UNSUPPORTED` before a child when `COTAL_HOME` is unset and the definition's `envRefs` set `HOME` (on Windows, `LOCALAPPDATA` or `USERPROFILE`), because the child could read another home. A service adapter's launch hook now receives the definition's `envRefs` names, never their values. The endpoint name is checked when the service starts.

  `cotal update --check` and the version read in `cotal update` run npm with a temporary cache that is removed afterwards, no log files and no npm update notifier, so they leave nothing in npm's cache, log directory or notifier stamp. From a source checkout, the `update --self` hint says it installs a separate global copy.

  `service add --preset` offers no `--no-<option>` flag for a boolean option whose schema admits only true, so the web preset no longer lists `--no-read-only`. An absent `web` preset names `cotal ext add @cotal-ai/web` in its remedy. A background `service start` ends with the `service logs` command for the new instance. Re-adding an existing definition names the remove-and-add route, and an `ext remove` blocked by service instances names each one. A managed dashboard logs an endpoint error or warning by its class, the error's name and code, and never its message.

## 0.91.0

### Minor Changes

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

### Patch Changes

- 3deea9d: Name the mesh before and after more operations. `service stop`, `service restart` and a named service-set stop now begin the impact they show for review with `Mesh: <space>`, as `down` does. The `space delete` and `reset space` previews, the manager gate repair review, the foreground notices of `up`, `team boot` and `service start`, the attach picker's partial-list notice and setup's agent-joined notice name the mesh too. A classified failure raised after a command resolved its space now carries that space in `target.space` and begins with `Mesh: <space>`, even when the failing step named no space. A target that already names a space is kept as it is.

## 0.90.1

## 0.90.0

## 0.89.0

## 0.88.0

## 0.87.0

### Patch Changes

- 45855d6: A Linear token or OAuth state file on Windows is no longer refused as "readable by other users (mode 666)". Windows reports every file's POSIX mode as 666, so the check refused every token-mode account there, including token files Cotal wrote itself. The mode check now applies only where POSIX modes exist, as for the broker TLS key and launch material; on Windows the file's privacy is the ACL Cotal sets when it writes the file.

## 0.86.0

## 0.85.0

## 0.84.0

## 0.83.0

## 0.82.2

## 0.82.1

## 0.82.0

## 0.81.1

## 0.81.0

## 0.80.0

## 0.79.0

## 0.78.1

## 0.78.0

## 0.77.1

## 0.77.0

## 0.76.0

## 0.75.0

### Patch Changes

- d269d1d: Core exports `serviceContractTable(rows)`, which builds a service's command contracts, compiled on first access, and the schema artifacts its registration publishes. The auth, manager and Linear service contracts call it instead of carrying their own copies of the lazy table and the artifact loop, so a fix to either reaches all three. Importing a contract module still compiles nothing, and the published artifacts and the behaviour of `AUTH_CONTRACTS`, `MANAGER_CONTRACTS` and `MANAGER_STATUS_CONTRACT` are unchanged.

## 0.74.0

### Minor Changes

- 328d59b: Add `@cotal-ai/linear`, which serves the official Linear MCP server as a registered Cotal endpoint that agents can call. `cotal linear serve <account> --endpoint <reverse-dns-name>` registers a fresh endpoint instance on a static-auth mesh through the ordinary registration path (contract store, issuance gate, registration barrier, serve grant, ready status, fenced serve credential), renews the serve credential, and removes the service record on shutdown. The endpoint name comes from operator configuration. `cotal linear caller` provisions an isolated hand-launched caller whose credential names only the five Linear commands. Per-user-auth meshes are refused rather than signed locally. Hosted embedders can use `runLinearEndpoint` with their own authorized serve bundle.

  The endpoint pins the two official Linear servers (`/mcp` and `/mcp/readonly`), takes an API key from stdin or a private file or runs Linear's OAuth login, and forwards tool, resource, prompt and completion requests without retrying. One deadline bounds queueing, discovery, connect and the call. A dispatched request that times out, is cancelled, overflows, loses its session or gets HTTP 401, 403 or 429 reports outcome `unknown`. `inventory` is paged under the broker message size, keeps every entry verbatim, and binds its cursors to the inventory digest, refusing a stale pin before anything reaches Linear.

  `@cotal-ai/core` adds `CotalEndpoint.describeService`, which returns the digest-verified surface from the same cache `invokeService` uses. `@cotal-ai/connector-core` adds the generic `cotal_describe` and `cotal_invoke` agent tools, which run on the agent's own connection and grants.
