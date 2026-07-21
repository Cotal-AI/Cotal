import {
  CotalEndpoint,
  DEFAULT_SPACE,
  CONTROL_PRIVILEGED,
  CONTROL_ADMIN,
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  invokeCommand,
  resolveService,
  standaloneConnectOpts,
  type ControlReply,
  type ControlTier,
  type EpCaller,
  type EpVerbTarget,
  type Profile,
} from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { authDir, endpointAuth, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
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
    ? { ...flags, space: flags.space ?? loadSpaceAuth(authDir(findCotalRoot()))?.space ?? DEFAULT_SPACE }
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

/** The ep-rail control call ({@link askManager}'s static path): one short-lived raw connection,
 *  a fresh `resolveService` (describe → §13.7 store fetch → digest-verified recompile — the
 *  generic item-5 caller, no hand-imported manager schemas), then the mapped command. Targeted
 *  ops resolve the alias to its CURRENT principal triple through `ps` first and ride mode `any`
 *  on the admin tier (the instrument's cross-agent reach) or `owner` on the privileged tier —
 *  exactly the v0.3 tier the same call rode on ctl. */
async function askManagerEp(
  space: string,
  server: string,
  op: string,
  args: Record<string, unknown> | undefined,
  auth: ControlAuth,
  tier: ControlTier,
  timeoutMs?: number,
): Promise<ControlReply> {
  const mapped = EP_COMMANDS[op];
  if (!mapped) return { ok: false, error: `unknown manager op "${op}" (no v0.4 command mapping)` };
  const caller = auth.epCaller!;
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds: auth.creds }), maxReconnectAttempts: 0 });
  try {
    const service = await resolveService(nc, space, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: 10_000 });
    let target: EpVerbTarget | undefined;
    let sendArgs = args;
    if (mapped.targeted) {
      const name = String(args?.name ?? "").trim();
      if (!name) return { ok: false, error: `${op} requires a name` };
      const ps = await invokeCommand(nc, space, service, "ps", undefined, { deadlineMs: 10_000 });
      if (ps.reply.ok !== true) return { ok: false, error: `could not resolve "${name}": ${ps.reply.error?.message ?? "ps failed"}` };
      const row = (ps.reply.data as { name: string; id: string; lifecycleUid: string }[]).find((r) => r.name === name);
      if (!row) return { ok: false, error: `no agent named "${name}"` };
      target = {
        mode: tier === CONTROL_ADMIN ? "any" : "owner",
        owner: caller.owner,
        actor: row.id,
        lifecycleUid: row.lifecycleUid,
      };
      const { name: _dropped, ...rest } = args ?? {};
      sendArgs = Object.keys(rest).length ? rest : undefined;
    }
    const r = await invokeCommand(nc, space, service, mapped.command, sendArgs, {
      ...(target ? { target } : {}),
      deadlineMs: timeoutMs ?? 10_000,
    });
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

/** Connect a short-lived client with the resolved creds, send one control request to the manager,
 *  disconnect. The target is already reachability- + auth-preflighted by
 *  {@link resolveControlTarget}, so this connects straight through. `tier` picks the control
 *  subject: privileged for spawn --detach/ps — and, on a user mesh, for stop/attach too (the
 *  operator's bearer publishes there with scope "spawn"; the MANAGER authorizes owner-domain vs
 *  ledger-admin). On a static mesh stop/attach stay admin-tier ops. `creds` is the tier-scoped
 *  caller cred (`control-caller-privileged` / `control-caller-admin` — each holds ONLY its own
 *  tier's pub grant), or undefined on an open mesh. */
export async function askManager(
  space: string,
  server: string,
  op: string,
  args?: Record<string, unknown>,
  auth: ControlAuth = {},
  tier: ControlTier = CONTROL_PRIVILEGED,
  timeoutMs?: number,
): Promise<ControlReply> {
  // STATIC-auth instruments ride the v0.4 ep rails (P2 item 1, 1c.2b) — the minted caller triple
  // marks the credential as carrying the ep rows. The ctl branch below remains for exactly the
  // surfaces whose ep path is not wired yet: OPEN meshes (no service registry to register in) and
  // USER-mode bearers (the ep caller-triple plumbing is the named 1c.2c follow-up) — both are
  // scheduled onto ep before 1d deletes the manager ctl rail, plus raw `--creds` files minted by
  // an older generation (no ep rows to ride).
  if (auth.epCaller && auth.creds) return askManagerEp(space, server, op, args, auth, tier, timeoutMs);
  const ep = new CotalEndpoint({
    space,
    servers: server,
    ...auth,
    channels: [],
    consume: false, // request/reply only — binds no consumers (and under auth has no pre-created DM durable)
    registerPresence: false,
    watchPresence: false,
    card: { name: "cli", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    return await ep.requestControl(tier, { op, args }, timeoutMs);
  } catch (e) {
    // A user-mode caller whose cli actor lacks the tier's scope gets a broker publish denial (the
    // red endpoint error above) and then this timeout — name the grant, not just the silence.
    // The re-grant REPLACES the scope list, so the hint must say "add", never a bare one-token
    // --scope that would silently strip the caller's spawn/role capabilities.
    const need = tier === CONTROL_ADMIN ? "admin" : "spawn";
    const scopeHint = auth.bearer
      ? ` - on a user-auth mesh this op needs scope "${need}" on your cli actor. Re-grant with "${need}" ADDED to your current scope (the upsert replaces the list; see \`cotal actor list\`), e.g. \`cotal actor grant cli --sub <your IdP subject> --scope 'spawn,role:default,${need}'\``
      : "";
    return { ok: false, error: `no manager reachable (${(e as Error).message})${scopeHint}` };
  } finally {
    await ep.stop();
  }
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
