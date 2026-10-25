// Subprocess entry for the join live suites: runs the SRC `join` command (never the built dist, so
// a suite cannot pass on a stale build). JOIN_VALUES carries the flag values as JSON. A join that
// ends with a refusal prints its code, message and Next, and exits 2 as `cotal join` does.
import { join } from "../src/commands/join.js";

try {
  await join({ values: JSON.parse(process.env.JOIN_VALUES!), positionals: [], raw: [] });
} catch (e) {
  const failure = e as { code?: string; message: string; remedy?: string };
  process.stderr.write(`REFUSED ${failure.code} ${failure.message}\nNEXT ${failure.remedy ?? ""}\n`);
  process.exit(2);
}
