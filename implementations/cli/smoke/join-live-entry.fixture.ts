// Subprocess entry for join-durable-dedup-live.smoke.ts: runs the SRC `join` command (never the
// built dist, so the suite cannot pass on a stale build). JOIN_VALUES carries the flag values as JSON.
import { join } from "../src/commands/join.js";

await join({ values: JSON.parse(process.env.JOIN_VALUES!), positionals: [], raw: [] });
