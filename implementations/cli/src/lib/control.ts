import {
  CotalEndpoint,
  DEFAULT_SPACE,
  CONTROL_PRIVILEGED,
  CONTROL_ADMIN,
  type ControlReply,
  type ControlTier,
  type Profile,
} from "@cotal-ai/core";
import { authDir, endpointAuth, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { connectOrExit, type ConnectFlags } from "./connect.js";

/** Endpoint auth material for one control call — a static/raw cred OR user-mode bearer+sentinel
 *  (spread into the endpoint verbatim). */
export type ControlAuth = { creds?: string; bearer?: string; sentinelCreds?: string };

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
  return { space: conn.space, server: conn.server, auth: endpointAuth(conn) };
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
      ? ` — on a user-auth mesh this op needs scope "${need}" on your cli actor. Re-grant with "${need}" ADDED to your current scope (the upsert replaces the list; see \`cotal actor list\`), e.g. \`cotal actor grant cli --sub <your IdP subject> --scope 'spawn,role:default,${need}'\``
      : "";
    return { ok: false, error: `no manager reachable (${(e as Error).message})${scopeHint}` };
  } finally {
    await ep.stop();
  }
}

export function failIfNotOk(reply: ControlReply): void {
  if (!reply.ok) {
    console.error(c.red(`✗ ${reply.error ?? "error"}`));
    process.exit(1);
  }
}
