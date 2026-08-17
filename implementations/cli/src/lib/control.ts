import {
  DEFAULT_SPACE,
  DEV_OWNER,
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  GOAL_BEARING_COMMANDS,
  epProbeInstanceInterest,
  freezeExpectedSet,
  instancePinnedInstrumentCapabilities,
  invokeCommand,
  mintCreds,
  parseEpSubject,
  respondedButUnbound,
  unansweredRequest,
  registryReadFailed,
  submitAndFollowGoal,
  scatterCommand,
  mintLifecycleUid,
  newIdentity,
  resolveService,
  standaloneConnectOpts,
  type ControlReply,
  type EpCaller,
  type EpInstanceLiveness,
  type EpVerbTarget,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import { PermissionViolationError, connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  authDir, endpointAuth, findCotalRoot, isWorkspaceTargetError, loadSpaceAuth, resolveMeshTarget,
  pruneStaleMeshes, renderWorkspaceError, soleSpaceOf, type MeshTarget, type MeshTargetErrorCode,
} from "@cotal-ai/workspace";
import { c, staleStoreHint } from "../ui.js";
import { connectOrExit, connectUserControlOrExit, type ConnectFlags } from "./connect.js";

/** Endpoint auth material for one control call — a static/raw cred OR user-mode bearer+sentinel
 *  (spread into the endpoint verbatim), plus the minted instrument's v0.4 caller triple when the
 *  static mint produced one ({@link askManager}'s ep-rail path rides it). */
export type ControlAuth = { creds?: string; bearer?: string; sentinelCreds?: string; epCaller?: EpCaller; tls?: boolean };

/** The only {@link MeshTargetErrorCode}s that mean "there is NO registry entry here", and so the
 *  only ones the mode peek in {@link resolveControlTarget} may absorb. **Every other code is
 *  NON-ABSENCE and must fail loud** — which is the precise claim, and covers more than one
 *  situation: `stale-auth-root` / `unreadable-auth` / `user-auth-unrecorded` are an entry that
 *  exists and is broken, while `ambiguous-target` can be several perfectly healthy entries and
 *  `default-occupied` an intended local target with no entry at all. What unites them is not
 *  breakage, it is that absence has NOT been established, so falling through to a
 *  credential-less raw-open connect would be unsound. Deliberately a closed allow-list, not a
 *  deny-list: a new code defaults to failing loud. */
const TARGET_ABSENT_CODES: ReadonlySet<string> = new Set<MeshTargetErrorCode>(["unknown-space", "no-meshes"]);

/** Client-side request window for the manager's readiness-waiting launch ops (`start`, and the
 *  manifest `launch` — both funnel into the same startAgent readiness wait). #159 B1: the manager
 *  replies only on a REAL outcome — presence join, process exit, or its ~30s readiness backstop —
 *  so these requests must OUTLIVE that window, not the 5s op default. The tier rule forbids
 *  importing the manager's READINESS_TIMEOUT_MS here; the launch-parity smoke enforces the
 *  relation by test. */
export const START_TIMEOUT_MS = 40_000;

/**
 * Resolve which running mesh a control command (`spawn --detach` / `stop` / `ps` / `attach`)
 * targets. Exactly {@link connectOrExit}'s precedence (--creds raw > --server+unregistered-space
 * open > registry/`current` with mint + preflight + stale-prune) with ONE control-specific delta:
 * on the raw `--creds` path the space defaults to THIS FOLDER's `.cotal/auth` space, not
 * `DEFAULT_SPACE` — a control op addresses the manager of the folder's mesh, which is more
 * correct for a non-default-space project (deliberate, kept from the pre-move manager client).
 * Lived in `@cotal-ai/manager` before stage 2a moved the control clients into the CLI; the
 * duplicated resolution/preflight wrappers collapsed onto `lib/connect.ts`.
 */
export async function resolveControlTarget(
  flags: ConnectFlags,
  profile: Profile,
  /** `--on <instanceId>`: the instance this invocation addresses. Forwarded to the instrument mint
   *  so the one-shot credential carries the exact `ep.inst.…` rows for it. Omitted ⇒ class rails
   *  only, exactly as before. It has to arrive HERE rather than at the invoke: the instrument is
   *  minted during this resolve, and a credential cannot gain a rail after it is issued. */
  instanceId?: string,
): Promise<{ space: string; server: string; auth: ControlAuth; spaceAuth?: SpaceAuth }> {
  const withSpace = flags.creds
    ? { ...flags, space: flags.space ?? soleSpaceOf(authDir(findCotalRoot())) ?? DEFAULT_SPACE }
    : flags;
  // USER MODE: ledger-scoped bearer is the control surface; there is no instrument mint.
  // `connectOrExit` refuses control-caller-* on a user mesh (those profiles carry freeze rows the
  // bearer does not hold). Route through {@link connectUserControlOrExit}, which takes NO role —
  // a dummy Profile would be meaningless today and wrong the day the user path starts consulting
  // it. Declared translation at this layer (the one that knows), not a silent substitute inside
  // connectOrExit.
  //
  // Cost: the target is resolved here for the mode check and again inside the connect helper.
  // Accepted for this slice so mode choice stays where it is knowable. The two reads are not
  // atomic; a mesh that flips mode between them is an operator action mid-command.
  //
  // This peek reads the MODE and NOTHING ELSE — it must never decide the command's fate. It used
  // to run through `resolveTargetOrExit`, which EXITS on a WorkspaceTargetError, so it killed a
  // legitimate input on the way past: `--server` with an UNREGISTERED `--space` is the raw-open
  // escape hatch, and by definition it has no registry entry to carry a mode. Resolve through the
  // THROWING form instead and read ABSENCE as "not a registry mesh, therefore not user mode",
  // leaving that path to `connectOrExit` below, which owns it.
  //
  // ABSENCE ONLY. The two absent codes are the entire escape hatch; every other
  // MeshTargetErrorCode is NON-ABSENCE, and swallowing those is a
  // fallback, not a restoration. `stale-auth-root` is the one that bites: `targetFromEntry`
  // PRUNES the entry before throwing it, so absorbing it leaves `connectOrExit` seeing no
  // registration at all — and with an explicit `--server` it then takes the raw-open arm and
  // connects with NO CREDENTIALS. A misconfigured AUTH mesh would silently become an OPEN one,
  // hiding the misconfiguration and switching identity planes under the operator. Those codes
  // rethrow and the command dies loud, exactly as it did before this peek existed.
  // Raw `--creds` skips the peek entirely (static/raw path below).
  if (!withSpace.creds) {
    // Sweep first when no space is named, exactly as `resolveTargetOrExit` does before ITS
    // resolve. Without it the peek reads a world `connectOrExit` never sees: a dead entry
    // alongside a live one makes a bare resolve `ambiguous-target` here while the connect,
    // having pruned, resolves the single survivor cleanly. Same sweep, same view, one answer.
    if (!withSpace.space) await pruneStaleMeshes();
    let mode: MeshTarget["mode"] | undefined;
    try {
      mode = resolveMeshTarget(process.cwd(), { server: withSpace.server, space: withSpace.space }).mode;
    } catch (e) {
      // Non-absence propagates and ends the command. It is rethrown rather than rendered-and-exited
      // here so this function stays composable and testable; the CLI boundary renders every
      // WorkspaceTargetError through `renderWorkspaceError` (see the dispatcher's catch), which is
      // what turns "entry X points at a root holding Y" into the removed-fact plus a recovery line.
      if (!isWorkspaceTargetError(e) || !TARGET_ABSENT_CODES.has(e.code)) throw e;
    }
    if (mode === "user") {
      const conn = await connectUserControlOrExit(withSpace);
      return {
        space: conn.space,
        server: conn.server,
        auth: { ...endpointAuth(conn), ...(conn.epCaller ? { epCaller: conn.epCaller } : {}) },
      };
    }
  }
  // Static / open / raw-creds: mint the requested instrument (or bare open connect).
  const conn = await connectOrExit(withSpace, profile, ...(instanceId !== undefined ? [{ instanceId }] as const : []));
  return {
    space: conn.space,
    server: conn.server,
    auth: { ...endpointAuth(conn), ...(conn.epCaller ? { epCaller: conn.epCaller } : {}) },
    // The resolved mesh's trust material, carried FORWARD rather than re-loaded from disk by
    // whoever needs it: {@link scatterManager} re-mints its one-shot instrument against the frozen
    // instance ids, and a second `loadSpaceAuth` there would be a second answer to "which space's
    // seed" for one command. Absent for an open mesh (no credential system) and for raw
    // off-registry creds (no seed to mint from) — both of which simply do not re-mint.
    ...(conn.auth ? { spaceAuth: conn.auth } : {}),
  };
}

/** v0.3 ctl op → v0.4 typed command (P2 item 1, 1c.2b): the wire names the manager REGISTERS
 *  (manager-service-contract ROWS). `start` is creation (`spawn`), a NAMED `stop` is the one
 *  owner/any-mode terminal (`despawn`), the per-agent `status` read is `inspect`; the camelCase
 *  admin family maps to its kebab-case wire names. `targeted` marks the two commands whose
 *  `{name}` argument becomes a §13.2 target block (resolved to the agent's principal triple via
 *  the name-keyed `inspect` read — it rides the spawn capability arm, so resolution reach equals
 *  despawn/attach reach; the wire target is (owner, actor, lifecycleUid), never an alias). */
const EP_COMMANDS: Record<string, { command: string; targeted?: boolean }> = {
  start: { command: "spawn" },
  stop: { command: "despawn", targeted: true },
  attach: { command: "attach", targeted: true },
  status: { command: "inspect" },
  ps: { command: "ps" },
  models: { command: "models" },
  launch: { command: "launch" },
  purge: { command: "purge" },
  resumePreserved: { command: "resume-preserved" },
  commitResume: { command: "commit-resume" },
  finalizeResume: { command: "finalize-resume" },
  preparePreservation: { command: "prepare-preservation" },
  commitPreservation: { command: "commit-preservation" },
  abortPreservation: { command: "abort-preservation" },
};

/** Operator reach for one targeted control call: `owner` rides the caller's own-domain verb rows
 *  (the spawn capability's standing mint), `any` the admin instrument's cross-agent rows (§13.2
 *  any-mode). Replaces the deleted manager ctl tiers as the CLI's mode selector (1d). */
export type ControlReach = "owner" | "any";

/** The ep-rail control call — since 1d {@link askManager}'s ONLY path: one short-lived raw
 *  connection, a fresh `resolveService` (describe → §13.7 store fetch → digest-verified recompile
 *  — the generic item-5 caller, no hand-imported manager schemas), then the mapped command.
 *  Targeted ops resolve the alias to its CURRENT principal triple through the name-keyed
 *  `inspect` read first and ride mode `any` (admin instruments) or `owner` per {@link
 *  ControlReach}. */
async function askManagerEp(
  space: string,
  server: string,
  op: string,
  args: Record<string, unknown> | undefined,
  auth: ControlAuth,
  reach: ControlReach,
  timeoutMs?: number,
  pin?: ManagerPin,
): Promise<ManagerReply> {
  const instanceId = pin?.instanceId;
  const mapped = EP_COMMANDS[op];
  if (!mapped) return { ok: false, error: `unknown manager op "${op}" (no v0.4 command mapping)` };
  const caller = auth.epCaller!;
  // standaloneConnectOpts handles all three auth shapes: static creds, the user bearer + sentinel
  // (client-chosen inbox nonce; the callout scopes the reply inbox on it), or BARE on an open
  // mesh (no credential system; the broker enforces nothing).
  const nc = await connect({
    servers: server,
    ...standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: auth.tls === true } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds, tls: auth.tls === true } : { tls: auth.tls === true }),
    maxReconnectAttempts: 0,
  });
  try {
    // P2 item 3 `--on <instance>`: pin the resolve to the exact manager instance's `inst` route so a
    // multi-manager space addresses the intended manager, never whichever wins the class anycast.
    const service = await resolveService(nc, space, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: 10_000, ...(instanceId !== undefined ? { instanceId } : {}) });
    let target: EpVerbTarget | undefined;
    let sendArgs = args;
    if (mapped.targeted) {
      const name = String(args?.name ?? "").trim();
      if (!name) return { ok: false, error: `${op} requires a name` };
      // Alias -> CURRENT principal triple via the manager's name-keyed `inspect` read (§13.2: a
      // target is a triple, never an alias) - the same resolution the connector uses. `inspect`
      // rides the SPAWN capability arm as well as the instrument read set, so every caller class
      // that can despawn/attach can also resolve its target (a `ps` SCAN here broker-drops exactly
      // the spawn-scoped user bearers - the 1c.2b read narrowing - and hangs their stop/attach).
      const info = await invokeCommand(nc, space, service, "inspect", { name }, { deadlineMs: 10_000 });
      if (info.reply.ok !== true)
        return { ok: false, error: `could not resolve "${name}": ${info.reply.error?.message ?? info.reply.error?.code ?? "inspect failed"}` };
      const row = info.reply.data as { id: string; lifecycleUid: string };
      // A STATIC row's `id` is the bare actor under the caller's own owner; a USER-mode row's `id`
      // is the composite `owner.actor` principal key - split it (an embedded dot would break the
      // target block's subject arity). Mode `any` spans owners (operator reach); mode `owner` pins
      // the caller's own, so a foreign-owner target is broker-denied at publish.
      const dot = row.id.indexOf(".");
      const [tOwner, tActor] = dot > 0 ? [row.id.slice(0, dot), row.id.slice(dot + 1)] : [caller.owner, row.id];
      // Target mode from the RESOLVED target owner: an own-domain target rides `owner` mode (pinned
      // to the caller's own owner); a CROSS-owner target rides `any` mode - which the broker admits
      // only for a caller holding the admin instrument rows (a static admin instrument, or a user
      // bearer whose ledger `admin` scope the callout minted them into). `reach: "any"` forces
      // any-mode for a static admin instrument even on its own domain. So a spawn-scoped caller's
      // cross-owner despawn/attach is broker-denied at publish (no any-mode row), while an
      // admin-scoped operator's is admitted and the manager's fresh ledger check governs.
      const mode = reach === "any" || tOwner !== caller.owner ? "any" : "owner";
      target = {
        mode,
        owner: tOwner,
        actor: tActor,
        lifecycleUid: row.lifecycleUid,
      };
      const { name: _dropped, ...rest } = args ?? {};
      sendArgs = Object.keys(rest).length ? rest : undefined;
    }
    const invokeOpts = { ...(target ? { target } : {}), deadlineMs: timeoutMs ?? 10_000 };
    const submit = () => invokeCommand(nc, space, service, mapped.command, sendArgs, invokeOpts);
    // P2 item 2 (2b): a goal-bearing command (spawn/launch) FOLLOWS its acceptance to the goal
    // terminal, so `spawn --detach` still returns on the real outcome (join / exit / ~30s uncertain)
    // exactly like the pre-action blocking reply — UX unchanged, no --no-wait.
    const r = (GOAL_BEARING_COMMANDS as readonly string[]).includes(mapped.command)
      ? await submitAndFollowGoal(nc, space, BASELINE_LIFECYCLE_ENDPOINT, caller, timeoutMs ?? START_TIMEOUT_MS, submit)
      : await submit();
    if (r.reply.ok !== true) return { ok: false, error: r.reply.error?.message ?? r.reply.error?.code ?? "error" };
    // The ep `models` reply is normalized to `{catalogs}` — unwrap so call sites keep the ctl shape.
    const data = mapped.command === "models" ? (r.reply.data as { catalogs: unknown }).catalogs : r.reply.data;
    return { ok: true, ...(data !== undefined ? { data } : {}) };
  } catch (e) {
    return epRailFailure(e, pin);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** {@link ControlReply} plus the one fact a caller cannot recover from the rendered message: whether
 *  the call went UNANSWERED, as core marks it (`EP_UNANSWERED`: no responder, or the reply
 *  deadline elapsed with nothing attributed to the request). `up`'s resume readiness poll keys on it;
 *  it used to key on the message prefix, which turned an operator-facing string into a control-flow
 *  predicate in another file. */
export type ManagerReply = ControlReply & { unanswered?: boolean };

/** What the calling command declares about pinning. Passed ONLY by a command that offers `--on`
 *  (`ps`, `stop`, `attach`, `spawn --detach`), with `instanceId` set to what the operator typed, if
 *  anything. Its presence is what lets the renderer offer `--on` as a remedy: a command without the
 *  flag (`models`, `up`, `down`) rides the same rails, splits the same way, and must not be told to
 *  type a flag it does not have. Absence of a pin therefore never means "not passed". */
export interface ManagerPin {
  instanceId?: string;
}

/** Read `--on` at the site that declares it. Absent stays absent (class rails). An EMPTY value
 *  (`--on=`, `--on ""`, or `--on "$INSTANCE"` with the variable unset) is refused here, up front:
 *  it is falsy, so every `if (on)` branch would treat it as absent and drop the pin (a `stop` would
 *  fall through to seat locality, an open-mesh `ps` to the scatter), while the mint and core's
 *  route builder treat it as PRESENT and refuse it as an invalid token. Two answers for one input;
 *  a dropped pin is a silent fallback, so neither branch gets to see it. */
export function onInstanceOrExit(on: string | undefined, verb: string): string | undefined {
  if (on === undefined) return undefined;
  if (on === "") {
    console.error(c.red(`✗ --on requires a manager instance id (the whole id, as \`cotal ps\` prints it): \`${verb} --on <instance>\`. An empty value is refused, not dropped`));
    process.exit(1);
  }
  return on;
}

/** Render an ep-rail failure for the operator. Three outcomes, told apart by core's markers and never
 *  by the catalog code: a responder's own `ok:false` describe reply is rethrown under ITS code
 *  (`unavailable` included), and a store read after an answered describe raises the same code, so
 *  the code says nothing about whether anyone answered.
 *  - UNANSWERED ({@link unansweredRequest}: no responder, or the reply deadline elapsed). The
 *    reachability verdict "no manager reachable" is stated here and only here, and only unpinned:
 *    an unanswered PINNED call names the instance instead, since three managers may be answering
 *    while the one the operator typed is not there, and "no manager reachable" sends them to the
 *    broker for a typo. Measured on a live three-manager mesh during review.
 *  - a REGISTRY READ on this side failed ({@link registryReadFailed}: the scatter's freeze or its
 *    reconcile). The managers were not the failure and may all be up; a verdict on them here sent
 *    the operator to the managers for a broker read.
 *  - everything else answered, or failed on this side with its own cause, and is printed as is.
 *    Prepending a verdict made the headline contradict the body: a describe REFUSED BY THE BROKER
 *    read as an unreachable manager, which is precisely the misreading the refusal was reworded to
 *    stop.
 *  A failure that is not an {@link EpEnvelopeError} carries no answer provenance at all, so no verdict
 *  is stated for it either: its message stands alone. */
export function epRailFailure(e: unknown, pin?: ManagerPin): ManagerReply {
  const instanceId = pin?.instanceId;
  if (!(e instanceof EpEnvelopeError)) return { ok: false, unanswered: false, error: e instanceof Error ? e.message : String(e) };
  const detail = `${e.code}: ${e.message}`;
  if (unansweredRequest(e)) {
    return {
      ok: false, unanswered: true,
      error: instanceId !== undefined
        ? `manager instance ${instanceId} did not answer (${detail})`
        : `no manager reachable on the ep rails (${detail})`,
    };
  }
  if (registryReadFailed(e))
    return { ok: false, unanswered: false, error: `the manager registry could not be read: a broker read on this side, not the managers' silence, and they may all be up. Retry; if it persists, look at the broker's JetStream (${detail})` };
  // The unpinned class-queue split. Core says a call that addresses one instance does not split
  // and stops there (a CLI flag name does not belong in a core error). The flag is named here only
  // when the CALLER declared it has one (`pin` present) and did not pass it: an absent `pin` is a
  // command with no `--on` at all, and telling it to type one is the same dead end one layer down.
  // A marked `expired` is the other producer (a stale-epoch bind) and its remedy is re-resolving,
  // so the flag is offered only for the split.
  const unpinnedSplit = e.code === "failed-precondition" && respondedButUnbound(e) && pin !== undefined && instanceId === undefined;
  return { ok: false, unanswered: false, error: `${detail}${unpinnedSplit ? " Pin one manager instance with --on <instance> (the whole id, as `ps` prints it) to avoid the split." : ""}` };
}

/** Send one control command to the manager over the v0.4 service-endpoint rails and disconnect —
 *  since 1d the manager's ONLY control door (the `ctl` tiers are deleted). The target is already
 *  reachability- + auth-preflighted by {@link resolveControlTarget}. `reach` picks the operator
 *  mode for the two targeted ops (stop/attach): `owner` = the caller's own domain (the spawn
 *  capability's standing mint / a user bearer's own owner), `any` = the admin instrument's
 *  cross-agent reach. Three auth shapes reach the rails: a static instrument's caller triple, a
 *  user bearer's triple, or an OPEN mesh (no credential system — a bare connection under a
 *  synthesized DEV_OWNER triple, since the manager registered under DEV_OWNER and the broker
 *  enforces nothing). A raw `--creds` file from an older generation carries no ep rows and is
 *  refused loud (no silent ctl fallback exists anymore). */
export async function askManager(
  space: string,
  server: string,
  op: string,
  args?: Record<string, unknown>,
  auth: ControlAuth = {},
  reach: ControlReach = "owner",
  timeoutMs?: number,
  pin?: ManagerPin,
): Promise<ManagerReply> {
  // A user bearer or a minted static instrument carries its own ep caller triple: ride it.
  if (auth.epCaller && (auth.creds || (auth.bearer && auth.sentinelCreds)))
    return askManagerEp(space, server, op, args, auth, reach, timeoutMs, pin);
  // A raw `--creds` file with NO minted triple is a pre-1c generation's cred (no ep rows). The ctl
  // rail it used to ride is gone (1d), so refuse loud with the recovery rather than hang.
  if (auth.creds)
    return { ok: false, error: `this --creds file predates the v0.4 control surface (no endpoint-serve rows); re-mint it with a current cotal, or drive the manager from its project folder (\`cotal ps\`/\`cotal stop\`) which mints the instrument for you` };
  // OPEN mesh: no credential system. The manager registered its service under DEV_OWNER and the
  // broker enforces nothing, so synthesize a fresh DEV_OWNER caller triple and connect bare.
  const openAuth: ControlAuth = { epCaller: { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() } };
  return askManagerEp(space, server, op, args, openAuth, reach, timeoutMs, pin);
}

/** What this CLI established about a silent instance's LIVENESS, as opposed to its answer. Kept
 *  separate from `reachable` because they are different questions and folding them is what let a
 *  registration outlive its host unnoticed:
 *   - `gone` — the BROKER answered no-responders on that instance's own rail. Affirmative: the
 *     record claims a live instance and there is nothing behind it, so the row can say so and name
 *     the deregistration.
 *   - `unknown` — a probe went out and nothing came back. A live-but-slow host and a wedged one are
 *     the same observation from here, so nothing is claimed.
 *   - `not-probed` — no probe was PUBLISHED for it: it is outside this credential's pinned set (it
 *     registered after the freeze this instrument was minted against), or this command had no
 *     probe path at all (user mode holds no instance rails).
 *   - `probe-refused` — the broker refused the probe publish. The grant is missing, which is a
 *     local misconfiguration and NOT a statement about the instance; it is named on stderr rather
 *     than left to expire into `unknown`. */
export type ScatterInstanceLiveness = "gone" | "unknown" | "not-probed" | "probe-refused";

/** One instance's slot in a class scatter (P2 item 3): a REACHABLE instance carries its attributed
 *  reply (`data` on ok, `error` on a per-instance failure); an UNREACHABLE one (a frozen slot that
 *  produced no on-time reply — a severed/stalled manager) is reported, NEVER omitted (SPEC §13.5 pin 3),
 *  and carries what the liveness probe established about it ({@link ScatterInstanceLiveness}). */
export interface ScatterInstanceReply {
  instanceId: string;
  reachable: boolean;
  data?: unknown;
  error?: string;
  /** Set on unreachable slots only: a slot that ANSWERED needs no liveness verdict. */
  liveness?: ScatterInstanceLiveness;
}
export type ScatterReply = { ok: true; instances: ScatterInstanceReply[] } | { ok: false; error: string };

/** Open one short-lived control connection under whichever of the three auth shapes this command
 *  holds (static creds / user bearer + sentinel / bare open mesh) and hand it to `fn`. Extracted so
 *  the scatter's TWO connections cannot drift in their connect options: they differ in credential
 *  and in nothing else. */
async function withControlConnection<T>(server: string, auth: ControlAuth, fn: (nc: NatsConnection) => Promise<T>): Promise<T> {
  const nc = await connect({
    servers: server,
    ...standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: auth.tls === true } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds, tls: auth.tls === true } : { tls: auth.tls === true }),
    maxReconnectAttempts: 0,
  });
  try {
    return await fn(nc);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** The instance a REFUSED SUBJECT names, or `undefined` when that subject is not one of this
 *  probe's requests at all.
 *
 *  The id is read as a whole subject TOKEN, through the same §13.9 grammar parser that built the
 *  subject, and never matched inside the text. Lifecycle tokens are `[a-z0-9]{26,32}`, so one
 *  frozen id can be a PREFIX of another (26 chars and the same 26 plus a suffix are both legal),
 *  and a substring test then attributes one broker refusal to two instances: the operator is told
 *  the CLI could not ask about a manager it never published for, and that instance's probe settles
 *  as `probe-refused` on evidence that belongs to a different rail. Parsing removes the class of
 *  mistake rather than one instance of it: the endpoint and the route mode must match too, so a
 *  violation on any other plane, endpoint, or route is not this probe's and is not attributed. */
function probedInstanceOf(subject: string, endpoint: string): string | undefined {
  const parsed = parseEpSubject(subject);
  if (parsed === null || parsed.plane !== "request" || parsed.route !== "inst") return undefined;
  return parsed.endpoint === endpoint ? parsed.instanceId : undefined;
}

/** Watch a connection's status stream for the broker's own PERMISSION VIOLATIONS and attribute each
 *  to the instance whose rail it names.
 *
 *  A refused publish is invisible where it matters. The violation is delivered on the CONNECTION,
 *  asynchronously, while the publish itself returns normally — so a liveness probe with no grant
 *  does not fail, it goes quiet, and quiet is exactly what a live-but-slow instance looks like. The
 *  whole probe would then read as `unknown`, the deadline would be paid in full, and the operator
 *  would be told the manager was slow when the truth was that this CLI never asked. So the
 *  violation is caught, attributed to the instance its subject names, reported on stderr once, and
 *  used to settle that probe immediately instead of letting it expire.
 *
 *  ATTRIBUTION IS STRUCTURAL, not textual. The client types a permission violation as
 *  `PermissionViolationError` and carries the refused SUBJECT as a field, so nothing here parses
 *  the broker's prose: the subject goes through {@link probedInstanceOf} and yields one exact id or
 *  none. NAMED RESIDUAL: a connection error the client does not type as a permission violation is
 *  not attributed, and that probe expires into `unknown` at its budget — the behaviour that existed
 *  before this watch, which is slower and never wrong. */
function watchProbeRefusals(
  nc: NatsConnection,
  what: { endpoint: string; ids: readonly string[] },
  report: (line: string) => void,
): { refused: (id: string) => Promise<void>; wasRefused: (id: string) => boolean } {
  const ids = new Set(what.ids);
  const settle = new Map<string, () => void>();
  const already = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const refused = (id: string): Promise<void> => {
    if (already.has(id)) return Promise.resolve();
    let p = pending.get(id);
    if (!p) {
      p = new Promise<void>((resolve) => settle.set(id, resolve));
      pending.set(id, p);
    }
    return p;
  };
  void (async () => {
    try {
      for await (const s of nc.status()) {
        if (s.type !== "error") continue;
        const err = (s as { error?: unknown }).error;
        if (!(err instanceof PermissionViolationError)) continue;
        const id = probedInstanceOf(err.subject, what.endpoint);
        if (id === undefined || !ids.has(id) || already.has(id)) continue;
        already.add(id);
        report(`! the broker refused this command's liveness probe for manager instance ${id}: ${err.message}`);
        settle.get(id)?.();
      }
    } catch {
      /* the connection closed; the scatter is over and there is nothing left to attribute */
    }
  })();
  return { refused, wasRefused: (id: string) => already.has(id) };
}

/**
 * THE §13.5 LIVENESS HOOK this CLI hands to a scatter, and the record of what it established.
 *
 * It is built HERE and not in core because it is entirely a statement about this caller's
 * CREDENTIAL. A probe publishes on an instance's own rail, and only the layer that minted the
 * credential knows which instance rails it carries; core cannot know, and a core that guessed would
 * publish requests the broker must refuse — invisibly, since a refused publish looks exactly like a
 * slow instance from the caller's side.
 *
 * TWO RULES, and both are about not asking questions this credential cannot ask:
 *  - an id OUTSIDE the pinned set gets `unknown` WITHOUT PUBLISHING. The scatter re-freezes the
 *    class on its own connection, so it can name an instance that registered after the freeze this
 *    credential was minted against. That instance is NEW, not dead, and the right answer for it is
 *    the deadline — reached without sending a request that would be refused.
 *  - an id INSIDE the set that the broker refuses anyway settles IMMEDIATELY on the violation
 *    rather than expiring into `unknown` at the budget, and is reported by name.
 *
 * Only `gone` ever licenses anything downstream, so every mistake this can make is a slower and
 * more truthful answer, never a faster wrong one.
 */
export function pinnedLivenessProbe(
  nc: NatsConnection,
  opts: {
    space: string;
    endpoint: string;
    caller: EpCaller;
    /** The exact ids this connection's credential holds `inst` rails for. */
    pinned: ReadonlySet<string>;
    probeDeadlineMs?: number;
    /** Where a refusal is announced. Defaults to stderr; the suite captures it. */
    report?: (line: string) => void;
  },
): {
  probeLiveness: (instanceId: string) => Promise<EpInstanceLiveness>;
  /** What was established about one silent slot, for the row that will describe it. */
  livenessOf: (instanceId: string) => ScatterInstanceLiveness;
} {
  const deadlineMs = opts.probeDeadlineMs ?? PROBE_DEADLINE_MS;
  const report = opts.report ?? ((line: string) => console.error(c.dim(line)));
  const refusals = watchProbeRefusals(nc, { endpoint: opts.endpoint, ids: [...opts.pinned] }, report);
  const verdicts = new Map<string, ScatterInstanceLiveness>();
  return {
    probeLiveness: async (instanceId: string): Promise<EpInstanceLiveness> => {
      if (!opts.pinned.has(instanceId)) {
        verdicts.set(instanceId, "not-probed");
        return "unknown";
      }
      const verdict = await Promise.race([
        epProbeInstanceInterest(nc, opts.space, opts.endpoint, instanceId, opts.caller, { deadlineMs }),
        refusals.refused(instanceId).then((): EpInstanceLiveness => "unknown"),
      ]);
      verdicts.set(instanceId, verdict === "gone" ? "gone" : refusals.wasRefused(instanceId) ? "probe-refused" : "unknown");
      return verdict;
    },
    // A slot with no recorded verdict was never handed to the hook at all, which is a different fact
    // from "probed and silent" and prints as one.
    livenessOf: (instanceId: string): ScatterInstanceLiveness =>
      verdicts.get(instanceId) ?? (opts.pinned.has(instanceId) ? "unknown" : "not-probed"),
  };
}

/** The tier a scatter re-mints at. Only ONE tier can scatter — the freeze read is a privileged row
 *  and the admin tier is denied it deliberately — so this is a constant rather than a parameter, and
 *  it is named here so the re-mint below can never silently widen: it reproduces the credential the
 *  caller already resolved with, pinned, never a higher one. */
const SCATTER_PROFILE: Profile = "control-caller-privileged";

/** How long a single liveness probe waits for the broker's no-responders answer. It is NOT a tuning
 *  knob and cannot make the command wrong: the only verdict that changes anything is `gone`, and
 *  giving up early yields `unknown`, which leaves the full gather deadline standing exactly as it
 *  did before the probe existed. Sized to be generous against a busy broker while still expiring
 *  well inside the gather. */
const PROBE_DEADLINE_MS = 5_000;

/** The ep-rail CLASS SCATTER (P2 item 3, `cotal ps` default).
 *
 * TWO connections, because a connection's permissions are fixed at authentication and this command
 * cannot know which instance rails it needs until it has read the registry:
 *
 *   0. FREEZE the live class from the records registry (the same §13.9 read the scatter itself
 *      does), then close. This yields the exact instance ids this invocation will address.
 *   1. RE-MINT the one-shot instrument LOCALLY, pinned to exactly those ids, and run the
 *      unpinned {@link resolveService} + {@link scatterCommand} on it — now the §13.5 liveness probe
 *      can publish on each frozen instance's own rail and the gather can end as soon as every slot
 *      has either answered or been affirmed gone by the broker.
 *
 * THE COST IS THE MINT, NOT A ROUND TRIP. `mintCreds` is a local JWT signature against the space
 * seed already in hand (measured at 22-45ms here); the extra connection is the only wire cost. The
 * earlier attempt at this measured 3.2s because it re-ran the whole target resolve (registry read,
 * preflight, stale-prune) to get a pinned credential, and shipped a regression to fix a hypothesis.
 * This re-mints and nothing else.
 *
 * NO WILDCARD INSTANCE ROW is minted, which is the invariant the whole two-connection shape exists
 * to preserve: the pin is a list of exact ids known before the mint, the same precondition `--on`
 * satisfies with one id.
 *
 * WHERE THERE IS NO SEED THERE IS NO PROBE, and the deadline stands. A user-mode bearer and a raw
 * off-registry cred cannot re-mint, so their frozen slots are `not-probed` and say so. This is not
 * a silent degrade: it is the pre-existing behaviour, and the row prints which of the two it is.
 */
async function askManagerScatterEp(
  space: string,
  server: string,
  op: string,
  auth: ControlAuth,
  spaceAuth: SpaceAuth | undefined,
  timeoutMs?: number,
): Promise<ScatterReply> {
  const mapped = EP_COMMANDS[op];
  if (!mapped) return { ok: false, error: `unknown manager op "${op}" (no v0.4 command mapping)` };
  if (mapped.targeted) return { ok: false, error: `${op} is targeted and cannot be scattered across instances` };

  // ---- connection 0: freeze the class. A registry read that fails here fails the command with the
  // registry's own verdict (never the managers'), which `epRailFailure` already words.
  let pinnedIds: string[];
  try {
    pinnedIds = await withControlConnection(server, auth, async (nc) => {
      // `checkAPI: false` for the same reason `scatterCommand` uses it: the freeze rides the scoped
      // §13.9 records rows, never an account-level JetStream probe.
      const jsm = await jetstreamManager(nc, { checkAPI: false });
      return (await freezeExpectedSet(jsm, space, BASELINE_LIFECYCLE_ENDPOINT)).map((f) => f.instanceId);
    });
  } catch (e) {
    const { error } = epRailFailure(e);
    return { ok: false, error: error ?? "error" };
  }

  // ---- the LOCAL pinned re-mint. An OPEN mesh has no credential system, so its bare connection can
  // already publish anywhere and needs no mint to probe; an auth mesh with the space seed re-mints;
  // anything else keeps the credential it arrived with and does not probe.
  const openMesh = !auth.creds && !auth.bearer;
  let probeAuth = auth;
  let caller = auth.epCaller!;
  let probed: ReadonlySet<string> = openMesh ? new Set(pinnedIds) : new Set();
  if (spaceAuth && auth.creds) {
    const identity = newIdentity();
    const uid = mintLifecycleUid();
    probeAuth = {
      ...auth,
      creds: await mintCreds(spaceAuth, identity, SCATTER_PROFILE, {
        lifecycleUid: uid,
        endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", pinnedIds),
      }),
    };
    caller = { owner: DEV_OWNER, actor: identity.id, uid };
    probed = new Set(pinnedIds);
  }

  // ---- connection 1: resolve + scatter, with the probe closure this credential can actually back.
  try {
    return await withControlConnection(server, probeAuth, async (nc) => {
      const { probeLiveness, livenessOf } = pinnedLivenessProbe(nc, { space, endpoint: BASELINE_LIFECYCLE_ENDPOINT, caller, pinned: probed });
      const service = await resolveService(nc, space, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: 10_000 });
      const result = await scatterCommand(nc, space, service, mapped.command, undefined, {
        deadlineMs: timeoutMs ?? 8_000,
        reconcileDeadlineMs: 3_000,
        probeLiveness,
      });
      const instances: ScatterInstanceReply[] = [];
      for (const [instanceId, ar] of result.replies) {
        if (ar.reply.ok === true) instances.push({ instanceId, reachable: true, data: ar.reply.data });
        else instances.push({ instanceId, reachable: true, error: ar.reply.error?.message ?? ar.reply.error?.code ?? "error" });
      }
      // A frozen instance that never answered is UNREACHABLE — surfaced, never silently dropped
      // (pin 3) — and now carries WHY it is silent, as far as this command could establish it.
      for (const instanceId of result.missing)
        instances.push({ instanceId, reachable: false, liveness: livenessOf(instanceId) });
      return { ok: true, instances };
    });
  } catch (e) {
    const { error } = epRailFailure(e);
    return { ok: false, error: error ?? "error" };
  }
}

