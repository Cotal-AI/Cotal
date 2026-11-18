/** Broker-only starts and refreshes use native infrastructure even when connectors cannot seed. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox, skipSuite } from "@cotal-ai/smoke-kit";
import { finishOwnedChild, observeOwnedChild, waitForOwnedChild } from "./_foreground-owned-child.js";

if (process.platform === "win32") skipSuite("restricted POSIX PATH fixture");
const cli = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const scratch = mkdtempSync(join(tmpdir(), "cotal-broker-only-no-seed-"));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COTAL_|CLAUDE_|ANTHROPIC_|OPENAI_|JCODE_)/i.test(key)));
let passed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  assert.ok(condition, `${name}: ${detail}`);
  passed++;
  console.log(`PASS ${name}`);
}
function onPath(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "lookup", command], { encoding: "utf8" });
  assert.equal(result.status, 0, `${command} must be available: ${result.stderr}`);
  return result.stdout.trim();
}
function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => { socket.destroy(); done(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
console.log(`Retained broker-only evidence: ${scratch}`);
const scenarios = ["legacy-auth", "legacy-open", "controller-auth", "manifest-auth", "foreground-auth", "foreground-controller"] as const;
const requested = process.argv.slice(2);
assert.ok(requested.every((name) => scenarios.some((scenario) => scenario === name)), "unknown broker-only scenario");
for (const scenario of scenarios.filter((name) => requested.length === 0 || requested.includes(name))) {
  const base = join(scratch, scenario), root = join(base, "project"), home = join(base, "home"), xdg = join(base, "xdg"), bin = join(base, "bin");
  for (const path of [root, home, xdg, bin, join(base, "runtime")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const command of ["node", "git", "nats-server", "sh", "ps", "readlink", "uname", "id", "getconf", "ldd"]) symlinkSync(onPath(command), join(bin, command));
  const env = { ...cleanEnv, PATH: bin, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: join(base, "runtime"), COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
  const anchor = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: xdg });
  let calls = 0;
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 90_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const child = spawnSync(process.execPath, [cli, ...args], options);
    writeFileSync(join(base, `${++calls}-${args[0]}.json`), JSON.stringify({ args, status: child.status, signal: child.signal, error: child.error?.message, stdout: child.stdout, stderr: child.stderr }), { mode: 0o600 });
    return { status: child.status, text: child.stdout + child.stderr };
  };
  const absent = spawnSync("/bin/sh", ["-c", "command -v npm || command -v npx"], { env, encoding: "utf8" });
  check(`${scenario}: npm and npx are absent`, absent.status === 127, absent.stdout + absent.stderr);
  const controller = scenario.includes("controller"), foreground = scenario.startsWith("foreground"), open = scenario.endsWith("open");
  if (controller) {
    // Preparation is fixture setup, not the broker-only command under test.
    const prepared = spawnSync(process.execPath, [cli, "space", "create", "broker-only", "--root", root], { cwd: root, env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "1" }, encoding: "utf8", timeout: 30_000 });
    writeFileSync(join(base, "prepare.json"), JSON.stringify({ status: prepared.status, stdout: prepared.stdout, stderr: prepared.stderr }), { mode: 0o600 });
    check(`${scenario}: space preparation succeeds`, prepared.status === 0, prepared.stdout + prepared.stderr);
  }
  // The fresh legacy case matches the original report. Other cases also prove that an unrelated
  // newer connector store neither gates native startup nor gets downgraded by it.
  const stamp = join(xdg, "cotal/seed/stamp.json");
  const staged = `${JSON.stringify({ generation: "99.0.0", writtenBy: "newer-cotal", writtenAt: "2026-09-01T00:00:00.000Z" })}\n`;
  if (scenario !== "legacy-auth") {
    mkdirSync(join(stamp, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(stamp, staged, { mode: 0o600 });
  }
  const unchanged = () => {
    check(`${scenario}: connector seed store is unchanged`, scenario === "legacy-auth" ? !existsSync(join(xdg, "cotal/seed")) : readFileSync(stamp, "utf8") === staged);
    check(`${scenario}: no connector extension prefix was installed`, !existsSync(join(xdg, "cotal/extensions")));
  };
  const port = await freePort();
  assert.notEqual(port, 4222);
  const server = `nats://127.0.0.1:${port}`;
  const file = join(root, "cotal.yaml");
  const manifest = scenario === "manifest-auth";
  if (manifest) writeFileSync(file, `apiVersion: cotal/v1\nkind: Mesh\nspace: broker-only\nbroker:\n  auth: true\n  servers: ${server}\nchannels: {}\nagents: {}\n`);
  const args = ["up", "--no-manager", ...(manifest ? ["-f", file] : ["--space", "broker-only", "--server", server]), ...(open ? ["--open"] : [])];
  let child: ReturnType<typeof spawn> | undefined;
  let state: ReturnType<typeof observeOwnedChild> | undefined;
  let out = "", err = "";
  try {
    if (foreground) {
      child = spawn(process.execPath, [cli, ...args, "--foreground"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      state = observeOwnedChild(child);
      child.stdout!.on("data", (data: Buffer) => { out += data.toString(); });
      child.stderr!.on("data", (data: Buffer) => { err += data.toString(); });
      await waitForOwnedChild(() => state!.exited || /delivery daemon.*(?:running|ready)|no local daemon-credential renewal owner/.test(out + err), 90_000, `${scenario}: ready`);
      check(`${scenario}: foreground owner remains running`, !state.exited && !state.error, out + err);
    } else {
      const up = run(...args);
      check(`${scenario}: broker-only startup succeeds`, up.status === 0, up.text);
      check(`${scenario}: authenticated delivery starts when requested`, open || /delivery daemon|delivery\s+stack-delivery\s+\S+\s+started|no local daemon-credential renewal owner/.test(up.text), up.text);
      const refresh = run("up", "--no-manager", "--space", "broker-only", "--server", server, ...(open ? ["--open"] : []));
      check(`${scenario}: broker-only refresh succeeds`, refresh.status === 0, refresh.text);
    }
    check(`${scenario}: real broker listens`, await portOpen(port));
    unchanged();
  } finally {
    try {
      const down = run("down", "--yes");
      check(`${scenario}: owned stack shutdown succeeds`, down.status === 0, down.text);
    } finally {
      if (child && state) {
        await finishOwnedChild(child, state, () => {}, () => [], scenario);
        writeFileSync(join(base, "foreground.json"), JSON.stringify({ code: state.code, signal: state.signal, out, err }), { mode: 0o600 });
      }
    }
  }
  check(`${scenario}: broker stopped`, !(await portOpen(port)));
  if (scenario === "legacy-auth") {
    const managed = run("up", "--space", "broker-only", "--server", server);
    check("manager startup still requires connector installation", managed.status === 5 && /npm is not on PATH/.test(managed.text), managed.text);
    check("failed managed startup starts no broker", !(await portOpen(port)));
  }
}
emitSentinel({ passed, failed: 0 });
