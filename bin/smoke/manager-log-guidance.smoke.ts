/**
 * Operator-facing manager log guidance must resolve from the same writer-owned path template.
 *
 * This is a source contract because the two failure branches are expensive/live control paths and the
 * up success branch cannot be run safely in this review environment. The value assertion calls the
 * exact helper used by output; source cells require each shipped message to call that helper rather
 * than restating a filename. The writer cell requires the detached-manager writer to use the helper
 * that the display path wraps, so a future template change cannot move one side alone.
 *
 * Run: pnpm smoke:manager-log-guidance
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { managerLogDisplayPath, managerLogPath } from "../../implementations/cli/src/lib/manager-proc.js";

const REPO = join(import.meta.dirname, "..", "..");
let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

const root = join(REPO, ".operator-path-probe");
const space = "Ops West";
const written = managerLogPath(space, root);
const displayed = managerLogDisplayPath(space, root);
const managerProc = readFileSync(join(REPO, "implementations/cli/src/lib/manager-proc.ts"), "utf8");
check(
  "the operator path is the writer-owned manager logfile relative to the mesh root",
  join(root, displayed) === written,
  { written, displayed },
);
check(
  "managerLogPath derives from the workspace-owned MANAGER_LOGFILE template",
  /canonicalLocalProcessPath\(MANAGER_LOGFILE, \{ root, space \}\)/.test(managerProc),
);
check(
  "the detached manager writer opens managerLogPath instead of deriving its own filename",
  /const logPath = managerLogPath\(space\);/.test(managerProc),
);
check(
  "the detached manager opens its logfile descriptor on the managerLogPath value",
  /const fd = openSync\(logPath, "a", 0o600\);/.test(managerProc),
);

const spawn = readFileSync(join(REPO, "implementations/cli/src/commands/spawn-manifest.ts"), "utf8");
const up = readFileSync(join(REPO, "implementations/cli/src/commands/up.ts"), "utf8");
check(
  "the held-lease refusal derives its logfile guidance",
  /after its TTL - stop it or check \$\{managerLogDisplayPath\(space\)\}/.test(spawn),
);
check(
  "the manager-readiness refusal derives its logfile guidance",
  /did not become ready for control - see \$\{managerLogDisplayPath\(space\)\}/.test(spawn),
);
check(
  "the up success line derives its logfile guidance",
  /via manager .* - see \$\{managerLogDisplayPath\(m\.space\)\}/.test(up),
);
check(
  "no shipped operator message names the pre-segmentation manager logfile",
  !spawn.includes(".cotal/manager.log") && !up.includes(".cotal/manager.log"),
);

console.log(`MANAGER LOG GUIDANCE: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
