import {
  CONTROL_ADMIN,
  mintCreds,
  newIdentity,
  type ControlReply,
  type ControlTier,
  type SpaceAuth,
} from "@cotal-ai/core";
import { askManager } from "../lib/control.js";

/** Everything the console needs to reach the manager's control plane, threaded from the
 *  command's resolved connection. `auth` present ⇔ auth mesh (we mint per action); `creds`
 *  is an operator-passed `--creds` file's contents (used as-is); both absent ⇔ open mesh. */
export interface ControlCtx {
  space: string;
  server: string;
  auth?: SpaceAuth;
  creds?: string;
}

/**
 * One control request from the console, with per-action authorization — the console analog of
 * the CLI's `stop`/`attach` flow and the web's channel-purger mint: the console's own observer
 * cred is read-only by design (no `ctl.*` publish), so each action mints an EPHEMERAL,
 * tier-scoped caller cred (5-min TTL, `control-caller-admin`/`-privileged` — each holds only its
 * own tier's publish grant) from the held trust material, uses it for one request/reply on a
 * transient endpoint, and lets it fall out of scope. Nothing touches disk. On an open mesh the
 * request goes bare; an explicit `--creds` is trusted as the operator's chosen authority.
 */
export async function control(
  ctx: ControlCtx,
  op: string,
  args: Record<string, unknown>,
  tier: ControlTier,
): Promise<ControlReply> {
  const callCreds = ctx.auth
    ? await mintCreds(
        ctx.auth,
        newIdentity(),
        tier === CONTROL_ADMIN ? "control-caller-admin" : "control-caller-privileged",
      )
    : ctx.creds;
  return askManager(ctx.space, ctx.server, op, args, callCreds, tier);
}
