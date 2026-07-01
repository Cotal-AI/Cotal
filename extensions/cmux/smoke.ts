/**
 * Security smoke for @cotal-ai/cmux — proves the pane launcher never exposes the agent's env secrets:
 * the script is written 0o600 inside a fresh 0o700 dir (not a world-readable /tmp file at a
 * predictable path), and the secret env VALUES live only in that owner-only file, never in the
 * returned `bash <path>` command. Exercises paneCommand directly, so it needs no cmux CLI and runs in
 * CI. Run: pnpm smoke:cmux
 */
import { rmSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { paneCommand } from "./src/runtime.js";

let passed = 0;
let failed = 0;
function ok(label: string, val: unknown): void {
  if (val) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

const SECRET = "leak-canary-cmux-DO-NOT-LEAK";
const cmd = paneCommand(
  { command: "/bin/echo", args: ["hi"], env: { COTAL_CONTROL_TOKEN: SECRET }, cwd: "/tmp" },
  false,
  true, // isolate (P3): the agent gets ONLY the connector-declared env
);

ok("paneCommand returns a `bash <path>` invocation", /^bash '\/.*\/launch\.sh'$/.test(cmd));
const scriptPath = cmd.replace(/^bash\s+(?:-l\s+)?'|'$/g, "");
ok("launcher script is 0o600 (owner-only, never world-readable)", (statSync(scriptPath).mode & 0o777) === 0o600);
ok("launcher dir is 0o700 (owner-only)", (statSync(dirname(scriptPath)).mode & 0o777) === 0o700);
ok("returned command does NOT contain the secret (no argv leak)", !cmd.includes(SECRET));
ok("secret lives in the launcher script (read from the file, not the command line)", readFileSync(scriptPath, "utf8").includes(SECRET));

try {
  rmSync(dirname(scriptPath), { recursive: true, force: true });
} catch {
  /* best-effort cleanup */
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
