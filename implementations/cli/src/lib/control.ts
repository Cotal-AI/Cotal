import {
  CotalEndpoint,
  DEFAULT_SPACE,
  CONTROL_PRIVILEGED,
  type ControlReply,
  type ControlTier,
  type Profile,
} from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { connectOrExit, type ConnectFlags } from "./connect.js";

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
): Promise<{ space: string; server: string; creds?: string }> {
  const withSpace = flags.creds
    ? { ...flags, space: flags.space ?? loadSpaceAuth(authDir(findCotalRoot()))?.space ?? DEFAULT_SPACE }
    : flags;
  const { space, server, creds } = await connectOrExit(withSpace, profile);
  return { space, server, creds };
}

/** Connect a short-lived client with the resolved creds, send one control request to the manager,
 *  disconnect. The target is already reachability- + auth-preflighted by
 *  {@link resolveControlTarget}, so this connects straight through. `tier` picks the control
 *  subject: privileged for spawn --detach/ps; admin for the operator's cross-agent ops
 *  (stop/attach), which the manager refuses on the privileged subject for a non-owner. `creds` is
 *  the tier-scoped caller cred (`control-caller-privileged` / `control-caller-admin` — each holds
 *  ONLY its own tier's pub grant), or undefined on an open mesh. */
export async function askManager(
  space: string,
  server: string,
  op: string,
  args?: Record<string, unknown>,
  creds?: string,
  tier: ControlTier = CONTROL_PRIVILEGED,
  timeoutMs?: number,
): Promise<ControlReply> {
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
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
    return { ok: false, error: `no manager reachable (${(e as Error).message})` };
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
