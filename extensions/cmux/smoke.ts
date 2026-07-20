/**
 * Security smoke for @cotal-ai/cmux — proves the pane launcher never exposes the agent's env secrets:
 * the script is written 0o600 inside a fresh 0o700 dir (not a world-readable /tmp file at a
 * predictable path), and the secret env VALUES live only in that owner-only file, never in the
 * returned `bash <path>` command. Exercises paneCommand directly, so it needs no cmux CLI and runs in
 * CI. Run: pnpm smoke:cmux
 */
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CmuxRuntime, paneCommand } from "./src/runtime.js";
import { waitForWorkspaceExit } from "./src/driver.js";

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

async function rejects(label: string, fn: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
  try {
    await fn();
    ok(`${label} (expected rejection)`, false);
  } catch (err) {
    ok(label, !pattern || pattern.test((err as Error).message));
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

if (process.platform !== "win32") {
  const stubDir = mkdtempSync(join(tmpdir(), "cotal-cmux-wait-"));
  const stub = join(stubDir, "cmux-stub");
  const state = join(stubDir, "workspace-open");
  const previousBin = process.env.CMUX_BUNDLED_CLI_PATH;
  const previousTmp = process.env.TMPDIR;
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)};
const id = "11111111-1111-4111-8111-111111111111";
if (args.includes("ping")) process.exit(0);
if (args.includes("new-workspace")) { fs.writeFileSync(state, "open"); process.stdout.write(id); process.exit(0); }
if (args.includes("list-workspaces")) { if (fs.existsSync(state)) process.stdout.write("workspace:77 " + id + " cotal-stop-agent"); process.exit(0); }
if (args.includes("close-workspace")) { fs.rmSync(state, { force: true }); process.stdout.write("OK"); process.exit(0); }
process.stdout.write("OK");
`,
    { mode: 0o700 },
  );
  try {
    process.env.CMUX_BUNDLED_CLI_PATH = stub;
    process.env.TMPDIR = stubDir;
    writeFileSync(state, "open");
    setTimeout(() => rmSync(state, { force: true }), 5);
    await waitForWorkspaceExit("11111111-1111-4111-8111-111111111111", {
      timeoutMs: 500,
      pollMs: 1,
    });
    ok("waitForWorkspaceExit resolves on authoritative disappearance", true);

    writeFileSync(state, "open");
    await rejects(
      "waitForWorkspaceExit times out while the workspace still exists",
      () => waitForWorkspaceExit("11111111-1111-4111-8111-111111111111", {
        timeoutMs: 50,
        pollMs: 1,
      }),
      /did not close within 50ms/,
    );

    process.env.CMUX_BUNDLED_CLI_PATH = join(stubDir, "missing-cmux");
    await rejects(
      "waitForWorkspaceExit fails loud when cmux state is unknown",
      () => waitForWorkspaceExit("11111111-1111-4111-8111-111111111111", {
        timeoutMs: 50,
        pollMs: 1,
      }),
      /couldn't prove workspace/,
    );
    process.env.CMUX_BUNDLED_CLI_PATH = stub;

    const handle = new CmuxRuntime().spawn(
      "stop-agent",
      { command: "/bin/sleep", args: ["30"], env: {} },
      "/tmp",
    );
    ok("cmux runtime handle implements waitForExit", typeof handle.waitForExit === "function");
    ok("cmux handle reports running from exact workspace inventory", handle.status() === "running");
    handle.stop({ graceful: false });
    await handle.waitForExit!();
    ok("cmux stop -> waitForExit proves workspace disappearance", handle.status() === "exited");
    ok("stub workspace was closed", !existsSync(state));
  } finally {
    if (previousBin === undefined) delete process.env.CMUX_BUNDLED_CLI_PATH;
    else process.env.CMUX_BUNDLED_CLI_PATH = previousBin;
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(stubDir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
