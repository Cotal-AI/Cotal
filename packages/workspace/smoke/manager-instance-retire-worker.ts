/* Competing child writer for the native retirement race suite. No identity material travels in argv. */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFile } from "@cotal-ai/core";
import { spaceSegment } from "../src/auth-paths.js";

const root = process.env.COTAL_RETIRE_TEST_ROOT;
const action = process.env.COTAL_RETIRE_TEST_ACTION;
if (!root || !action) throw new Error("retirement race worker needs its fixture root and action");
const space = "concurrent";
const file = join(root, ".cotal", spaceSegment(space), "manager-instance.json");
if (action === "remove") {
  rmSync(file);
} else if (/^[bcde]$/.test(action)) {
  writeSecretFile(file, JSON.stringify({
    instanceId: `inst-race-${action}`,
    serveIdentity: { id: `Urace-${action}`, seed: `seed-race-${action}` },
  }));
} else {
  throw new Error(`unknown race action: ${action}`);
}
