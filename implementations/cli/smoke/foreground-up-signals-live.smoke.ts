/** Actual CLI foreground signal regression. Uses a private home/root and an allocated loopback
 * port, starts no agents, and retains the sandbox and logs. No source or process identity guard
 * is replaced. POSIX process-group signals model terminal Ctrl-C, unlike CLI-only kill(). */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertRecordIdentity, canonicalLocalProcessPath, DELIVERY_PIDFILE, MANAGER_PIDFILE, spaceKey, verifyIdentityPin, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { emitSentinel, freePort } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") {
  console.log("SKIP foreground-up-signals: POSIX terminal process groups do not apply on Windows");
  process.exit(0);
}
const wt = resolve(import.meta.dirname, "../../..");
const cliEntry = join(wt, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const base = mkdtempSync(join(tmpdir(), "cotal-foreground-signals-"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
async function until(test: () => boolean | Promise<boolean>, ms: number, detail: () => string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await sleep(20); }
  throw new Error(`foreground signal wait expired: ${detail()}`);
}
function token(path: string): ProcessIdentityRecord | undefined {
  if (!existsSync(path)) return undefined;
  const pin = verifyIdentityPin(path);
  return pin.kind === "match" ? pin.record : undefined;
}
function live(row: ProcessIdentityRecord): boolean {
  const verdict = assertRecordIdentity(row);
  if (verdict.kind === "unpinned") throw new Error(`owned birth cannot be verified: ${row.pid}`);
  return verdict.kind === "match";
}

async function cell(name: string, options: { auth?: boolean; signal?: "SIGINT" | "SIGTERM"; twice?: boolean; crash?: boolean }): Promise<void> {
  const root = join(base, name), home = join(root, "home"), mesh = join(root, "mesh");
  for (const p of [root, home, mesh, join(mesh, ".cotal"), join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const args = ["--import", tsx, cliEntry, "up", "--foreground", "--server", `nats://127.0.0.1:${port}`, "--space", space, ...(options.auth ? [] : ["--open", "--no-manager"])];
  const child: ChildProcess = spawn(process.execPath, args, { cwd: mesh, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
  let exited = false, code: number | null = null, signal: NodeJS.Signals | null = null;
  const ended = new Promise<void>((r, reject) => {
    child.once("error", reject);
    child.once("exit", (c, s) => { exited = true; code = c; signal = s; });
    child.once("close", () => r());
  });
  const owned = new Map<string, ProcessIdentityRecord>();
  const brokerPath = join(mesh, ".cotal/nats.pid");
  const managerPath = canonicalLocalProcessPath(MANAGER_PIDFILE, { root: mesh, space });
  const deliveryPath = canonicalLocalProcessPath(DELIVERY_PIDFILE, { root: mesh, space });
  const ownRecords = () => {
    for (const file of [brokerPath, managerPath, deliveryPath]) {
      const row = token(file);
      if (row) owned.set(`${row.pid}:${row.token}`, row);
    }
  };
  try {
    await until(async () => {
      ownRecords();
      if (exited) throw new Error(`CLI exited before readiness: ${err}`);
      // Normal signal cells wait for postStart's durable registration, not merely a bound socket.
      // The auth cell deliberately interrupts earlier at the natural manager birth record.
      return options.auth ? token(managerPath) !== undefined : token(brokerPath) !== undefined && existsSync(join(home, "machine", "meshes", `space.${spaceKey(space)}.json`)) && await portOpen(port);
    }, 90_000, () => err.slice(-3000));
    ownRecords();
    const broker = token(brokerPath); assert.ok(broker && live(broker));
    if (options.crash) process.kill(broker.pid, "SIGKILL");
    else {
      assert.ok(child.pid);
      if (options.signal === "SIGTERM") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGINT");
      if (options.twice) {
        await sleep(5);
        assert.equal(exited, false, "second interrupt exercises an in-flight owner");
        process.kill(-child.pid, "SIGINT");
        passed++;
      }
    }
    await until(() => { ownRecords(); return exited; }, 60_000, () => err.slice(-3000));
    await ended;
    assert.equal(await portOpen(port), false, "the owned broker listener closed"); passed++;
    if (options.crash) {
      assert.notEqual(code, 0, "unexpected broker loss remains a nonzero CLI exit"); passed++;
      assert.match(err, /exited unexpectedly/); passed++;
    } else {
      assert.equal(code, 0, `guarded shutdown completed (${signal ?? "no signal"}): ${err}`); passed++;
      assert.match(err, /Trapped "terminated" signal/, "the CLI owner, not terminal SIGINT, stops the broker"); passed++;
      assert.doesNotMatch(err, /Trapped "interrupt" signal|could not list managed agents|control plane degraded|exited unexpectedly|spare.*unavailable/i); passed++;
      if (options.auth) {
        assert.equal(out.match(/stopped manager \(pid /g)?.length, 1, "one guarded manager stop despite two interrupts"); passed++;
        assert.equal(out.match(/stopped delivery daemon \(pid /g)?.length, 1, "one delivery stop"); passed++;
        assert.ok(out.indexOf("stopped manager") < out.indexOf("stopped delivery daemon"), "manager stop precedes delivery stop"); passed++;
      }
      assert.equal([...owned.values()].some(live), false, "no recorded owned process survives successful teardown"); passed++;
    }
    console.log(`PASS foreground-up-signals ${name}`);
  } finally {
    // The CLI remains the launch owner until it exits. Ask it to stop first, then signal only
    // recorded exact starts born in this private root. Never choose cleanup targets from argv.
    if (!exited) child.kill("SIGTERM");
    const end = Date.now() + 8_000;
    while (!exited && Date.now() < end) { ownRecords(); await sleep(30); }
    if (!exited) child.kill("SIGKILL");
    await ended;
    ownRecords();
    for (const row of owned.values()) if (live(row)) process.kill(row.pid, "SIGTERM");
    await until(() => [...owned.values()].every((row) => !live(row)), 10_000, () => `retained ${root}; owned process exit not confirmed`);
    writeFileSync(join(root, "stdout.log"), out, { mode: 0o600 });
    writeFileSync(join(root, "stderr.log"), err, { mode: 0o600 });
    writeFileSync(join(root, "exit.json"), JSON.stringify({ code, signal, port, owned: [...owned.values()], storesDeleted: false }), { mode: 0o600 });
  }
}
console.log(`foreground-up-signals retained evidence: ${base}`);
await cell("group", {});
await cell("term", { signal: "SIGTERM" });
await cell("double", { twice: true });
await cell("auth-early", { auth: true, twice: true });
await cell("crash", { crash: true });
console.log(`foreground-up-signals: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
