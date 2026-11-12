import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Inherited only from the E2E native launcher wrapper. Do not inspect other environment keys
// or unrelated processes. The marker is the shipped daemon's private Manager subcommand.
if (process.argv[2] === "__machine-manager") {
  const output = join(dirname(fileURLToPath(import.meta.url)), "manager-path.jsonl");
  let previous;
  const record = () => {
    const path = process.env.PATH ?? "";
    if (path === previous) return;
    previous = path;
    appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
      parentPid: process.ppid, path, pathExt: process.env.PATHEXT ?? null }) + "\n");
  };
  record();
  setInterval(record, 500).unref();
}
