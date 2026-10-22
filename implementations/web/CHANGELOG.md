# @cotal-ai/web

## 0.92.0

### Minor Changes

- 88cc5a1: A Linear account with no record now refuses with `TARGET_NOT_FOUND` and the `cotal linear account add` route, in `linear account show` and when a `linear` service starts. The service refuses in its launch plan, so no child is started and no failed process exit is reported. A record that exists but cannot be read is still `DEPENDENCY_UNAVAILABLE`. The service checks the account in the Cotal home of the process that starts it, and refuses with `UNSUPPORTED` before a child when `COTAL_HOME` is unset and the definition's `envRefs` set `HOME` (on Windows, `LOCALAPPDATA` or `USERPROFILE`), because the child could read another home. A service adapter's launch hook now receives the definition's `envRefs` names, never their values. The endpoint name is checked when the service starts.

  `cotal update --check` and the version read in `cotal update` run npm with a temporary cache that is removed afterwards, no log files and no npm update notifier, so they leave nothing in npm's cache, log directory or notifier stamp. From a source checkout, the `update --self` hint says it installs a separate global copy.

  `service add --preset` offers no `--no-<option>` flag for a boolean option whose schema admits only true, so the web preset no longer lists `--no-read-only`. An absent `web` preset names `cotal ext add @cotal-ai/web` in its remedy. A background `service start` ends with the `service logs` command for the new instance. Re-adding an existing definition names the remove-and-add route, and an `ext remove` blocked by service instances names each one. A managed dashboard logs an endpoint error or warning by its class, the error's name and code, and never its message.

### Patch Changes

- 35754dd: A `web` dashboard service whose port is already in use now releases its PID slot before it exits. Before, the slot stayed held after the failed start, and every later `service start` in that space refused with `LIFECYCLE_BLOCKED` until `cotal down` cleared it.

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

