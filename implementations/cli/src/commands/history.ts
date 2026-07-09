import { clearSpaceHistory, type ParsedArgs } from "@cotal-ai/core";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { c } from "../ui.js";

/** Administrative history operations. Purges JetStream backlog only; live in-process
 *  agent buffers may still contain messages already delivered before the purge. */
export async function history(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as { server?: string; space?: string; creds?: string; dms?: boolean; force?: boolean };

  if (positionals[0] !== "clear") return usage();
  if (!values.force) {
    console.error(c.red("refusing to clear history without --force"));
    console.error(c.dim("usage: cotal history clear --force [--dms] [--space <s>] [--server <url>]"));
    process.exit(1);
  }

  // Resolve the running mesh (from any dir) + a least-privilege PURGER cred — `--creds` is a raw
  // off-registry connect. `history clear` is purge-only and destructive, so it mints exactly the purge
  // grant (STREAM.PURGE on CHAT + DM), not the broad operator cred; targeting the RIGHT mesh matters, so
  // this no longer blindly hits DEFAULT_SERVER + the cwd space.
  const conn = await connectOrExit(values, "purger");
  // USER MODE: the destructive purge rides a one-shot "purger" VIEW bearer, exchange-gated on
  // ledger scope "admin" (the refusal names the exact re-grant).
  const user = conn.bearer ? await userViewAuthOrExit(conn, "purger") : undefined;
  const { server, space, creds } = conn;
  const result = await clearSpaceHistory({
    servers: server,
    space,
    ...(user ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds } : { creds }),
    includeDms: values.dms,
  });

  const dm = result.dm === undefined ? "" : `, ${result.dm} DM message${result.dm === 1 ? "" : "s"}`;
  console.log(c.green(`✓ cleared ${result.chat} channel message${result.chat === 1 ? "" : "s"}${dm} from "${space}"`));
}

function usage(): void {
  console.error(c.red("usage: cotal history clear --force [--dms] [--space <s>] [--server <url>] [--creds <path>]"));
  process.exit(1);
}
