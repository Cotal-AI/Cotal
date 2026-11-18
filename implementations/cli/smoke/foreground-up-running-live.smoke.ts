/** `cotal up --foreground` against a stack that is already running must refuse. The refresh path
 * starts nothing in this terminal, so it cannot keep the stack's lifetime here. It used to print
 * `✓ already running` and exit 0, and a service unit that relies on `--foreground` then treated
 * that exit as the stack ending. Uses a private home/root and an allocated loopback port, starts
 * no agents, and retains the sandbox and logs. An external `down --yes` of a named or folder-named
 * foreground stack must exit cleanly without crash diagnostics or claims about its registration.
 * Run: pnpm smoke:foreground-up-running:live */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";
import { finishOwnedChild, observeOwnedChild, waitForOwnedChild } from "./_foreground-owned-child.js";
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

async function externalDown(folderNamed: boolean): Promise<void> {
  const cell = join(base, folderNamed ? "folder-stop" : "named-stop");
  const mesh = join(cell, "folder_fg"), home = join(cell, "home");
  const space = folderNamed ? "folder_fg" : "custom_fg";
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: join(home, "runtime"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const port = await freePort(); assert.notEqual(port, 4222);
  const server = `nats://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(wt, "bin/dist/cotal.js"), "up", "--foreground", "--server", server, ...(folderNamed ? [] : ["--space", space])], { cwd: mesh, env, stdio: ["ignore", "pipe", "pipe"] });
  const state = observeOwnedChild(child);
  let out = "", err = "";
  child.stdout.on("data", (data: Buffer) => { out += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { err += data.toString(); });
  const logs: Record<string, unknown> = {};
  try {
    let ready = false;
    const deadline = Date.now() + 120_000;
    while (!ready && Date.now() < deadline) {
      if (state.error) throw state.error;
      assert.equal(state.exited, false, `foreground owner remains live until readiness: ${err}`);
      const status = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["status", "--components", "--space", space, "--server", server]);
      logs.status = status;
      ready = status.code === 0 && ["broker", "manager", "delivery"].every((name) => new RegExp(`^\\s*${name}\\s+serving\\b`, "m").test(status.out));
      if (!ready) await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, `all three components serve before external down: ${JSON.stringify(logs.status)} ${err}`); passed++;
    assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
    const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
    logs.down = down;
    assert.equal(down.code, 0, `external down succeeds: ${down.out}${down.err}`); passed++;
    await waitForOwnedChild(() => state.exited, 20_000, "externally stopped foreground up exits");
    await waitForOwnedChild(() => state.closed, 3_000, "externally stopped foreground streams drain");
    assert.equal(state.code, 0, "foreground up exits cleanly after external down"); passed++;
    assert.doesNotMatch(err, /nats-server exited unexpectedly|stays recorded|repair:/, "clean down emits neither crash diagnostic nor registry retention claim"); passed++;
    assert.equal(await portOpen(port), false, "external down closes the broker listener"); passed++;
    const meshes = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["meshes"]);
    logs.meshes = meshes;
    assert.equal(meshes.code, 0, meshes.err); passed++;
    if (folderNamed) assert.match(meshes.out, /folder_fg[^\n]*offline/, "folder-named registration remains offline");
    else assert.match(meshes.out, /no meshes registered/, "explicitly named registration was removed");
    passed++;
    console.log(`PASS foreground external down: ${folderNamed ? "folder-named" : "explicitly named"}`);
  } finally {
    try {
      if (await portOpen(port)) {
        assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
        logs.cleanup = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
      }
    } finally {
      await finishOwnedChild(child, state, () => {}, () => [], "external down foreground owner");
      writeFileSync(join(cell, "stdout.log"), out, { mode: 0o600 });
      writeFileSync(join(cell, "stderr.log"), err, { mode: 0o600 });
      writeFileSync(join(cell, "probes.json"), JSON.stringify(logs), { mode: 0o600 });
    }
  }
}

await externalDown(false);
await externalDown(true);
console.log(`foreground-up-running: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
