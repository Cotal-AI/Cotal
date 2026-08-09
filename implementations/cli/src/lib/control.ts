import {
  DEFAULT_SPACE,
  DEV_OWNER,
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  GOAL_BEARING_COMMANDS,
  invokeCommand,
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
import { authDir, endpointAuth, findCotalRoot, loadSpaceAuth, soleSpaceOf } from "@cotal-ai/workspace";
import { c, staleStoreHint } from "../ui.js";
import { connectOrExit, type ConnectFlags } from "./connect.js";

/** Endpoint auth material for one control call — a static/raw cred OR user-mode bearer+sentinel
 *  (spread into the endpoint verbatim), plus the minted instrument's v0.4 caller triple when the
 *  static mint produced one ({@link askManager}'s ep-rail path rides it). */
export type ControlAuth = { creds?: string; bearer?: string; sentinelCreds?: string; epCaller?: EpCaller };

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
): Promise<{ space: string; server: string; auth: ControlAuth }> {
  const withSpace = flags.creds
    ? { ...flags, space: flags.space ?? soleSpaceOf(authDir(findCotalRoot())) ?? DEFAULT_SPACE }
    : flags;
  // USER MODE rides through: the control call connects with the operator's bearer (actor `cli`) and
  // publishes on its OWN ctl principal subject — the broker grants that publish only when the cli
  // actor's ledger scope carries the matching capability (`spawn` → privileged, `admin` → admin).
  const conn = await connectOrExit(withSpace, profile);
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
 *  a `ps` read first — the wire target is (owner, actor, lifecycleUid), never an alias). */
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
  instanceId?: string,
): Promise<ControlReply> {
  const mapped = EP_COMMANDS[op];
  if (!mapped) return { ok: false, error: `unknown manager op "${op}" (no v0.4 command mapping)` };
  const caller = auth.epCaller!;
  // standaloneConnectOpts handles all three auth shapes: static creds, the user bearer + sentinel
  // (client-chosen inbox nonce; the callout scopes the reply inbox on it), or BARE on an open
  // mesh (no credential system; the broker enforces nothing).
  const nc = await connect({
    servers: server,
    ...standaloneConnectOpts(auth.creds ? { creds: auth.creds } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds } : {}),
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
    const msg = e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message;
    return { ok: false, error: `no manager reachable on the ep rails (${msg})` };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
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
  instanceId?: string,
): Promise<ControlReply> {
  // A user bearer or a minted static instrument carries its own ep caller triple: ride it.
  if (auth.epCaller && (auth.creds || (auth.bearer && auth.sentinelCreds)))
    return askManagerEp(space, server, op, args, auth, reach, timeoutMs, instanceId);
  // A raw `--creds` file with NO minted triple is a pre-1c generation's cred (no ep rows). The ctl
  // rail it used to ride is gone (1d), so refuse loud with the recovery rather than hang.
  if (auth.creds)
    return { ok: false, error: `this --creds file predates the v0.4 control surface (no endpoint-serve rows); re-mint it with a current cotal, or drive the manager from its project folder (\`cotal ps\`/\`cotal stop\`) which mints the instrument for you` };
  // OPEN mesh: no credential system. The manager registered its service under DEV_OWNER and the
  // broker enforces nothing, so synthesize a fresh DEV_OWNER caller triple and connect bare.
  const openAuth: ControlAuth = { epCaller: { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() } };
  return askManagerEp(space, server, op, args, openAuth, reach, timeoutMs, instanceId);
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
    ...standaloneConnectOpts(auth.creds ? { creds: auth.creds } : auth.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds } : {}),
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
    const msg = e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message;
    return { ok: false, error: `no manager reachable on the ep rails (${msg})` };
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
