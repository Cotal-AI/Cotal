/** `cotal up --foreground` against a stack that is already running must refuse. The refresh path
 * starts nothing in this terminal, so it cannot keep the stack's lifetime here. It used to print
 * `✓ already running` and exit 0, and a service unit that relies on `--foreground` then treated
 * that exit as the stack ending. Uses a private home/root and an allocated loopback port, starts
 * no agents, and retains the sandbox and logs.
 * Run: pnpm smoke:foreground-up-running:live */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const wt = resolve(import.meta.dirname, "../../..");
const cliEntry = join(wt, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const base = mkdtempSync(join(tmpdir(), "cotal-foreground-running-"));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COTAL_|CLAUDE_|ANTHROPIC_|OPENAI_|JCODE_)/i.test(k)));
let passed = 0;

function portOpen(port: number): Promise<boolean> {
  return new Promise((r) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); r(value); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

const home = join(base, "home"), mesh = join(base, "mesh");
for (const p of [home, mesh, join(mesh, ".cotal"), join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
const port = await freePort(); assert.notEqual(port, 4222);
const space = "foreground-running";
const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const stack = ["--server", `nats://127.0.0.1:${port}`, "--space", space, "--open", "--no-manager"];
const logs: Record<string, { code: number | null; out: string; err: string }> = {};
console.log(`foreground-up-running retained evidence: ${base}`);
try {
  logs.detached = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up", "--detach", ...stack]);
  assert.equal(logs.detached.code, 0, `the detached stack starts: ${logs.detached.err}`); passed++;
  assert.equal(await portOpen(port), true, "the detached broker listens"); passed++;

  logs.foreground = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up", "--foreground", ...stack]);
  assert.notEqual(logs.foreground.code, 0, `foreground up over a running stack must not succeed: ${logs.foreground.out}`); passed++;
  assert.match(logs.foreground.err, /already running .* can't keep it in this terminal/, "the refusal names the running stack"); passed++;
  assert.doesNotMatch(logs.foreground.out, /already running at/, "no success line is printed over the refusal"); passed++;
  assert.equal(await portOpen(port), true, "the refusal leaves the running broker alone"); passed++;
  console.log("PASS foreground-up-running");
} finally {
  try {
    if (await portOpen(port)) {
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
      logs.down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"]);
    }
  } finally {
    for (const [name, log] of Object.entries(logs)) writeFileSync(join(base, `${name}.json`), JSON.stringify(log), { mode: 0o600 });
  }
}
assert.equal(await portOpen(port), false, "cleanup stopped the broker"); passed++;
console.log(`foreground-up-running: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