/** SCATTER one untargeted read (`ps`) across EVERY registered manager instance in the space and merge
 *  the attributed results — the `cotal ps` default in a multi-manager space (P2 item 3). Auth shapes
 *  match {@link askManager}: a minted instrument or user bearer rides its own caller triple; a raw
 *  pre-1c `--creds` file is refused loud; an OPEN mesh synthesizes a DEV_OWNER triple and connects
 *  bare (the broker enforces nothing, so the records freeze reads freely). `spaceAuth` is the
 *  resolved mesh's trust material from {@link resolveControlTarget}: present ⇒ the scatter re-mints
 *  its instrument pinned to the frozen instance ids and can probe their liveness; absent ⇒ it runs
 *  exactly as it did before and every silent slot is reported `not-probed`. */
export async function scatterManager(
  space: string,
  server: string,
  op: string,
  auth: ControlAuth = {},
  spaceAuth?: SpaceAuth,
  timeoutMs?: number,
): Promise<ScatterReply> {
  if (auth.epCaller && (auth.creds || (auth.bearer && auth.sentinelCreds)))
    return askManagerScatterEp(space, server, op, auth, spaceAuth, timeoutMs);
  if (auth.creds)
    return { ok: false, error: `this --creds file predates the v0.4 control surface (no endpoint-serve rows); re-mint it with a current cotal, or drive the manager from its project folder (\`cotal ps\`) which mints the instrument for you` };
  const openAuth: ControlAuth = { epCaller: { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() } };
  return askManagerScatterEp(space, server, op, openAuth, spaceAuth, timeoutMs);
}

export function failIfNotOk(reply: ControlReply): void {
  if (!reply.ok) {
    const msg = reply.error ?? "error";
    console.error(c.red(`✗ ${msg}`));
    // A manager-side stale-store durable collision (e.g. `spawn --detach` into a store minted by
    // an older Cotal generation) names its reset - the reply error stays verbatim.
    const hint = staleStoreHint(msg);
    if (hint) console.error(c.dim(`  ↳ ${hint}`));
    process.exit(1);
  }
}
