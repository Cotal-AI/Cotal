// The connect-or-exit wrappers moved into `@cotal-ai/workspace` (stage 4) so every command
// surface — this CLI, cotal-web, @cotal-ai/demo — resolves meshes identically. Re-exported here
// so existing importers (and `connect.smoke.ts`) keep resolving them from this module unchanged.
export {
  connectOrExit,
  endpointAuth,
  reachableOrExit,
  resolveTargetOrExit,
  preflightOrExit,
  classifyPreflightFailure,
  type ConnectFlags,
  type Connection,
  type RawAuth,
  type PreflightFailure,
} from "@cotal-ai/workspace";

import type { Connection } from "@cotal-ai/workspace";
import { c } from "../ui.js";

/** Guard for commands whose job needs an OPERATOR-profile credential (admin/purger/channel-writer/
 *  control-caller/deployer) that a user-mode login's ledger-scoped bearer cannot carry. The refusal
 *  is explicit and names the deliberate escape hatch — `cotal mint` where the broker runs, then
 *  `--creds` — so there is a path, but never a silent static fallback (U10). */
export function refuseUserModeOrExit(conn: Connection, what: string): void {
  if (!conn.bearer) return;
  console.error(
    c.red(
      `✗ ${what} is not yet supported over a user-mode login on space "${conn.space}" — it needs an operator credential: mint one where the broker runs (\`cotal mint <name> --profile <profile>\`) and pass it with --creds`,
    ),
  );
  process.exit(1);
}
