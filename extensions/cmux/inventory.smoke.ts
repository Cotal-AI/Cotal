/** The published cmux inventory API distinguishes an empty listing from an unreadable one (#3211).
 *  Uses real CLI child processes with controlled answers; no cmux app, broker or agent is started.
 *  Run: pnpm smoke:cmux-inventory. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmux } from "./dist/index.js";

if (process.platform === "win32") {
  console.log("SKIP: cmux's POSIX executable fixture is not supported on Windows");
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
const root = mkdtempSync(join(tmpdir(), "cotal-cmux-inventory-"));
const stub = join(root, "cmux.cjs");
const modeFile = join(root, "mode");
const previous = process.env.CMUX_BUNDLED_CLI_PATH;
const uuid = "11111111-1111-4111-8111-111111111111";
writeFileSync(stub, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("list-workspaces")) process.exit(99);
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8");
if (mode === "error") { process.stderr.write("cmux fixture: socket unavailable\\n"); process.exit(7); }
if (mode === "empty") process.exit(0);
if (mode === "slow") {
  process.on("SIGTERM", () => {});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}
const both = args.includes("both");
process.stdout.write("* workspace:5 " + (both ? ${JSON.stringify(uuid + " ")} : "") + "cotal-probe [selected]\\nworkspace:6 other-tab\\n");
`, { mode: 0o700 });
const mode = (value: string) => writeFileSync(modeFile, value);
const readers: Array<[string, () => unknown]> = [
  ["listWorkspaces", () => cmux.listWorkspaces()],
  ["workspaceRefs", () => cmux.workspaceRefs("cotal-probe")],
  ["workspaceState", () => cmux.workspaceState("workspace:5")],
];

try {
  process.env.CMUX_BUNDLED_CLI_PATH = stub;
  mode("healthy");
  check("listWorkspaces preserves the default CLI line format", JSON.stringify(cmux.listWorkspaces()) === JSON.stringify(["* workspace:5 cotal-probe [selected]", "workspace:6 other-tab"]));
  check("workspaceRefs finds the requested label", JSON.stringify(cmux.workspaceRefs("cotal-probe")) === '["workspace:5"]');
  check("a missing label in a successful listing is empty", cmux.workspaceRefs("absent-label").length === 0);
  check("workspaceState recognizes the short ref", cmux.workspaceState("workspace:5") === "running");
  check("workspaceState still requests and recognizes UUIDs", cmux.workspaceState(uuid) === "running");

  mode("empty");
  for (const [name, read] of readers) {
    const value = await read();
    check(`${name} accepts a genuine empty inventory`, name === "workspaceState" ? value === "exited" : Array.isArray(value) && value.length === 0);
  }

  for (const failure of ["missing", "error", "slow"]) {
    process.env.CMUX_BUNDLED_CLI_PATH = failure === "missing" ? join(root, "missing-cmux") : stub;
    mode(failure);
    for (const [name, read] of readers) {
      let caught: unknown;
      try { await read(); } catch (error) { caught = error; }
      const cause = caught instanceof Error && caught.cause instanceof Error ? caught.cause : caught;
      const facts = cause as { code?: string; status?: number; signal?: string } | undefined;
      const expected = failure === "missing" ? facts?.code === "ENOENT"
        : failure === "error" ? facts?.status === 7
          : facts?.code === "ETIMEDOUT" && facts.signal === "SIGKILL";
      check(`${name} refuses ${failure === "slow" ? "a timed-out CLI and kills its child" : failure === "missing" ? "a missing CLI" : "a failed CLI"}`, caught instanceof Error && expected);
    }
  }
  if (passed + failed !== 17) throw new Error(`ran ${passed + failed} cells, expected 17`);
} catch (error) {
  failed++;
  console.error(`Unexpected fixture failure: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (previous === undefined) delete process.env.CMUX_BUNDLED_CLI_PATH;
  else process.env.CMUX_BUNDLED_CLI_PATH = previous;
  rmSync(root, { recursive: true, force: true });
}
console.log(`cmux-inventory: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
