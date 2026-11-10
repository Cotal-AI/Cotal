/** Interrupted detached controller starts keep their signal exit and report what remains running.
 *  Uses private homes and ports, and stops only its own stacks through `down --yes`.
 *  Run: pnpm smoke:up-interrupt:live */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const repo = resolve(import.meta.dirname, "../../..");
const entry = join(repo, "bin/cotal.ts");
const loader = import.meta.resolve("tsx");
const base = mkdtempSync(join(tmpdir(), "cotal-up-interrupt-"));
console.log(`Evidence: ${base}`);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const listening = (port: number) => new Promise<boolean>((done) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => { socket.destroy(); done(false); });
  socket.setTimeout(200, () => { socket.destroy(); done(false); });
});
const failures: string[] = [];
const check = (name: string, action: () => void) => {
  try { action(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${String(error)}`); }
};

for (const [name, signal, code, format, noManager] of [
  ["control", undefined, 0, "--json", false],
  ["interrupt", "SIGINT", 130, "--json", false],
  ["terminate", "SIGTERM", 143, "--json", true],
  ["hangup", "SIGHUP", 129, "--json", false],
  ["plain", "SIGINT", 130, "--plain", true],
] as const) {
  const home = join(base, `${name}-home`), root = join(base, `${name}-root`), config = join(home, "xdg");
  for (const dir of [home, root, config]) mkdirSync(dir, { mode: 0o700 });
  const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
  const cli = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 180_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(process.execPath, ["--import", loader, entry, ...args], options);
  };
  const space = `up-interrupt-${name}-${process.pid}`;
  const prepared = cli("space", "create", space, "--root", root, "--json");
  assert.equal(prepared.status, 0, prepared.stderr);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", loader, entry, "up", format, "--server", `nats://127.0.0.1:${port}`, ...(noManager ? ["--no-manager"] : [])], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((done) => child.once("close", (code, signal) => done({ code, signal })));
  const deadline = setTimeout(() => child.kill("SIGKILL"), 180_000);
  try {
    if (signal) {
      const until = Date.now() + 90_000;
      while (!await listening(port)) {
        assert.equal(child.exitCode, null, `up ended before listening: ${stderr}`);
        assert.ok(Date.now() < until, "broker did not listen before deadline");
        await sleep(100);
      }
      // The live report's window: broker accepted, before the manager is ready.
      await sleep(1_500);
      assert.equal(child.exitCode, null, "up finished before the interruption window");
      assert.equal(child.kill(signal), true);
    }
    const ended = await closed;
    writeFileSync(join(base, `${name}.stdout`), stdout);
    writeFileSync(join(base, `${name}.stderr`), stderr);
    writeFileSync(join(base, `${name}.exit.json`), JSON.stringify(ended));
    check(`${name}: signal exit`, () => assert.deepEqual(ended, { code, signal: null }));
    if (!signal) {
      check("positive control: one finished up receipt", () => {
        const envelope = JSON.parse(stdout);
        assert.equal(envelope.outcome, "ok");
        assert.equal(envelope.result.kind, "controller-stack-up");
        assert.deepEqual(envelope.result.members.filter((m: { state: string }) => m.state === "started").map((m: { role: string }) => m.role), ["broker", "delivery", "manager"]);
      });
    } else if (format === "--json") {
      check(`${name}: one interrupted up envelope with remaining members and Next`, () => {
        const envelope = JSON.parse(stdout);
        assert.equal(envelope.schemaVersion, 1);
        assert.equal(envelope.command, "up");
        assert.equal(envelope.target.root, root);
        assert.equal(envelope.target.space, space);
        assert.equal(envelope.outcome, "unknown");
        assert.equal(envelope.error.code, "OPERATION_UNKNOWN");
        assert.ok(envelope.changed.some((member: { role: string; state: string }) => member.role === "broker" && member.state === "running"));
        assert.ok(envelope.error.remedy.includes(noManager ? "`cotal up --no-manager`" : "`cotal up`"));
        assert.ok(envelope.error.remedy.includes("`cotal down --yes`"));
        assert.match(stderr, /Interrupted/);
      });
    } else {
      check("plain interrupt keeps stdout empty and recovery notice on stderr", () => {
        assert.equal(stdout, "");
        assert.match(stderr, /Interrupted/);
        assert.match(stderr, /cotal up --no-manager/);
        assert.match(stderr, /cotal down --yes/);
      });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    clearTimeout(deadline);
    const stopped = cli("down", "--yes", "--json");
    writeFileSync(join(base, `${name}-down.stdout`), stopped.stdout);
    writeFileSync(join(base, `${name}-down.stderr`), stopped.stderr);
    assert.equal(stopped.status, 0, `private stack cleanup failed: ${stopped.stderr}`);
    assert.equal(await listening(port), false, "private broker still listens after down");
  }
}
assert.deepEqual(failures, [], "interrupted up regressions");