- 5c85ef3: Commands share one structured output contract, and every command takes `--no-color` and `--no-input`.

  - `cotal version --json` (or `-j`) writes one JSON document on stdout: `schemaVersion` 1, the command, a `null` target, the outcome, completeness, the result (the version and each installed extension's), and warnings. A usage error under `--json` is one `refused` document with code `USAGE_INVALID` and a remedy, and the help it names stays off stdout. A command with no JSON output refuses `--json` as an unknown option.
  - A command that declares a JSON output exits by its outcome: 0 for ok or no-op, 1 for a usage refusal, 2 for a refusal at a known boundary, 3 when the outcome is unknown, 4 for partial, 5 for failed. An error such a command does not classify is unknown. Other commands keep exiting 1 on any failure.
  - `@cotal-ai/workspace` exports the envelope and NDJSON record types, the stable error codes, the outcome-to-exit table, and `CommandFailure`, which keeps an endpoint's own code and outcome under `error.cause`.
  - `--no-color` turns color off for that run, including the setup prompts and the console, whatever `FORCE_COLOR` says; the programs it starts are no longer forced into color by `FORCE_COLOR`. `--no-input` means no prompt, editor or browser: a prompt behaves as it does without a terminal, `cotal web` prints its link without opening it, and `cotal personas edit` is refused. `--json` implies `--no-input`. Both flags work before the command word, and after it on any command that does not take its words raw. No command may declare either name: an installed extension command that does is an internal error, and `cotal` exits 1 before running any command.
  - `cotal console` now follows a non-empty `NO_COLOR`, as the rest of the CLI does.

- 15c96da: The `rootedAt` field is gone from the local-process extension contract. Nothing has read it since the
  dashboard became a service, and the web extension no longer sets it. An extension that still declares
  it has the field dropped from its cached descriptor, like any other unknown field.

### Patch Changes

- b4f985a: `cotal down --dry-run` in a folder with no stack now refuses with `TARGET_NOT_FOUND`, exit 2, and says there is no stack at the folder's root to preview. A root with no `.cotal/` directory, or with no stack registered at it, counts as no stack. It used to refuse with `CONFLICT` and say the local records could not be inspected consistently, which suggested damaged state in a folder that simply held none. A symlinked `.cotal/`, an ambiguous registration and unreadable records still refuse with `CONFLICT`. Source comments in the CLI, delivery and web packages that described per-component `cotal down` stops now describe the stops that exist.
- 0e40d19: Files written in place under `~/.cotal` or a project's `.cotal` are no longer written through a symlink. The manager's own delivery-aware marker, the `agent-bearer` health file, the onboarding marker, the `setup` log and personas, the web session file and detached log, the feedback store, persona files saved by `saveAgentFile`, the seat custody record, payload, exit record and log, the Claude seat home and plugin marketplace, the Codex host log, the Jcode launch record, the `ext` extensions prefix `package.json`, and the isolated broker's config rewrite and watchdog now refuse a symlink and leave it unchanged. A file rewritten in place is set to `0600` through the open file. `hardenPrivate` on a file now uses the same no-follow descriptor. A directory is still hardened to `0700` by its path, so a symlinked `~/.cotal` or `.cotal` is not refused there. The manager and native service custody no longer chmod their pid records by path, since those are created `0600`. The broker ports report refusal names the report's path, and a failed close no longer hides it.
- 964aaea: `cotal status` and `cotal status --components` read a service-run dashboard's address from its own session record. A dashboard started with `cotal service start` writes that record beside its service startup receipt and never writes `web.session`, so status found no bound address and graded a live dashboard `refused`. The holder of `web.pid` now picks the record: the web service instance whose recorded process is that PID names its own session record, and any other holder is read from `web.session`. Neither record is read in place of the other. The components row names the instance as `service instance <id>`.

## 0.90.1

## 0.90.0

## 0.89.0

## 0.88.0

## 0.87.0

## 0.86.0

### Patch Changes

- 2779b21: The web events-filter smoke's call-site cell now counts every mention of `chatOnly` in the web server and expects three, the declaration and its two calls. It used to count only `chatOnly(`, so a third call written with a space, a line break, type arguments or `?.(` left it green. No behavior changes.
- 1eaf6e3: `cotal status --components` now names the HTTP status when the web dashboard's address answers `/api/meta` with a status outside 2xx, such as `HTTP 401`. It used to read the body first, so a plain-text or empty refusal printed `http not answered`. The status row and `cotal web --detach` now send one shared readiness request from `@cotal-ai/workspace` and read its answer the same way. That request no longer follows a redirect, so the readiness header goes only to the recorded address and a 3xx answer is reported as its status, such as `HTTP 302`, where both used to follow it and accept the identity the redirect target answered with.
- 34443e9: The dashboard's static route now reads a page file before it writes the status line. A missing or unreadable file used to be answered with `200`, `cache-control: no-cache` and an empty body, because the read failed after the status was already sent, so the browser ran an empty script and the page failed later with an unrelated message. It is now answered with the request handler's `500` naming the failed read. Successful responses keep their headers, and the session check still runs before the route.

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

### Patch Changes

- 4c2379d: `cotal console` and `cotal join` now print a seat's harness-reported condition and its ages the way `cotal endpoints` and `cotal status` do. The console roster, NEEDS YOU rail and detail pane, the `--plain` line stream, and the `cotal join` presence lines, `Present:` line and `/who` show `waiting (rate_limit for 40m) · unchanged for 5s · active 40m ago` and the activity's `(set <age> ago)` instead of a bare `waiting`. The roster and each NEEDS YOU card put the status and these facts on rows of their own under the seat's name, wrapped to the pane's width at any terminal size, so neither a long name nor a narrow terminal cuts them and they no longer push the activity out of view. A seat that needs more rows than a short terminal leaves its pane takes the title's row and is cut at the bottom, keeping its name row, and Enter opens its detail pane with every fact. The console's ages use the shared compact format, so a heartbeat nine hours old reads `9h` rather than `540m`, and an age floors rather than rounds.
- 92590e8: The web dashboard's pidfile name is now one `WEB_PIDFILE` constant in `@cotal-ai/workspace`. The dashboard declares its record with it, and the `cotal status` `Web process` row, `cotal status --components`, the `cotal setup` card and the `cotal clean all` crash-residue sweep read it from there. They used to spell `web.pid` by hand, so renaming the dashboard's record would still typecheck while those readers reported a running dashboard as down or absent and `clean all` left its pidfile behind. The file is still `.cotal/web.pid`.

## 0.78.1

## 0.78.0

### Patch Changes

- 261e48c: When a detached web dashboard does not become HTTP-ready before the deadline, the timeout error now ends with the outcome of the last readiness probe: the probed `api/meta` URL and the fetch error, the HTTP status, or the space and pid the server answered with. Before, every probe failure was swallowed and the error said only that the dashboard timed out, so a refused connection, a rejected request and a different process on the port all looked the same. The retry cadence and the deadline are unchanged. A mismatched space or pid is summarized with bounded fields and the URL and outcome after `; last probe ` are capped at 300 bytes, counting the `...` that marks a cut, so whatever answers the port cannot inflate the error.

## 0.77.1

## 0.77.0

## 0.76.0

### Patch Changes

- 42b28aa: `cotal status --components` now names a `web.session` that exists but cannot be read, for example after an ownership or mode change: the web row reads `refused · web.session unreadable: <error>`. The reader used to treat every read error as no record, so a live dashboard read `refused · probe refused (no bound address recorded)`, and the `Web process` row and the `cotal setup` card read `down`. Those two rows now name the unreadable record as well. Only a missing, empty or partial `web.session` still reads as no record. `cotal web --detach` prints the launch link from the record that proved the dashboard ready instead of reading `web.session` again, so a read error after that point cannot report a failed start over a running dashboard.

## 0.75.0

### Patch Changes

- 92e7846: The comments on the dashboard's activity aggregation and its `/api/membership` route, which ship in `dist/web.js` and `dist/web.d.ts`, now state the aggregation deadline, the concurrency bound, the two named partial sources and the membership read's 503 as the current contract. They narrated earlier revisions ("used to", "no longer", "this change", "since #1210"), and the `/api/activity` comment drops corpus measurements that set no constant. No runtime change.
- 343c1ea: `cotal web` now judges an existing `web.pid` with the workspace's `parsePid` and tri-state `probeLiveness`, as `cotal down web` does. It calls the record stale and points at `cotal down web` only when the file is empty or its pid is proven gone. Content that is not a pid (`abc`, `12.5`, `0`, `-1`, an out-of-range number), or a pid whose liveness the kernel will not report, is now refused as possibly fronting a running process. Before, the dashboard called it stale and advised a cleanup that `cotal down web` then refused. An extension-removal reservation in `web.pid` is judged by the same rule. A detached launch also no longer reads an unconfirmed liveness answer as its child having exited, so termination signals the child instead of skipping it.
- 2a06543: The dashboard's console and graph pages now escape peer-supplied text through one HTML escaper shared from `parts.js` instead of a copy each, so the two can no longer drift. A missing value now renders as empty text on the console page as it already did on the graph, where the console used to show the words `null` or `undefined`.

## 0.74.0

## 0.73.0

## 0.72.1

## 0.72.0

## 0.71.0

## 0.70.2

## 0.70.1

### Patch Changes

- 9788b5e: The doc comments on the dashboard's refusal reasons and on `makeAuthGate`, which ship in `dist/web.js` and `dist/web.d.ts`, now state the gate's current contract. They said the surface authenticated nobody and that a page in the operator's browser could reach the mesh reads and the channel delete, which described the dashboard before its authentication gate existed. No runtime change.

## 0.70.0

### Patch Changes

- 60328b2: Source comments that sent readers to docs pages retired in the docs restructure now name the current pages. The `MeshView` header points at `docs/mesh-view.md`, and the console space picker and the web dashboard's Agent Detail frame point at `docs/watch-a-mesh.md`. These comments ship in the built packages, and `docs/protocol-view.md` and `docs/web.md` no longer exist.
- a8f2f38: The dashboard escapes `"` in peer-supplied text. A peer whose activity contained a double quote could close the roster row's `title` attribute and add attributes of its choosing to that row in every dashboard watching the space. The same escaper fills the other double-quoted attributes on the page, such as agent ids, channel keys and the harness badge title, so they are covered too.
- 020138b: The web dashboard now writes the `web.pid.identity` pin beside `web.pid` when it claims its pidfile, and removes both when it exits. `cotal down web` used to read every dashboard record as one that predates identity pinning: it warned that a relaunch would pin it, which no relaunch did, and signalled the recorded pid with no identity check, so after a SIGKILL left `web.pid` behind it would signal whatever process had reused that pid. A dashboard's record is now verified like the broker's and the daemons', and a reused pid is refused and preserved.
- 906de06: `cotal web` now refuses a `--port` that is not a decimal number from 1 to 65535 before it connects to the broker or claims the dashboard pidfile, with an error that names `--port`. `--port 0` used to bind an ephemeral port while the printed link, the recorded launch link and the console's allowed Origin all named port 0, and a detached launch probed port 0 until it timed out. A hex or exponent spelling such as `0x1f90` was accepted, and `abc` or `70000` failed only after connecting, with `Invalid URL`. An empty `--port` no longer falls back to 7799.
- 668f6b0: The web dashboard's `web.session` record and its `x-cotal-readiness` header now have one definition, in `@cotal-ai/workspace`: the file name, the record's fields, the one reader, and the header name. The dashboard writes and reads the record through it and `cotal status` reads it there. Renaming the file, a field or the header on the dashboard side used to typecheck cleanly while `cotal status --components` read the live dashboard as `refused` and the `Web process` row read `down`; now it is a compile error on both sides.

## 0.69.0

## 0.68.0

### Patch Changes

- e6b48bf: `cotal status --components` now presents the dashboard's readiness nonce from `web.session` when it probes `/api/meta`, so a live dashboard at its recorded address grades `web serving`. The probe used to ask anonymously, the dashboard's auth gate refused it with 401, and the row could only read `not-serving · http identity mismatch`.
- f2af439: The dashboard's channel-delete route comment now names the cred it purges with: the `channel-purger` cred minted at startup, the connection creds on open and `--creds` meshes, or a per-delete `channel-purger` view in user mode. It used to name a `manager` cred that no longer exists. The observer's `tls` comment now states only why the client's own TLS requirement is the fence, without narrating the change that added it. No behavior changes.

## 0.67.0

### Patch Changes

- cefb3c7: `cotal web` on the default host and port now prints its launch link a second time at
  `http://127.0.0.1:7799/`, carrying the same single-use token, so a browser or system resolver with
  no answer for `cotal.localhost` (Safari, WSL2) still has a printed way in.
- 35504fe: The dashboard's ONLINE roster now groups live peers by the machine each one reports as its host (`card.meta.host`), with a count per machine, so an operator can see where seats run and how they are spread across machines without opening each agent. A peer that reports no host, such as a manager, is listed last under "host not reported". Seats do not report which manager runs them, so there is no manager grouping yet.

## 0.66.1

## 0.66.0

### Patch Changes

- 3808751: `cotal status --components` now probes the web dashboard at the address the dashboard bound. The dashboard records its socket's host and port in `web.session` once it is listening, and status reads that record. Before, status parsed `--host` and `--port` out of the dashboard's command line and fell back to `127.0.0.1:7799`, so a port spelled any way other than plain digits (`--port 0x1f90` binds 8080) was probed at 7799, and `--port 0` was refused as an invalid port while the dashboard listened on an ephemeral one. A live dashboard pid with no readable recorded address, including a dashboard still writing its record and one started by an earlier build, is now `refused` with `no bound address recorded`.

## 0.65.0

### Patch Changes

- d5cf1eb: `cotal web --detach` on the default host and port now comes up on hosts whose system resolver has no answer for `cotal.localhost`, such as WSL2. The detached parent probed the branded `http://cotal.localhost:7799/` for readiness through Node's resolver, so every probe failed while the child was already serving on 127.0.0.1:7799; after 30 seconds it reported `web dashboard did not become HTTP-ready`, stopped the healthy child, and left only the banner in `web.log`. The readiness probe now asks the bound host and port. The printed address is unchanged.

## 0.64.0

## 0.63.0

### Patch Changes

- d8c557c: The web dashboard now binds the account seed only inside the step that connects and mints its channel-purger cred. Before, the full connection, seed included, stayed in scope of the request handlers beside the narrowed copy they were meant to use, so a one-word edit in a handler could reach the seed and still compile. A handler that reaches for the seed now fails to typecheck.

## 0.62.0

## 0.61.0

## 0.60.0

## 0.59.0

### Patch Changes

- f5cbc2d: `docs/watch-a-mesh.md` now quotes the all-activity deadline reason as the server builds it, `the read did not finish within <deadline>ms`, and states the 8000 ms default in its prose. The page quoted the concrete `8000ms`, which no shipped source string holds, so the docs literal gate failed on every branch.
- 5d98406: The dashboard's all-activity page now says why each missing source is missing. A partial page carries `reasons`, keyed by source, and the server's partial line and the page's stale marker repeat it. A read the deadline cut says it did not finish within the deadline, and a read that was refused says so with its error, so a chat read refused for exceeding the broker's `max_payload` no longer looks the same as one that ran out of time.
- d5e20e0: The dashboard's all-activity backfill now records its ordering rule where the page is sorted and in the dashboard docs. The chat half is the newest messages by broker arrival, the merged page with direct messages is ordered by the sender's `ts` because that is the only key the two streams share, and messages with equal `ts` keep stream order with chat before direct messages. Behaviour is unchanged.
- 608f5f4: Re-attach doc comments that had drifted away from the declarations they document. A `/** */` block followed directly by another one documented nothing, so editor hovers and the published type declarations showed no doc for the intended declaration (for example `Manager`, the `plane3` field and `AclResolver`). Each such block now sits above its declaration, is merged into the block it duplicated, or is removed when its declaration no longer exists. A new `pnpm check:doc-comments` check, run as part of `check:docsbundle`, refuses a doc block followed directly by another in shipped source.

## 0.58.0

## 0.57.0

## 0.56.1

## 0.56.0

### Patch Changes

- 99cad7b: A membership watch that closes after setup now reaches its caller through a second callback on `watchMembership`, instead of leaving the caller holding a stale snapshot with no signal. The dashboard broadcasts the existing membership-read-failed event and the console marks the feed unreadable, instead of both keeping the last snapshot silently (#485).
- 03912bb: Close the connection an auth-gate refusal rides on when the request announced a body, so an unauthenticated caller cannot hold the dashboard reading an upload it refused (#2024)
- 4f288bd: Move the two header reads that compute the announced-body fact below the auth gate, so the pre-gate prefix stays a parse and nothing else; refusal bytes and the no-body guard are unchanged (#2178)

## 0.55.0

### Patch Changes

- e1351c2: Take a DM sender's display name and role from the roster by authenticated id instead of the message payload, so one peer cannot spoof another's name or role in the CLI DM lens or the web feed.
- 8c037f5: Refuse announced request bodies on dashboard routes that do not read one before the server accepts the upload.

## 0.54.0

## 0.53.0

## 0.52.1

## 0.52.0

## 0.51.0

## 0.50.1

## 0.50.0

## 0.49.0

## 0.48.2

## 0.48.1

## 0.48.0

## 0.47.1

## 0.47.0

## 0.46.0

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.4

## 0.41.3

## 0.41.2

## 0.41.1

## 0.41.0

### Minor Changes

- de258fb: `/api/activity` reads all of chat in one stream read instead of one read per channel. The CHAT
  stream already interleaves every channel into one sequence space, so the newest N across the space
  is the tail of that one stream. The new `CotalEndpoint.multiChannelHistory(channels, opts)` reads it
  with a single consumer whose `filter_subjects` are those channels, and tags each message with the
  channel the broker delivered it on rather than with the payload's own claim. A channel left out of
  the list is filtered by the broker and never crosses the link, so the dashboard's chat-only rule now
  decides the read's filter set instead of deciding which of seventy reads to issue. No new broker
  authority: a multi-filter create rides the bare `$JS.API.CONSUMER.CREATE.<CHAT>` row the observer
  and admin profiles already hold.

  The multi-filter read batches its filter list. One consumer create naming every subject is a single
  request, but a large enough request stops being answerable: on a seeded sweep the create succeeded
  at 70, 1,000 and 5,000 channels and failed at 10,000, and what gives way is the client's request
  timeout rather than the broker. `MULTI_FILTER_BATCH` is 1,000 and `MULTI_FILTER_READ_CONCURRENCY` is
  4, so the list is split and at most four batches are in flight, and the pages are merged by stream
  sequence before the newest N are taken. The size comes from the sweep rather than from the failure
  point: a fifth of the largest count that still answered, answering in about a quarter of a second, so
  a batch stays far from both the create timeout and the 8000ms response deadline. On the same corpus
  the sweep goes from 43ms, 246ms, 5345ms and a timeout, to 54ms, 343ms, 1163ms and 942ms. Those walls
  are single runs on one host and are shaped by it rather than being bounds; a re-run on another box
  landed outside the last of them, as the paragraph below says of every span here. A space
  with the 69 chat channels this work was aimed at is one batch, so the request counts and byte totals
  are unchanged at that size. The walls are not claimed to be, for the reason just given.
  Merging on stream sequence rather than the payload's `ts` is asserted in
  `packages/core/smoke/history-recent.smoke.ts` against a corpus whose arrival order and `ts` order are
  opposite.

  Two limits remain and are stated rather than buried. On a 20,000 channel and 20,000 message corpus
  the batched read still fails at 5,000 filters and above, because batching removes the create size
  ceiling and not the cost of a batch matching a small fraction of a long stream; no unbatched
  numbers were taken on that corpus, so no comparative claim is made about it. Separately, a filter
  list big enough to exceed the connection's `max_payload` is refused by the client before anything
  is sent, rather than by the broker and rather than timing out: the client compares the request
  against the limit the broker advertised at connect and throws, so no bytes leave and the broker's
  own logs show nothing. A list of 40,000 filters on this corpus's subject shape is refused that way.
  Where the limit falls moves with both the advertised `max_payload` and the length of the subjects,
  so 40,000 is a length that was tried and not a threshold.

  Measured on the wire by a proxy between the endpoint and the broker that counts `$JS.API` request
  lines and bytes per direction, over a seeded corpus of 69 chat channels plus 24 event channels at
  limit 200. The before column is that same committed suite file, with its `package.json` script,
  copied onto a `544a974b7` checkout and run there, so it measures the old code with the new
  instrumentation: 2524 broker requests and 8,015,332 to 8,016,039 bytes across four runs to return a
  143,401-byte page. After: 143 requests and 908,410 to 908,422 bytes across eight runs, for the same
  200 entries in the same order, and consumer creates fall from 347 to 6.

  The counts are the stable claim and the walls are illustrative, and the two halves of that sentence
  have different evidence. On the completed no-link arms the request counts, the consumer creates and
  the page size are identical in every run, while the byte totals move by tens of bytes. The
  field link's two arms behave differently and the sentence has to say which. Its fan-out arm is
  truncated by the deadline, so its requests, creates and bytes vary with the clock: 794 to 849
  requests and 128 to 133 creates across thirteen runs. Its single read completes, and keeps the same
  143 requests and 6 creates it spends with no link cost, in every run. Walls vary on one host by more than the counts do. Across an 82ms RTT / 554 KB/s
  link with the shipped 8000ms deadline, the fan-out answered 16 of 70 sources in every run and timed
  out, and the single read answers whole in 4304ms to 4637ms across nine runs. On the same link the pre-change tree spends 768
  to 793 requests and 2,085,533 to 2,364,182 bytes across four runs to reach those 16 sources.

  Every span here is what its runs covered on one host. None of them is a bound. A reviewer ran the
  suite four more times while this was under review and landed outside eight of the spans as they then
  stood, by a byte or two on the totals and by tens of milliseconds on the walls, and the spans below
  have been widened to include those runs. Expect the next run to do it again. What does not move, in
  any run by anyone so far, is the request counts, the consumer creates and the page sizes of the
  completed no-link arms, the 143 requests and 6 creates the single read also spends on the field
  link, and the number of sources each field-link arm reaches: 2 of 2 for the single read, 16 of 70
  for the truncated fan-out. The fan-out's request and create counts are not in that set, because the
  deadline truncates them. 24 of 70 belongs to the pre-change tree's uncapped fan-out and to nothing
  at this head, which completes at 2 of 2 uncapped on the same 143 requests. The argument rests on the
  figures that do not move.

  `pnpm smoke:web-activity-read-cost` reproduces the after column, and beside it a frozen copy of the
  old fan-out shape as a scale-invariance control, which costs 2863 requests and 7,743,782 to
  7,744,228 bytes across eight runs. That
  arm runs the old shape on this build's one-page window, so it is a control and not the shipped
  before; the before column is the same suite run against `544a974b7`.

  History reads now open their first window one page wide instead of four. `drainWindow` delivers
  everything in the window and keeps the tail, so a four-page window moved four pages to return one
  whenever the subject was most of its stream. `/api/dms` at limit 500 against a 2500-message backlog
  moved 1,995,854 to 1,995,859 bytes across four runs to return a 346,001-byte page, at 257 requests
  every run, and took 8161ms to 8753ms alone on that link. Every one of those four runs missed the
  8000ms deadline with nothing else on the connection. An earlier draft published 8852ms and 7857ms
  here and called the read a straddle; 7857ms is below every run I can now produce, so the straddle is
  withdrawn and the read simply misses. It now moves 502,354 to 502,359 bytes with no link cost across eight runs,
  and alone on the field link takes 2532ms to 2858ms across twelve runs while moving 502,361 to
  502,365 bytes. Those are two different arms of the suite and the split is deliberate: the byte
  figure a reader should compare against the before column is the no-link one. A sparse subject pays
  one more widening step for that.

  `multiChannelHistory` refuses a channel name the wire layer would rewrite. `chatSubject` builds each
  filter through `token()`, which maps an unusable character to `_`, trims each segment and drops
  empty ones, so `foo/bar` would have filtered on `foo_bar` and `.lead` on `lead`: the caller names one
  channel and the broker returns another. `isConcreteChannel` does not catch it, because none of those
  carry a wildcard. The read now runs the same `assertValidChannel` the policy path already used
  against this aliasing, before it builds the subject. The dashboard passes canonical `listChannels()`
  rows and never reached it; the public method and its exact-filter promise did.

  `ActivitySource` (the seam `activityBackfill` reads through) replaces `channelHistory` with
  `multiChannelHistory`. The aggregation now has two sources, chat and DMs, so a partial page names
  which half is missing rather than naming individual channels.

  **The activity feed selects different messages under clock skew, and an operator can see it.** The
  page is the newest `limit` chat messages by broker arrival, unioned with the newest `limit` DMs,
  ordered by `ts`. The shape it replaces took the newest `limit` per channel and then the newest
  `limit` of that union by `ts`. With two channels and `limit=2`, channel A holding a1 (seq 1, ts 100)
  and a2 (seq 2, ts 200) and channel B holding b1 (seq 3, ts 50) and b2 (seq 4, ts 60), the old rule
  returns a1 and a2 and the new rule returns b1 and b2. They disagree whenever a sender's clock
  disagrees with arrival order by more than the spread between the `limit`-th and `limit+1`-th message.
  The display order is unchanged, since the page is still sorted by `ts`; what changed is which
  messages reach it. Arrival is the broker's own record and `ts` is a sender claim, so the new key is
  the narrower one. Per-channel selection cannot be had from a single read at any window short of one
  that has seen `limit` messages from every requested channel, since a quiet channel's newest can sit
  arbitrarily far back in an interleaved stream. That is a property of the mechanism rather than a
  measurement, and it is why the old selection was not kept.

### Patch Changes

- bac1e00: Distinguish an unpopulated presence watch from a current roster.

  `presenceView()` now returns a discriminated `current`, `unpopulated`, or `stale` state. An
  unpopulated reconnect refill carries `fresh: false`, so existing consumers fail toward unknown
  instead of treating a partial roster as an authoritative absence verdict. `waitForPresenceSnapshot()`
  now reports whether the snapshot completed or the bounded wait timed out.

  The web dashboard surfaces an unpopulated roster as still loading and keeps the existing stale-watch
  diagnostic for a view that was populated and later went silent.

## 0.40.0

## 0.39.1

## 0.39.0

## 0.38.0

## 0.37.0

### Minor Changes

- 00ac9d9: manager: refuse a manager-role spawn of a persona without the spawn capability. A persona defined over the wire (`cotal_persona`) carries no `capabilities:` line (the write path is content-only by design), and `cotal_spawn` takes a free-form `role`, so a wire-defined persona could be spawned with `role: "manager"` and join presenting as a manager whose credential cannot reach the control plane, silently, until the seat first tried to seat a worker (issue #966). The manager now refuses that spawn at accept, before any provisioning, naming the remediation for both authors: an operator adds `capabilities: [spawn]` to the persona file; a peer-defined persona cannot declare capabilities and must ask an operator. The guard keys on the effective role (a spawn-time role override wins over the file's, mirroring existing precedence) and leaves every non-manager spawn untouched. `cotal_spawn`'s `role` argument documents the requirement. Capabilities remain non-declarable over the wire: the closed `define-persona` input schema is unchanged and still guarded by `smoke:persona-input-closed`.

### Patch Changes

- 7e45495: Make every shipped endpoint consumer explicitly surface or ignore recoverable warnings so retry and renewal failures no longer disappear silently.
- 6c1cefe: A stalled presence-KV watch no longer sweeps every peer offline. Whole-bucket silence past TTL marks the observer view stale (last-known roster kept); the dashboard surfaces that on the existing stale pill and debounces the recovery replay so the online sidebar does not empty.
- c09d750: Stop answering progress with presence. Textual working rows without an outside last-assistant observation render progress unknown, while heartbeat age remains explicitly labelled as liveness. The render-agnostic observation classifier lives in the workstation layer, not protocol core; compact presence-only glyphs make no progress claim. A stale observation overlays stalled Xm on still-fresh presence.
- b20644b: Cancel unfinished history pulls at dashboard deadlines so abandoned reads cannot starve later requests.

## 0.36.0

## 0.35.0

## 0.34.0

### Patch Changes

- 9e4e4ed: Add an explicit concrete host option for remote web dashboard binding, launch, readiness, Origin checks, and status probes while preserving the loopback default.

## 0.33.9

## 0.33.8

## 0.33.7

## 0.33.6

## 0.33.5

## 0.33.4

## 0.33.3

## 0.33.2

## 0.33.1

### Patch Changes

- ed041bf: Name failed direct-message and channel-history reads in dashboard 503 responses.

## 0.33.0

## 0.32.0

### Minor Changes

- db4b21e: feat(web)!: authenticate the console's HTTP surface with a single-use launch link

  The dashboard's loopback surface authenticated nobody — `req.headers` was read zero times. Loopback
  keeps other hosts out; it never kept out another process on the same machine, nor a page in the
  operator's own browser issuing requests to `http://127.0.0.1:7799`, and what that reached was the
  whole mesh read path plus a channel-delete.

  `cotal web` now mints a one-time launch token per process and prints it in the URL it opens. The
  token is exchanged exactly once for an `HttpOnly; SameSite=Strict` session cookie, and the exchange
  redirects so the spent secret leaves the address bar. Every route runs behind the gate. Refusals name
  which condition failed — `unauthenticated`, `launch-token-already-used`, `cross-origin` — instead of
  returning an empty success, and the origin is checked before the session so a cross-site request is
  never reported as merely unauthenticated.

  Breaking for anyone driving the dashboard's HTTP endpoints directly: requests now need the session
  cookie, and the printed URL is single-use. `--detach` is unaffected in use — the child writes a
  `0600` session file after binding and the parent authenticates its readiness poll with a separate
  nonce.

## 0.31.0

## 0.30.2

## 0.30.1

## 0.30.0

## 0.29.2

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

## 0.28.0

### Minor Changes

- 316f84d: Cap the dashboard delete route's request body at 8 KiB.

  `POST /api/channel/delete` read its body with no size limit and no look at `content-length`, so the
  ceiling on a request was the process heap: a 30 MB post was read in full, answered with a 70 MB
  refusal, and cost 1.39 GB of peak RSS before the route formed any opinion.

  The read now refuses at the threshold with a `413` naming the limit and the size that met it, on
  both the declared length and the bytes as they arrive, so a body with no declared length is capped
  too. It is never truncated to fit: a shortened channel name is a name the caller did not send, which
  is the aliasing shape this route's validator already exists to refuse. Bodies under the cap, extra
  fields included, are untouched.

  The refusal also closes the connection the oversized body arrived on. Without that, a caller asking
  to keep the connection alive still got to send every byte, because the server reads the rest of a
  body to get the socket back for reuse: the refusal was early but the work was not bounded. Ordinary
  within-cap requests keep their connection and their socket stays reusable.

  `@cotal-ai/connector-core` is listed because it ships the docs bundle, which embeds the page this
  change updates and is regenerated here. Its only diff is that regenerated file.

## 0.27.0

## 0.26.0

## 0.25.0

### Minor Changes

- de4f0ee: Open the graph view's live feed as the page loads, not after it.

  The connection pill is driven by the `/feed` EventSource opening, and the page chained that behind
  its whole bootstrap. The bootstrap reads the activity and DM backfills, both bounded by the
  aggregation deadline, so on a slow link the graph's connection pill stayed down for the entire load
  window and only then went live. Measured in Chrome against a local broker behind an 80ms-each-way
  link with 40 channels: the pill first said `live` at 8052ms, tracking the slowest bootstrap read at
  8044ms. With the feed opened first it says `live` at 89ms while that read still runs to 8066ms. An earlier fix stopped the bootstrap from rejecting, which guaranteed the feed
  would be opened but not that it would be opened soon.

  The feed now opens first and the bootstrap fills in around it, which is what the Monitor page has
  always done. A page showing stale data is exactly the one that needs its live feed most.

  Opening it first introduces an ordering the chained boot could not produce, so the change carries the
  rule for it. Every bootstrap read is issued before its value is applied, so a snapshot is at least as
  old as the moment it was requested, while a live event is newer than that moment. A roster or
  membership arriving mid-bootstrap was therefore reverted when the older snapshot landed, and the
  agent the feed had just announced disappeared from the graph. Both channels carry a full snapshot
  through the same apply, so a live event now replaces the read rather than being overwritten by it.

  What is superseded is the source, not the snapshot. Membership speaks in two sentences, a snapshot
  and a refusal, and either side can say either one, so the rule covers all four: a live refusal is no
  longer erased by an older successful read, and a startup read that refuses no longer overrules a
  newer live snapshot. Both of those ended with the header pill making a claim about the mesh that was
  really a claim about one read, which is the one thing that pill exists not to do.

- b501ec5: Parse the dashboard's history limit once, and bound the single-channel read.

  Three history routes each re-derived the same limit parse, so a value that was not a whole number
  took a different wrong path through each of them. `Number("abc")` is `NaN` and every comparison
  against `NaN` is false, so the endpoint's `limit <= 0` guard never fired and its widening history
  search could never reach either exit: the read did not return everything, it never returned, and the
  abandoned request kept consuming CPU long after its caller had gone. `Infinity` reached the same
  hole from the other end and returned a channel's entire retained history.

  The limit is now parsed in one place and a value that is not a whole number is refused with a 400
  naming what it received, so a caller's mistake is no longer reported as a server fault. The same
  holds for the channel name in the URL: an escape that cannot be percent-decoded is a caller's typo
  and is answered as a bad request rather than as the server having broken.

  For every caller that does not go through those routes, the endpoint now requires a history limit to
  be a whole number of messages it can count exactly, not merely a finite one. A page is taken with
  `slice(-limit)` and slice truncates toward zero, so any limit between zero and one became `slice(0)`
  and returned the subject's entire retained history; a magnitude past exact counting did the same. The
  check sits above the empty-page check on purpose, since `-Infinity` is less than zero and would
  otherwise be folded into a silent empty page.

  The single-channel history read now carries the same per-request deadline as the aggregate routes,
  with a named refusal, because the console view re-reads it on every poll. Zero still means zero,
  negatives still mean an empty page, and an absent or empty limit still means the route's default.

- 6959679: The dashboard survives a poll that fails, and its aggregation answers instead of failing.

  A failed poll used to clear the peers and the channels. A 500's body is valid JSON and `fetch` does
  not reject on one, so the refusal arrived as a successful parse and was stored as the snapshot. Reads
  now refuse a non-200 by name, a refused read leaves the value the page already holds exactly where it
  is, and the header says which source is stale and why. Recovery is the next successful read.

  `/api/activity` no longer fans out every channel's history at once with no upper bound, where one
  channel's rejection became the whole route's 500 and a slow link produced a 34-second success.
  Sources race one shared deadline through a bounded pool, and the page always carries `partial`, the
  counts, the named missing sources, and the deadline it used, so a short page cannot be mistaken for a
  complete one. `/api/dms` is one read with no subset to serve, so its bound is a 503 that names the
  deadline. A channel list that cannot be read is a refusal that says so rather than a page claiming
  the space is empty.

  The elevated observer/admin credential can now delete consumers on its own presence bucket. A KV
  watch rebuilds itself when the link stalls and each rebuild deletes its predecessor; without that
  grant the cleanup was refused, so orphaned consumers accumulated until their inactivity threshold and
  the broker logged a violation every time.

- 0f16f21: web: a refusal renders the value it names, instead of echoing it back invisibly

  The dashboard quotes a caller's own value in two places: the 400 body and the line the request
  frame prints for an operator. Both used `JSON.stringify`, which was doing double duty. It is a JSON
  serializer and it is good at that; it is not a renderer for a human, and it never claimed to be.

  Measured against the shipped server before the change, driving `/api/activity?limit=` with each
  codepoint percent-encoded and reading the answer as bytes: `ESC` and `LF` came back escaped, because
  `JSON.stringify` closes all of C0. `DEL`, `U+0085`, `U+009B`, `U+202E`, `U+2028` and `U+2029` came
  back raw, in the body and in the operator's line alike. The issue named three of those; the class is
  wider than the sample, and `U+202E` is the sharpest case, since it does not vanish but reverses the
  rendering of everything after it.

  Values are now quoted through one helper that escapes what `JSON.stringify` leaves: DEL and the C1
  controls, the soft hyphen, the zero-width and bidi marks, the line and paragraph separators, and the
  BOM. The escape is `\uXXXX`, so the body stays valid JSON and parses back to exactly what the caller
  sent. Ordinary text is untouched, accents and non-Latin scripts included, because a quoter that
  escaped everything over ASCII would make a refusal about a name a human typed unreadable, which is
  the same defect pointed the other way.

  Review of that fix found the list wrong in the way a hand-written list is always wrong: it was
  missing U+061C, U+2060, the variation selectors and the tag characters, every one of them exactly
  the thing the list said it closed. The class is now the Unicode property
  `Default_Ignorable_Code_Point` plus the four codepoints no property carries: DEL, the C1 range, and
  the line and paragraph separators. Astral members leave as their surrogate pair, because the
  five-hex form is not a JSON escape and a body carrying it would stop parsing.

  Review also found a second, older defect at the same boundary, and this fixes it too. The dashboard
  took a channel name from the caller in the history path and in the delete body and handed it
  straight to the wire, which rewrites anything outside `[A-Za-z0-9_-]` to `_` rather than refusing
  it. Two different names were therefore one channel: a history read under a name carrying an
  invisible character returned another channel's messages, and the delete route purged that other
  channel while answering with the name the caller typed. Both boundaries now refuse a name the wire
  would rewrite, using the validator core already had for the same aliasing gap on the ACL side.
  Rendering the old answer readably would only have made the lie legible.

  A second review pass found the property boundary still short: the interlinear annotation controls
  U+FFF9 to U+FFFB are format characters and not default-ignorable, so they arrived raw. They are the
  clearest form of the harm in the issue, since they mark a span as base text plus its gloss and a
  reader whose terminal does not implement them sees the two runs concatenated into a sentence nobody
  wrote. The class now carries both properties, which adds 32 codepoints, none of them a letter or a
  digit. A swept cell puts every codepoint from 0 to 0x10FFFF through the quoter and compares the
  result against the union the code claims, so a dropped alternative or a mistyped range is caught for
  every codepoint rather than for the ones a list happens to name.

  Review then pushed on the boundary from the other side, with U+0338 COMBINING LONG SOLIDUS OVERLAY
  arriving raw, which is a fair question against the harm as it was first stated: it does change what
  a reader sees. It is excluded, and the exclusion is now asserted rather than described. A combining
  mark makes a visible mark on a visible base, and the property carrying it also carries the accent
  in a name written in NFD, the Devanagari vowel signs, the Arabic and Hebrew points and the
  Vietnamese tones; escaping marks would take about 2280 codepoints of ordinary written language and
  render an accented name as its escapes, which is the same defect this change refuses to open on the
  letter side. The stated class is narrowed to say what the code does, characters that produce no
  glyph of their own or that reorder the text around them, and three cells pin the exclusion,
  including the strongest case against it, a mark over an equals sign rendering as a not-equals sign.
  That case is the confusable problem, which needs no combining mark to exist and is not answered by
  a quoter.

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

### Minor Changes

- 757e322: Order event frames on the dashboard, and stop listing and backfilling every agent's event channel.

  The dashboard opens its live feed and only then fetches the backfill, so it is the surface that runs
  the two-phase bootstrap rather than one that can assume an ordered stream. A frame's position in its
  stream is its sequence number, and that is the only thing that can say a frame is MISSING; message-id
  dedupe cannot, because two ids are either equal or they are not, which says nothing about what
  belongs between them. Frames arriving while the fetch is in flight are now held and released in
  sequence order once the batch settles, the baseline is the settled batch's minimum rather than the
  first frame observed, and sequence checking is not armed until the boundary passes. Baselining on
  arrival would read the entire backfill as running backwards, and arming early would read the same
  backfill as a hole.

  A baseline above the first sequence means the retained prefix has rolled, so the chain is marked
  incomplete and applied forward. A discontinuity after the baseline is a fault, reported with both
  ends named. The two are never reported as one thing, because the first is what always happens and the
  second is what must never pass unnoticed. A detected gap still draws its frame: holding it back until
  a missing predecessor arrives would hold it forever when that frame is genuinely gone, which turns a
  visible gap into a silent loss. The retained batch is audited across its whole range and not only at
  its ends, because a hole inside retained history leaves the baseline and the frontier both correct
  and every later frame following contiguously, which is the one discontinuity no live arrival can
  reveal.

  What the bootstrap finds is now DRAWN, above the rows, in the all-activity feed and in a channel
  view. Four things are said separately rather than as one warning: frames are missing, a start-up hole
  could not be attributed, a retained prefix had rolled before this reader joined, and history was
  unavailable. The live tap and the history read are two reads with no shared cut, so the first frame
  buffered during the fetch can sit above the retained top with nothing lost at all; that one hole is
  reported as unconfirmed rather than as loss, and a hole between two buffered frames, which arrived
  through the same subscription, still is a fault. A history read that fails is treated as the empty
  batch it cannot be distinguished from, and the surface says so, so the ordering degrades in the open
  rather than quietly.

  The all-activity feed and the selected-channel view now MERGE their backfill with what arrived live
  during the fetch instead of assigning over it. The assignment discarded every live arrival in that
  window. Retention hid it, since the backfill re-read the same messages from the broker and they came
  back, and the filter below is what would have turned it into a real loss.

  The channel list and the all-activity backfill carry chat only. A channel row is derived from every
  retained concrete subject and the chat stream caps per subject rather than by age, so an unfiltered
  list grows by one row per agent that has ever run and never shrinks: the sidebar fills with machine
  streams, the graph page grows a node for each, and the activity route pays one history round trip per
  event channel to merge results nobody reading chat asked for. The filter runs before the fetch, not
  on its output, so the round trips are not paid and then discarded, and it uses the shared classifier
  rather than a local prefix test, because a human channel called `events.standup` is not
  principal-shaped and must stay where it was being read.

  Two things are deliberately left unfiltered. The live feed still carries frames, marked rather than
  dropped, since dropping them would delete the only traffic this surface was just taught to draw.
  History for a channel named explicitly is still served, or the dashboard could render a frame it
  could never fetch.

## 0.19.0

### Minor Changes

- a1bc784: Display an agent event frame, and separate event channels from chat.

  An `ag-ui.frame` part carries no text part by design, so every surface that renders a message as
  flat text drew one as `[unrenderable part kind "ag-ui.frame"]`. A renderer now folds a frame's
  events into readable lines: streamed text and reasoning deltas accumulate into one line rather than
  one line each, a tool call reports its name, its arguments and its result, and a stream that ended
  without its terminator is flushed and marked truncated instead of being dropped. An event type this
  build does not know is named rather than skipped, because a skipped event is a hole in a transcript
  that still looks complete. It registers through the part-renderer seam, so the standard resolves it
  by the part's own kind and never learns what the vocabulary means.

  The renderer is loaded by the composition root rather than by a connector. Connectors are removable
  extensions materialized on demand, and no surface that renders imports one, so a provider that
  registered only inside a connector would be absent from every process that draws.

  The event channel's name and its classifier move into the standard, beside the frame's identity.
  Both are things a reader needs in order to recognise an agent's stream without knowing which adapter
  produced it, and the two surfaces that most need to classify cannot reach an extension package at
  all. The constructor is re-exported from its former home, so no caller changes.

  The classifier is now a derivation rather than a prefix test, and the two disagree on names a real
  mesh produces. Nothing reserves the `events.` prefix, so a channel a human created and talks on
  answered yes to "does this start with `events.`" and was swept out of the chat pane it was sent to.
  A name that does not resolve to a principal is no longer treated as machine traffic, which returns
  those channels to the view, and leaves a malformed publisher visible rather than hidden. The
  collision is narrowed rather than closed: a chat channel whose remainder is itself principal shaped
  is still indistinguishable from an agent's stream, and closing that means reserving the prefix on
  the wire.

  The console keeps event channels out of the channel strip and out of the history prefill. The order
  matters more than the result: the channel list carries one entry per retained subject, so filtering
  after the fetch would read history for every event channel and discard it, which is unbounded work
  to display nothing. Live rows are marked rather than dropped, because hiding them would delete the
  only traffic this change taught the console to draw.

  The dashboard gains the same rendering through a per-kind lookup, so its dispatcher stays ignorant
  of every kind anyone teaches it. A renderer that throws, returns a non-string, or shares a name with
  an inherited object method is reported by name instead of blanking the body. The browser cannot
  import the shared renderer, so the two implementations are held together by an executable
  equivalence check rather than by intent.

  The example harness records a message through the shared renderer instead of keeping only its text
  parts, so a message whose content is not text is no longer written to the transcript as an empty
  string and scored as an agent that said nothing.

  No connector emits a frame yet, and no transcript mirror is removed. Display lands first on purpose:
  a cutover shipped before a renderer would replace a readable mirror with a part every surface shows
  as a marker.

- b3295d2: The membership pill said "unreadable" while the layout kept acting on the snapshot it had just
  disowned: `hide empty` was gated on `feed.available`, which an unreadable feed leaves true, so a hub
  was still collapsed as empty on the strength of a reading the page could no longer make. Hiding now
  requires the feed to be authoritative, meaning available and readable. The snapshot itself is kept:
  `asOf` still records when the feed was last read successfully, which is true and worth showing.

### Patch Changes

- c3dd6a5: fix(web): route on the channel the broker policed, not the one the publisher claimed

  The browser dashboard decided which channel a message belonged to by reading `msg.channel` off the
  payload. That field is written by the publisher, and the broker polices **subjects**, not payload
  fields, so a sender could put any channel name in a message body and have the dashboard file it
  into that channel's transcript, including a channel the sender had no permission to publish to.

  The verified channel was already available and was being discarded: the observer parses the subject
  to recover the authenticated sender, then dropped the rest of it. Routing now uses the channel
  derived from the subject the broker actually enforced. Where no authoritative channel exists
  (direct messages and anycast carry none), the publisher's claim is cleared rather than trusted, so a
  forged value cannot survive into a transcript, a channel list, or an unread badge.

  Two rendering fixes ride along, because a message whose content vanishes is the same class of defect
  one surface over. A part kind the surface has no renderer for previously produced an empty body, so
  a message with content displayed as a blank line; it now renders a marker naming the kind, and a
  part carrying data keeps that data instead of having it replaced by the marker. A surface that
  prints a marker while dropping the content looks like successful rendering, which is precisely the
  failure being removed. The two dashboard surfaces now share one parts renderer so they cannot drift
  apart on what a part looks like; that drift is how the original defect reached both of them.

  **Limits worth stating.** The new suites drive the served JavaScript directly: they execute the
  shipped handler and backfill functions and assert message content and destination, but no cell opens
  a browser or asserts rendered HTML, so this proves the routing and the renderer's return value, not
  that either survives to the pixels. Rendering of external observer/UI event frames, and the filter
  that selects them, are separate work and are untouched here. The dashboard's loopback HTTP surface
  is unauthenticated and this change does not alter that; a failed membership read still renders as a
  successful empty result, so a viewer cannot distinguish "nobody is subscribed" from "the read
  failed". Both predate this change and are named so the routing fix is not mistaken for making that
  surface safe.

- 0e44e37: fix(web): tell the browser a membership read failed instead of serving it as empty

  The dashboard's `/api/membership` route answered a failed read with `{asOf: undefined, members: []}`
  and a 200. `JSON.stringify` drops a key whose value is `undefined`, so those bytes are
  `{"members":[]}`, byte-identical to a successful read of a space where nobody is subscribed. The
  graph then reported the feed as `membership: traffic-only`, which asserts that the mesh publishes no
  membership feed, when the truth was that the read did not answer.

  A failed read now carries a 503 and names its condition; the two server-sent-event paths emit a
  named event instead of swallowing the rejection; and the page stops manufacturing an empty snapshot
  from a failed fetch or a non-200. The freshness pill gains an `unreadable` state, tested before
  `traffic-only` so a refusal cannot borrow that phrase.

## 0.18.0

## 0.17.0

## 0.16.0

### Minor Changes

- 498055c: Stop paying one network round trip per record, and return the recent messages history claimed to return.

  Several read paths issued one sequential round trip per record, which is invisible against a loopback
  broker and ruinous on any ordinary cross-continent link. Measured against a mesh at 534ms RTT with
  healthy uplinks at both ends, reading the membership feed took 30 to 34 seconds for 89 entries; it
  now takes under a second for 93.

  - `liveKvEntries` is the one sanctioned full-bucket KV read: a single pass whose request count is
    independent of record count, which collapses by greatest revision with tombstones so a deleted key
    cannot resurrect, and which binds its own consumer so that an empty result is PROVEN by the
    bind-time pending count rather than inferred from silence. A pass that is cut short raises rather
    than returning what arrived. That distinction is load-bearing on the ACL path: read this way, a
    dropped link mid-scan would otherwise report a provisioned principal as having no ACL row, and a
    durable join would be refused as "not provisioned" instead of as "could not read". The membership
    feed, the members and channel registries, and the ACL alias enumeration all read through it. No
    change to broker authority: the same ordered push consumer over the same subject.
  - `channelHistory` and `dmHistory` returned the OLDEST messages on any channel holding more than the
    requested limit, while being documented as recent and rendered everywhere as the latest. They now
    return the newest, read through a bounded window rather than by draining the backlog.
  - `cotal status` started the Claude CLI twice for data one listing contains.

  Two optimisations were attempted and REVERTED during review, and are not part of this change: the
  dashboard's activity feed still fetches a full page per channel (the cheaper version dropped
  genuinely-newer messages, because saturation counts messages rather than recency), and control
  commands still open a probe connection before the real one (skipping it flattened typed auth
  failures and lost the probe's deadline).

  This is the read-path half of the work. The registry-safety half — a failed network probe must not
  delete a mesh record — is a separate change on top of the `origin`/`pruneMesh` model from
  `cotal meshes add`.

## 0.15.0

### Minor Changes

- f89560a: New Codex connector (`--agent codex`): an OpenAI Codex session as a full lateral mesh peer, in Codex's own TUI. A host-mode peer drives a `codex app-server` thread over JSON-RPC: inbound batches wake a real turn, and directed messages steer INTO a live turn mid-flight.

  `cotal spawn --agent codex` opens Codex's own TUI. The app-server runs as a loopback websocket listener guarded by a per-incarnation capability token (0600, inside the agent's private home), and the TUI attaches to the very thread the mesh drives, so mesh turns render as they happen and anything you type is a real user turn on that same thread. With no terminal (piped output, CI, a smoke) the host stays headless with an activity feed instead; `COTAL_CODEX_TUI=1|0` picks the mode explicitly when the tty check would guess wrong. Once Codex owns the terminal the host's own log moves to `host.log` in the agent's private home, and the handoff line names that path so a later failure is findable.

  The shared `cotal_*` tools are served by the host process itself over a bearer-authenticated loopback MCP endpoint, with the token passed to codex by env var name so it never reaches the process table. Because the app-server is the MCP client, the same tools work on a mesh-driven turn and on one typed into the TUI; the connector's own tools are pre-approved so an unattended agent never stalls on an approval prompt nobody is watching, and `mcp_servers.cotal.*` is reserved and refused rather than silently overridden.

  Autonomy defaults suit an agent woken by peer messages when nobody is watching: `approval_policy=never` (never ask before running a command, not refuse), `sandbox_mode=workspace-write`, and `sandbox_workspace_write={network_access=true}`. Network is on because Codex's own workspace-write default has it off, which breaks installing a dependency or pushing a branch with an error that reads like the task is impossible rather than the sandbox refusing; filesystem containment is kept, because a peer's message is a remote input that can make the agent run commands. The network default is applied only where the sandbox is actually `workspace-write`, so tightening the mode does not leave a network grant in the launch. All three are overridable per spawn with `--opt` (including `sandbox_mode=danger-full-access` for no sandbox at all), while an interactive `approval_policy` is refused loud rather than auto-answered on the operator's behalf.

  The guide states the sandbox's guarantee literally: it blocks out-of-workspace local filesystem writes, and does not block reads, exfiltration, or networked side effects. With the network on, a peer-driven turn can read broadly and send what it reads, reach loopback and link-local services, and act through any credential it can read, including irreversibly, via a force-push or an API delete. Containing filesystem writes is not the same as containing damage, and the docs say so rather than implying the residual is disclosure-only. The offline, tighter-mode, and separate-OS-user mitigations are named in both the autonomy section and Limits.

  At-least-once delivery with exact-id acks on turn completion: a failed turn retries with backoff, an interrupt redelivers, and an app-server crash restarts the child in place on the same mesh lifecycle and re-drives the un-acked batch (a crash loop is fatal, never an endless respawn). Presence from the event stream, an opt-in transcript mirror, model catalog + reasoning-effort variants (`cotal models --agent codex`, `--variant`), `--opt` passthrough to codex `-c` config overrides, and a private per-agent `CODEX_HOME` (operator config/hooks/MCP servers never load; auth.json symlinked; trust writes never touch the operator's config). Unwired options fail loud: `--resume` (a resumed codex thread comes up without its configured MCP servers, so the agent would be mute on the mesh) and tool-sharing.

  Also fixes the seed reconciler, which treated a generation match alone as up-to-date: a built-in connector added at an unchanged generation would never seed on an already-installed workstation (`--agent codex` reporting no connector installed). Both fast paths now also require every `SEED_BUILTINS` entry to be present in the ever-seeded set.

  A connector can now declare `launchHint`, the one line a foreground `cotal spawn` prints about what to expect next. That text used to be hard-coded to Claude Code's first-run gate for every agent type, telling operators of other harnesses to press Enter at a prompt that never appears.

  The web dashboard gains Codex branding (the OpenAI mark, from Simple Icons), so a codex agent renders with an icon and a label instead of a blank badge. That map was hand-maintained with nothing tying it to the connector set, so it is now covered by a test: every official connector must have a complete entry, and a new connector cannot ship icon-less with a green suite again.

## 0.14.11

## 0.14.10

## 0.14.9

### Patch Changes

- a4c082a: `cotal down web` now works from any directory. The dashboard starts target-resolved (registry current mesh first) and records its pidfile under the target mesh's root, but a selective `down` only looked under the folder it ran in and reported "Nothing running for web" while the dashboard kept running. A `LocalProcess` can now declare `rootedAt: "target"`; `down` resolves such components through the same mesh-target resolution the start side uses, with a new `cotal down web --space <name>` to name the mesh explicitly. Bare `cotal down` remains a folder-scoped sweep, and folder-rooted components refuse `--space`.

## 0.14.8

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

### Patch Changes

- fce3199: Report which machine an agent runs on, and fix three defects that only appear once a mesh spans hosts.

  **`meta.host` on the agent card.** A mesh can span machines: a manager on another box launches
  agents into its own host, so "where is this agent actually running" was unanswerable from the
  roster. Each session now publishes its own `os.hostname()` as `meta.host`, overlaid last like
  `meta.connector` so an agent file cannot claim a host it is not on. It is advisory display
  metadata only, never an authorization or routing input, and the dashboard renders it with no
  change (unknown meta keys already display generically). `SPEC.md` records it alongside the other
  reserved `meta` keys.

  **`cotal up --host <addr>` killed the broker it had just started.** The bind address and the
  broker URL were tracked independently, so `--host` bound one address while the readiness probe
  still used the loopback default. The probe found nothing, timed out, and the caller SIGTERM'd a
  broker that had started correctly, which made `--host` alone impossible to use. The two are now
  reconciled: with no explicit `--server`, the URL is derived from the host; a contradicting pair is
  refused with one sentence instead of starting something unreachable; and wildcard binds
  (`0.0.0.0`, `::`) correctly keep a dialable loopback URL rather than advertising the wildcard. The
  manifest path (`broker.host` without `broker.servers`) had the same defect and shares the fix.

  **One slow probe silently unregistered a live mesh.** `pruneStaleMeshes` deleted any registry
  entry that failed a single reachability check whose budget is 1s, which a healthy broker across a
  slow or jittery link misses routinely. Deletion is destructive and, for a mesh this machine did
  not start, unrecoverable, since only `cotal up` writes registry records. A first failure now only
  makes an entry a candidate; it is pruned only if a second, longer probe also fails. A genuinely
  dead mesh still prunes.

  **A timed-out request killed the whole dashboard.** `cotal web` passed an async listener to
  `createServer`, so a rejection inside any route (for example a JetStream call timing out against a
  slow broker) became an unhandled rejection and took the process down on the first slow request.
  The dashboard is a read-only observer: a failing route now returns 500 and the server stays up.

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.2

### Patch Changes

- 6960658: The web dashboard now ships and versions with the `cotal-ai` binary. Previously `@cotal-ai/web` was fetched separately on its own version line, so upgrading the CLI (`npm i -g cotal-ai@new`) left the dashboard stale, and the documented `cotal ext add @cotal-ai/web` could not cross the 0.x caret to reach the new release, leaving customers on an old dashboard with no clean way forward.

  web is now a bundled first-party extension alongside the connectors: it is carried inside the `cotal-ai` package and the boot reconcile installs and version-refreshes it from that bundled payload at the binary's own version. So `npm i -g cotal-ai@X` brings the dashboard to X automatically and offline on the normal upgrade path, exactly like the connectors (a deliberate operator pin or a rollback is the operator's choice, same as any connector). To make this possible, web is repackaged to be self-contained — its marked/DOMPurify browser builds are copied into its own `dist` and served from there instead of resolving `node_modules` at runtime — so it seeds with no runtime dependencies.

  The bundle path is hardened so the update stays clean and verifiable: the prepack asserts every seeded payload's `name` and `version` match the umbrella (the `fixed` group keeps them lockstep), the reconcile verifies each (re)installed extension is recorded, on disk, and at the generation version before it stamps success (a version-skewed payload fails loud), and web publishes a `vendor-manifest.json` (name/version/license/sha512) of its bundled marked/DOMPurify so the shipped browser libs stay auditable.

## 0.13.1

## 0.13.0

### Minor Changes

- d15b357: Substantially improve the observability dashboard: Markdown rendering in message
  bodies (with expand/collapse-all), attention (dnd/focus) and per-channel
  quiet/muted indicators, channel replay + delivery-class shown at a glance and in
  detail, model·variant + harness badges on the roster and graph, richer graph
  node cards (agent description/tags, channel durability), resizable sidebars and
  nav sections, and assorted layout/legibility fixes.

  Adapt the observer tap for v0.4: subscribe the messaging planes (chat, inst, svc)
  individually instead of the space-wide `>`, so the dashboard no longer taps the
  v0.4 endpoint request rails.

## 0.12.0

## 0.11.6

## 0.11.5

## 0.11.4

## 0.11.3

### Patch Changes

- Version alignment: `@cotal-ai/web` joined the workspace's fixed release group, so its version now tracks the rest of the packages. It had lagged at 0.11.1 while the group reached 0.11.3; this republishes it at 0.11.3 to close the gap. No functional changes.

## 0.11.1

### Patch Changes

- 93fd521: Add the installable Orca runtime, registry-driven extension providers and local-process lifecycle,
  selective shutdown, and `cotal endpoints` for the complete live presence roster.

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

## 0.10.0

### Minor Changes

- 6c40280: Release the 0.10 line with the onboarding and local-stack work since 0.9.1:

  - Rework the CLI around dispatcher-parsed commands, operator-installed extensions (`cotal ext`), and extension-packaged web/demo surfaces.
  - Make `cotal setup` configure-only: it checks prerequisites, installs the Claude plugin and web dashboard extension, seeds one default persona, and keeps the guided david/sven/me team behind `--demo` or `--full`.
  - Have `cotal up` own the local stack (broker, delivery daemon, and manager), with safer teardown, manifest launch handling, and automatic free-port selection for default-port collisions.
  - Collapse foreground and detached launches into one `spawn` grammar, with hardened manager readiness behavior and default persona / default agent environment overrides.
  - Strengthen auth, credential lifetime/rotation, delivery, and OpenCode cancellation handling.
  - Refresh README and getting-started onboarding around `npx cotal-ai setup`, then `cotal up --detach`, `cotal web`, `cotal spawn`, and `cotal down`.
