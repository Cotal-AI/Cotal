import { type ParsedArgs } from "@cotal-ai/core";
import { c } from "../ui.js";
import { purgeHistory } from "./clean.js";

/** `cotal history clear` - a thin alias of `cotal clean history` (the canonical cleanup verb).
 *  Purges the JetStream backlog only; live in-process agent buffers may still contain messages
 *  already delivered before the purge. */
export async function history(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as { server?: string; space?: string; creds?: string; dms?: boolean; force?: boolean };

  if (positionals[0] !== "clear") return usage();
  if (!values.force) {
    console.error(c.red("refusing to clear history without --force"));
    console.error(c.dim("usage: cotal history clear --force [--dms] [--space <s>] [--server <url>]"));
    process.exit(1);
  }
  await purgeHistory(values);
}

function usage(): void {
  console.error(c.red("usage: cotal history clear --force [--dms] [--space <s>] [--server <url>] [--creds <path>]"));
  process.exit(1);
}
