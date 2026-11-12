/** Interrupted detached controller starts keep their signal exit and report what remains running.
 *  Uses private homes and ports, and stops only its own stacks through `down --yes`.
 *  Run: pnpm smoke:up-interrupt:live */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { assertRecordIdentity, canonicalLocalProcessPath, MANAGER_PIDFILE, readPidfile } from "@cotal-ai/workspace";
import { serviceInstances } from "../src/lib/service-instances.js";
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
  ["early-timeout", "SIGINT", 130, "--json", false],
  ["early", "SIGINT", 130, "--json", false],
  ["interrupt", "SIGINT", 130, "--json", false],
  ["terminate", "SIGTERM", 143, "--json", true],
  ["hangup", "SIGHUP", 129, "--json", false],
  ["plain", "SIGINT", 130, "--plain", true],
] as const) {
  if (name.startsWith("early") && process.platform === "win32") {
    console.log("SKIP early: creation-bound pause requires POSIX signals");
    continue;
  }
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
  let earlyProcess: { pid: number; token: string } | undefined;
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
      if (name.startsWith("early")) {
        const savedHome = process.env.COTAL_HOME;
        process.env.COTAL_HOME = home;
        try {
          let manager: ReturnType<typeof serviceInstances>[number] | undefined;
          while (!manager) {
            try { manager = serviceInstances(space, "stack-manager").find((row) => row.record.value.process); }
            catch (error) {
              if (!(error instanceof Error) || error.message !== "the local record source changed while it was read") throw error;
            }
            if (manager) break;
            assert.equal(child.exitCode, null, `up ended before creation-pinned Manager: ${stderr}`);
            assert.ok(Date.now() < until, "Manager process was not creation-pinned");
            await sleep(1);
          }
          const record = manager.record.value;
          assert.equal(assertRecordIdentity(record.process!).kind, "match");
          earlyProcess = record.process!;
          process.kill(earlyProcess.pid, "SIGSTOP");
          const state = { process: record.process, readiness: record.readiness, pidfile: existsSync(canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space })) };
          writeFileSync(join(base, "early-at-signal.json"), JSON.stringify(state));
          assert.equal(state.readiness, "not-checked");
          console.log(`Observed early Manager: ${JSON.stringify(state)}`);
        } finally {
          if (savedHome === undefined) delete process.env.COTAL_HOME;
          else process.env.COTAL_HOME = savedHome;
        }
      } else if (!noManager) {
        const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space });
        while (!existsSync(pidPath) || !readPidfile(pidPath)) {
          assert.equal(child.exitCode, null, `up ended before its Manager launch: ${stderr}`);
          assert.ok(Date.now() < until, "Manager launch was not recorded before deadline");
          await sleep(10);
        }
        console.log(`Observed Manager launch before ${signal}`);
      }
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
    let stopped: { status: number | null; stdout: string; stderr: string };
    if (earlyProcess) {
      const pinned = earlyProcess;
      const resume = setTimeout(() => {
        if (assertRecordIdentity(pinned).kind === "match") process.kill(pinned.pid, "SIGCONT");
      }, name === "early-timeout" ? 20000 : 4000);
      try {
        stopped = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
          const down = spawn(process.execPath, ["--import", loader, entry, "down", "--yes", "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
          let out = "", err = "";
          down.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
          down.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
          const watchdog = setTimeout(() => down.kill("SIGKILL"), 180_000);
          down.once("error", () => { clearTimeout(watchdog); done({ status: null, stdout: out, stderr: err }); });
          down.once("close", (status) => { clearTimeout(watchdog); done({ status, stdout: out, stderr: err }); });
        });
      } finally {
        clearTimeout(resume);
        if (assertRecordIdentity(pinned).kind === "match") process.kill(pinned.pid, "SIGCONT");
      }
    } else stopped = cli("down", "--yes", "--json");
    if (name === "early-timeout") {
      writeFileSync(join(base, `${name}-refused.stdout`), stopped.stdout);
      check("early-timeout: bounded refusal submits no native stop", () => {
        assert.equal(stopped.status, 2);
        const refusal = JSON.parse(stopped.stdout);
        assert.equal(refusal.error.code, "LIFECYCLE_BLOCKED");
        assert.match(refusal.error.message, /has not completed startup/);
      });
      await sleep(2000);
      stopped = cli("down", "--yes", "--json");
    }
    writeFileSync(join(base, `${name}-down.stdout`), stopped.stdout);
    writeFileSync(join(base, `${name}-down.stderr`), stopped.stderr);
    assert.equal(stopped.status, 0, `private stack cleanup failed: ${stopped.stderr}\n${stopped.stdout}`);
    assert.equal(await listening(port), false, "private broker still listens after down");
  }
}
assert.deepEqual(failures, [], "interrupted up regressions");
