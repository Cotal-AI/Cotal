import assert from "node:assert/strict";
import { once } from "node:events";
import { claimExtensionMutationLock } from "@cotal-ai/workspace";
import { BIN, HOST_ENV, check, cotal, existsSync, finishScenario, freshCfg, join, mkdirSync, readJson, spawn, track, writeFileSync } from "./harness.js";

function readMarker(path: string): { phase: string; pid?: number; intermediary?: boolean } | undefined {
  try { return readJson(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function signalIfRunning(pid: number, signal: NodeJS.Signals): boolean {
  try { return process.kill(pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

try {
  if (process.platform !== "win32") {
    const cfg = track(freshCfg());
    const marker = join(cfg, "cotal", ".extensions.lock.npm-child");
    for (const signal of ["SIGKILL", "SIGTERM"] as const) {
      const child = spawn(process.execPath, [BIN, "ext", "seed", "--force"], {
        env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; });
      child.stderr.on("data", bytes => { output += bytes; });
      const closed = once(child, "close");
      try {
        const deadline = Date.now() + 60_000;
        let npmPid: number | undefined;
        while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
          const record = readMarker(marker);
          if (record?.phase === "live") {
            assert.equal(record.intermediary, false);
            assert.ok(record.pid);
            // npm may finish between reading its marker and sending the signal.
            if (signalIfRunning(record.pid, signal)) {
              npmPid = record.pid;
              break;
            }
          }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.ok(npmPid, `the seed publishes its real npm child: ${output}`);
        assert.notEqual((await closed)[0], 0, "the interrupted seed still reports failure");
        assert.throws(() => process.kill(npmPid, 0), { code: "ESRCH" }, "npm was reaped before repair");
        assert.equal(existsSync(marker), false, "observed direct-child exit leaves no ambiguous marker");
        const repair = cotal(cfg, ["ext", "seed", "--repair"]);
        assert.equal(repair.status, 0, repair.stderr);
        assert.equal(existsSync(marker), false);
        check(`seed npm ${signal}: failed seed reported, child reaped, repair succeeded`, true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          // Only terminate the npm process journaled by this fixture's seed.
          const record = readMarker(marker);
          if (record?.phase === "live" && record.pid) {
            signalIfRunning(record.pid, "SIGKILL");
          }
          await closed;
        }
      }
    }

    for (const killWrapper of [false, true]) {
      const root = track(freshCfg());
      const isolated = join(root, "config");
      const held = join(root, "held.json"), release = join(root, "release"), done = join(root, "done");
      const pkg = join(root, "package");
      mkdirSync(pkg);
      writeFileSync(join(pkg, "package.json"), JSON.stringify({
        name: "cotal-descendant-probe", version: "1.0.0", type: "module", main: "index.js",
        peerDependencies: { "@cotal-ai/core": "*" }, scripts: { postinstall: "node hold.cjs" },
      }));
      writeFileSync(join(pkg, "index.js"), 'import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "descendant-probe", summary: "fixture", run: async () => {} });\n');
      writeFileSync(join(pkg, "hold.cjs"), `
const fs = require("node:fs"), path = require("node:path");
fs.writeFileSync(${JSON.stringify(held)}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
const deadline = Date.now() + 60000;
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) return;
  clearInterval(timer);
  fs.writeFileSync(path.join(process.cwd(), "descendant-write"), "finished");
  fs.writeFileSync(${JSON.stringify(done)}, "finished");
}, 20);
`);
      const child = spawn(process.execPath, [BIN, "ext", "add", pkg], {
        env: { ...HOST_ENV, XDG_CONFIG_HOME: isolated, COTAL_SKIP_CONNECTOR_SEED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; });
      child.stderr.on("data", bytes => { output += bytes; });
      const closed = once(child, "close");
      const journal = join(isolated, "cotal", ".extensions.lock.npm-child");
      let contender: ReturnType<typeof spawn> | undefined;
      let contenderClosed: Promise<unknown[]> | undefined;
      try {
        await waitFor(() => existsSync(held), "the real npm lifecycle descendant");
        const descendant = readJson(held) as { pid: number; cwd: string };
        const record = readJson(journal) as { pid: number; processGroup?: boolean };
        assert.equal(record.processGroup, true);
        process.kill(record.pid, "SIGKILL");
        if (killWrapper) {
          child.kill("SIGKILL");
          await closed;
        }
        await waitFor(() => {
          try { process.kill(record.pid, 0); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
        }, "the direct npm child to be reaped");
        process.kill(descendant.pid, 0);
        const before = readJson(journal);
        const previousConfig = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = isolated;
        try { assert.throws(() => claimExtensionMutationLock(), /still running|in progress/); }
        finally {
          if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
          else process.env.XDG_CONFIG_HOME = previousConfig;
        }
        contender = spawn(process.execPath, [BIN, "ext", "add", pkg], {
          env: { ...HOST_ENV, XDG_CONFIG_HOME: isolated, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: "ignore",
        });
        contenderClosed = once(contender, "close");
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.notEqual(contender.exitCode, 0, "concurrent add cannot complete while npm's group writes");
        assert.deepEqual(readJson(journal), before, "concurrent add preserves group identity");
        assert.ok(existsSync(descendant.cwd), "the running descendant keeps its staged cwd");
        if (!killWrapper) assert.equal(child.exitCode, null, "wrapper waits before discarding npm's stage");
        writeFileSync(release, "release");
        await waitFor(() => existsSync(done), "the lifecycle descendant's final write");
        if (!killWrapper) assert.notEqual((await closed)[0], 0, output);
        await contenderClosed;
        const repaired = cotal(isolated, ["ext", "seed", "--repair"]);
        assert.equal(repaired.status, 0, repaired.stderr);
        assert.equal(existsSync(journal), false);
        const retry = cotal(isolated, ["ext", "add", pkg], { COTAL_SKIP_CONNECTOR_SEED: "1" });
        assert.equal(retry.status, 0, retry.stderr);
        check(`npm descendants: ${killWrapper ? "dead" : "live"} wrapper retains custody until lifecycle completion`, true);
      } finally {
        writeFileSync(release, "release");
        await closed;
        await contenderClosed;
        if (existsSync(held)) await waitFor(() => existsSync(done), "owned lifecycle cleanup");
      }
    }
  }
} finally {
  finishScenario();
}
