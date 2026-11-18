// Runs one cotal-lang program on the tree-walker (language version 1) in its own process, with the
// simulator handler, and prints `RESULT <json>`: the outcome, and each log line as the JSON of its
// values. Used by worker-memory.smoke.ts so a walker program that took the process down shows as this
// child's exit rather than the suite's.
import { readFileSync } from "node:fs";
import { SimHandler, run } from "@cotal-ai/lang";

const source = readFileSync(process.argv[2]!, "utf8");
const logs: string[] = [];
const outcome = await run(source, { runId: "walker", handler: new SimHandler({}), onLog: (line) => logs.push(JSON.stringify(line.values)) }).then(
  () => ({ ok: true }),
  (e: Error & { code?: string }) => ({ ok: false, code: e.code, message: String(e.message).slice(0, 300) }),
);
console.log(`RESULT ${JSON.stringify({ ...outcome, logs })}`);
