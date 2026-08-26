/** Run the SHIPPED `web` command entry point in a child process, so a smoke can read the
 *  dashboard's real HTTP surface rather than a copy of it.
 *
 *  `implementations/web/src/index.ts` registers this exact function as the `web` command's `run`,
 *  and `web()` serves until it is signalled, so it cannot be awaited in-process by a suite that has
 *  assertions after it. Argument parsing here is the flag subset the suite passes; anything else is
 *  ignored rather than guessed at.
 *
 *  Not shipped and not imported by shipped code: this file lives under `smoke/`. */
import { web } from "../src/web.js";

const raw = process.argv.slice(2);
const values: Record<string, string | boolean> = {};
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (!a.startsWith("--")) continue;
  const next = raw[i + 1];
  if (next && !next.startsWith("--")) { values[a.slice(2)] = next; i++; } else values[a.slice(2)] = true;
}
await web({ values, positionals: [], raw } as never);
