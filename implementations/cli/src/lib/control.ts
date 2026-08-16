import {
  DEFAULT_SPACE,
  DEV_OWNER,
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  GOAL_BEARING_COMMANDS,
  invokeCommand,
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
  type EpVerbTarget,
  type Profile,
} from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
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
): Promise<{ space: string; server: string; auth: ControlAuth }> {
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

/** One instance's slot in a class scatter (P2 item 3): a REACHABLE instance carries its attributed
 *  reply (`data` on ok, `error` on a per-instance failure); an UNREACHABLE one (a frozen slot that
 *  produced no on-time reply — a severed/stalled manager) is reported, NEVER omitted (SPEC §13.5 pin 3). */
export interface ScatterInstanceReply {
  instanceId: string;
  reachable: boolean;
  data?: unknown;
  error?: string;
}
export type ScatterReply = { ok: true; instances: ScatterInstanceReply[] } | { ok: false; error: string };

/** The ep-rail CLASS SCATTER (P2 item 3, `cotal ps` default): one short-lived connection, a fresh
 *  UNPINNED {@link resolveService} (any instance answers `describe` for the shared command surface),
 *  then {@link scatterCommand} — freeze the live class from the records registry, publish once on the
 *  `all` rail, and gather one attributed reply per instance. Every frozen instance is accounted for:
 *  a reachable one carries its reply, a non-answering one is labeled unreachable (never omitted). */
async function askManagerScatterEp(
  space: string,
  server: string,
  op: string,
  auth: ControlAuth,
  timeoutMs?: number,
): Promise<ScatterReply> {
  const mapped = EP_COMMANDS[op];
  if (!mapped) return { ok: false, error: `unknown manager op "${op}" (no v0.4 command mapping)` };
  if (mapped.targeted) return { ok: false, error: `${op} is targeted and cannot be scattered across instances` };
  const caller = auth.epCaller!;
  const nc = await connect({
    servers: server,
    ...standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: auth.tls === true } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds, tls: auth.tls === true } : { tls: auth.tls === true }),
    maxReconnectAttempts: 0,
  });
  try {
    const service = await resolveService(nc, space, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: 10_000 });
    const result = await scatterCommand(nc, space, service, mapped.command, undefined, {
      deadlineMs: timeoutMs ?? 8_000,
      reconcileDeadlineMs: 3_000,
    });
    const instances: ScatterInstanceReply[] = [];
    for (const [instanceId, ar] of result.replies) {
      if (ar.reply.ok === true) instances.push({ instanceId, reachable: true, data: ar.reply.data });
      else instances.push({ instanceId, reachable: true, error: ar.reply.error?.message ?? ar.reply.error?.code ?? "error" });
    }
    // A frozen instance that never answered is UNREACHABLE — surfaced, never silently dropped (pin 3).
    for (const instanceId of result.missing) instances.push({ instanceId, reachable: false });
    return { ok: true, instances };
  } catch (e) {
    const { error } = epRailFailure(e);
    return { ok: false, error: error ?? "error" };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** SCATTER one untargeted read (`ps`) across EVERY registered manager instance in the space and merge
 *  the attributed results — the `cotal ps` default in a multi-manager space (P2 item 3). Auth shapes
 *  match {@link askManager}: a minted instrument or user bearer rides its own caller triple; a raw
 *  pre-1c `--creds` file is refused loud; an OPEN mesh synthesizes a DEV_OWNER triple and connects
 *  bare (the broker enforces nothing, so the records freeze reads freely). */
export async function scatterManager(
  space: string,
  server: string,
  op: string,
  auth: ControlAuth = {},
  timeoutMs?: number,
): Promise<ScatterReply> {
  if (auth.epCaller && (auth.creds || (auth.bearer && auth.sentinelCreds)))
    return askManagerScatterEp(space, server, op, auth, timeoutMs);
  if (auth.creds)
    return { ok: false, error: `this --creds file predates the v0.4 control surface (no endpoint-serve rows); re-mint it with a current cotal, or drive the manager from its project folder (\`cotal ps\`) which mints the instrument for you` };
  const openAuth: ControlAuth = { epCaller: { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() } };
  return askManagerScatterEp(space, server, op, openAuth, timeoutMs);
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
