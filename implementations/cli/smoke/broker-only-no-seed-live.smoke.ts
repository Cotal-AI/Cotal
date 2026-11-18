/** Broker-only startup must not install application connectors. Uses the built CLI and real
 *  brokers with npm absent from PATH, retains its private roots and logs, and stops every stack. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { emitSentinel, freePort, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { finishOwnedChild, observeOwnedChild, waitForOwnedChild } from "./_foreground-owned-child.js";

if (process.platform !== "linux") {
  console.log("SKIP broker-only-no-seed: Linux fixture executable links required");
  emitSentinel({ passed: 0, failed: 0 });
  process.exit(0);
}

const cli = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}broker-only-no-seed-`));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "FORCE_COLOR"));
let passed = 0;
console.log(`broker-only-no-seed retained evidence: ${root}`);

function onPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  throw new Error(`required fixture executable is not on PATH: ${name}`);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

for (const scenario of ["detached", "controller", "foreground", "newer-store", "managed-control"] as const) {
  const base = join(root, scenario), project = join(base, "project"), home = join(base, "home"), xdg = join(base, "xdg"), bin = join(base, "bin");
  for (const path of [project, join(project, ".cotal"), home, xdg, bin, join(base, "runtime")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  // Keep only the native prerequisites. Neither npm nor npx can resolve through this PATH.
  for (const name of ["node", "nats-server", "git", "sh"]) symlinkSync(onPath(name), join(bin, name));
  const seed = join(xdg, "cotal", "seed");
  const stamp = JSON.stringify({ generation: "99.0.0" }) + "\n";
  if (scenario === "newer-store") {
    mkdirSync(seed, { recursive: true, mode: 0o700 });
    writeFileSync(join(seed, "stamp.json"), stamp, { mode: 0o600 });
  }
  const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: join(base, "runtime"), PATH: bin, COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
  let serial = 0;
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    const child = spawnSync(process.execPath, [cli, ...args], { cwd: project, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 90_000 });
    const label = `${serial++}-${args[0]}`;
    writeFileSync(join(base, `${label}.stdout`), child.stdout ?? "", { mode: 0o600 });
    writeFileSync(join(base, `${label}.stderr`), child.stderr ?? "", { mode: 0o600 });
    writeFileSync(join(base, `${label}.status.json`), JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message }), { mode: 0o600 });
    return { status: child.status, text: (child.stdout ?? "") + (child.stderr ?? "") };
  };
  const space = `no-seed-${scenario}`;
  const port = await freePort();
  assert.notEqual(port, 4222);
  const args = ["up", "--space", space, "--server", `nats://127.0.0.1:${port}`, ...(scenario === "managed-control" ? [] : ["--no-manager"])];
  let foreground: ReturnType<typeof spawn> | undefined;
  let state: ReturnType<typeof observeOwnedChild> | undefined;
  let output = "";
  try {
    if (scenario === "controller") {
      // Prepare the controller route separately. Only the startup under test runs with seeding live.
      const prepared = run(["space", "create", space, "--root", project], { COTAL_SKIP_CONNECTOR_SEED: "1" });
      assert.equal(prepared.status, 0, prepared.text);
      passed++;
    }
    if (scenario === "foreground") {
      foreground = spawn(process.execPath, [cli, ...args, "--foreground"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
      state = observeOwnedChild(foreground);
      foreground.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
      foreground.stderr!.on("data", (data: Buffer) => { output += data.toString(); });
      await waitForOwnedChild(() => output.includes("--no-manager starts no local daemon-credential renewal owner") || state!.exited || state!.error !== undefined, 90_000, "foreground stack readiness");
      assert.equal(state.exited, false, output);
      assert.equal(state.error, undefined);
      assert.match(output, /--no-manager starts no local daemon-credential renewal owner/);
      passed++;
    } else {
      const up = run(args);
      if (scenario === "managed-control") {
        assert.equal(up.status, 5, up.text);
        assert.match(up.text, /connector seed failed.*npm is not on PATH/);
        assert.equal(await portOpen(port), false);
        passed++;
        continue;
      }
      assert.equal(up.status, 0, up.text);
      assert.doesNotMatch(up.text, /Reconciling built-in|connector seed failed/);
      passed++;
      const refresh = run(["up", "--space", space, "--no-manager"]);
      assert.equal(refresh.status, 0, refresh.text);
      assert.doesNotMatch(refresh.text, /Reconciling built-in|connector seed failed/);
      passed++;
    }
    assert.equal(await portOpen(port), true);
    assert.doesNotMatch(output, /Reconciling built-in|connector seed failed/);
    const config = join(xdg, "cotal");
    if (scenario === "newer-store") {
      assert.equal(readFileSync(join(seed, "stamp.json"), "utf8"), stamp);
      assert.deepEqual(readdirSync(seed), ["stamp.json"]);
      assert.deepEqual(readdirSync(config), ["seed"]);
    } else {
      assert.equal(existsSync(config) && readdirSync(config, { recursive: true }).some(path => /(?:^|[/\\])(?:seed|extensions)(?:$|[/\\])/.test(String(path))), false, "broker-only startup wrote a connector seed store or extension prefix");
    }
    passed++;
  } finally {
    try {
      if (await portOpen(port)) {
        const down = run(["down", "--yes"]);
        assert.equal(down.status, 0, down.text);
      }
      if (foreground && state) {
        await waitForOwnedChild(() => state!.closed, 15_000, "foreground stack stopped by down");
        assert.equal(state.code, 0, output);
      }
    } finally {
      if (foreground && state) {
        await finishOwnedChild(foreground, state, () => {}, () => [], "broker-only foreground owner");
        writeFileSync(join(base, "foreground.log"), output, { mode: 0o600 });
      }
    }
    assert.equal(await portOpen(port), false, "owned listener survived shutdown");
  }
}
emitSentinel({ passed, failed: 0 });
