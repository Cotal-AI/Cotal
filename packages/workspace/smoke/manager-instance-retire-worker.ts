/* Competing child writer for the native retirement race suite. No identity material travels in argv. */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { saveManagerInstanceIdentity, spaceSegment } from "../src/auth-paths.js";

const root = process.env.COTAL_RETIRE_TEST_ROOT;
const action = process.env.COTAL_RETIRE_TEST_ACTION;
if (!root || !action) throw new Error("retirement race worker needs its fixture root and action");
const space = "concurrent";
if (action === "remove") {
  rmSync(join(root, ".cotal", spaceSegment(space), "manager-instance.json"));
} else if (/^[bcde]$/.test(action)) {
  saveManagerInstanceIdentity(root, space, {
    instanceId: `inst-race-${action}`,
    serveIdentity: { id: `Urace-${action}`, seed: `seed-race-${action}` },
  });
} else {
  throw new Error(`unknown race action: ${action}`);
}
