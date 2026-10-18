import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Beside the plugin's `mcp.cjs`, written by `cotal setup`: the argv that runs the CLI. */
export const CLI_RECORD = "cli.json";

/** The argv in `dir/cli.json`, or a refusal that names the remedy. */
export function readCliRecord(dir: string): string[] {
  let argv: unknown;
  try {
    argv = (JSON.parse(readFileSync(join(dir, CLI_RECORD), "utf8")) as { argv?: unknown }).argv;
  } catch {
    argv = undefined;
  }
  if (!Array.isArray(argv) || argv.length < 2 || !argv.every((a) => typeof a === "string" && a))
    throw new Error("this Cotal plugin was not installed by `cotal setup`, so it cannot find the Cotal CLI. Run `cotal setup` again.");
  return argv as string[];
}
