import { parseArgs } from "node:util";
import { clearSpaceHistory } from "@cotal-ai/core";
import { connectOrExit } from "../lib/connect.js";
import { c } from "../ui.js";

/** Administrative history operations. Purges JetStream backlog only; live in-process
 *  agent buffers may still contain messages already delivered before the purge. */
export async function history(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      space: { type: "string" },
      creds: { type: "string" },
      dms: { type: "boolean" },
      force: { type: "boolean" },
    },
  });

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
  const { server, space, creds } = await connectOrExit(values, "purger");
  const result = await clearSpaceHistory({
    servers: server,
    space,
    creds,
    includeDms: values.dms,
  });

  const dm = result.dm === undefined ? "" : `, ${result.dm} DM message${result.dm === 1 ? "" : "s"}`;
  console.log(c.green(`✓ cleared ${result.chat} channel message${result.chat === 1 ? "" : "s"}${dm} from "${space}"`));
}

function usage(): void {
  console.error(c.red("usage: cotal history clear --force [--dms] [--space <s>] [--server <url>] [--creds <path>]"));
  process.exit(1);
}
