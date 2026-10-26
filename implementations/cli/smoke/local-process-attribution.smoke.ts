/** Real pid records, creation identities and owned child lifecycles through the built stops.
 *  Only command observation is supplied: this suite never inspects another process's argv. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import * as workspace from "@cotal-ai/workspace";

const root = mkdtempSync(join(tmpdir(), "cotal-stop-attribution-"));
const cwd = process.cwd();
const home = process.env.COTAL_HOME;
const children = new Set<ChildProcess>();
const observations = new Map<number, workspace.ProcessCommand>();
const failures: string[] = [];
let passed = 0;
const kill = process.kill.bind(process);
const logs: string[] = [];
const errors: string[] = [];
const signals: { pid: number; signal: NodeJS.Signals | number }[] = [];

async function child(command: string, stopPath?: string): Promise<ChildProcess> {
  const cooperative = process.platform === "win32" && stopPath !== undefined;
  const code = cooperative
    ? `import { listenForLocalStop } from ${JSON.stringify(new URL("../../../packages/workspace/dist/local-stop.js", import.meta.url).href)};
       listenForLocalStop(${JSON.stringify(stopPath)}, () => process.exit(0));
       process.send('ready'); setInterval(() => {}, 1000);`
    : "process.send('ready'); setInterval(() => {}, 1000)";
  const processChild = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  children.add(processChild);
  await once(processChild, "message", { signal: AbortSignal.timeout(10_000) });
  assert.ok(processChild.pid);
  observations.set(processChild.pid, { kind: "command", command });
  return processChild;
}

async function cell(name: string, run: () => Promise<void>): Promise<void> {
  logs.length = 0;
  errors.length = 0;
  signals.length = 0;
  try {
    await run();
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stderr.write(`FAIL ${name}: ${String(error)}\n`);
  }
}

try {
  mkdirSync(join(root, ".cotal"));
  process.env.COTAL_HOME = join(root, "home");
  process.chdir(root);
  mock.module("@cotal-ai/workspace", {
    namedExports: {
      ...workspace,
      readProcessCommand: (pid: number): workspace.ProcessCommand => {
        const command = observations.get(pid);
        assert.ok(command, "command observation must name a child owned by this suite");
        return command;
      },
    },
  });
  const { stopLocalProcess } = await import("../dist/lib/local-process-stop.js");
  const { MANAGER_PROCESS, stopManager } = await import("../dist/lib/manager-proc.js");
  const { DELIVERY_PROCESS, stopDelivery } = await import("../dist/lib/delivery-proc.js");
  const components = [DELIVERY_PROCESS, MANAGER_PROCESS];
  const space = "attribution";
  const context = { root, space };
  mock.method(console, "log", (...values: unknown[]) => logs.push(values.map(String).join(" ")));
  mock.method(console, "error", (...values: unknown[]) => errors.push(values.map(String).join(" ")));
  mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    assert.ok([...children].some(owned => owned.pid === pid), "signals and probes must target an owned child");
    if (signal !== undefined && signal !== 0) signals.push({ pid, signal });
    return kill(pid, signal);
  });

  function record(component: workspace.LocalProcess, pid: number, pin: "mismatch" | "match" | "legacy" | "torn"): string {
    const path = workspace.localProcessPath(component.pidFile, context);
    writeFileSync(path, String(pid));
    if (pin === "legacy") rmSync(workspace.identityPinPath(path), { force: true });
    else {
      const token = workspace.defaultStartToken(pid);
      assert.ok(token, "owned child must have a live creation identity");
      writeFileSync(workspace.identityPinPath(path), pin === "torn" ? "invalid" : `${pid} ${pin === "match" ? token : `${token}7`}`);
    }
    return path;
  }
  function cleared(path: string): void {
    assert.equal(existsSync(path), false, "stale pidfile must be cleared");
    assert.equal(existsSync(workspace.identityPinPath(path)), false, "stale pin must be cleared");
    assert.equal(existsSync(workspace.stopReservationPath(path)), false, "stop reservation must be released");
  }
  function preserved(path: string, pid: number): void {
    assert.equal(readFileSync(path, "utf8"), String(pid));
    assert.equal(existsSync(workspace.identityPinPath(path)), true);
    assert.equal(existsSync(workspace.stopReservationPath(path)), false);
    assert.equal(workspace.probeLiveness(pid), "alive");
  }

  const foreign = await child("node unrelated-child");
  const foreignPid = foreign.pid!;
  await cell("manager-default-foreign-legacy-clears-without-reaping-warning", async () => {
    const path = record(MANAGER_PROCESS, foreignPid, "legacy");
    assert.equal(await stopManager(space), true);
    cleared(path);
    assert.equal(workspace.probeLiveness(foreignPid), "alive");
    assert.deepEqual(signals, [], "foreign cleanup must send no signal");
    assert.deepEqual(logs, [], "foreign cleanup must not report a manager shutdown or agent reaping");
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.includes("not signalling it; removing the stale record instead"));
  });
  await cell("manager-default-legacy-successor-is-left-without-reaping-warning", async () => {
    const path = record(MANAGER_PROCESS, foreignPid, "legacy");
    assert.equal(await stopManager(space, { pid: foreignPid + 1 }), false);
    assert.equal(readFileSync(path, "utf8"), String(foreignPid));
    assert.deepEqual(signals, []);
    assert.deepEqual(logs, []);
    assert.deepEqual(errors, []);
    workspace.removePidPair(path, String(foreignPid));
  });
  if (process.platform !== "win32") {
    await cell("manager-default-owned-legacy-shutdown-keeps-reaping-warning", async () => {
      const owned = await child("node supervise");
      const path = record(MANAGER_PROCESS, owned.pid!, "legacy");
      assert.equal(await stopManager(space), true);
      cleared(path);
      assert.equal(workspace.probeLiveness(owned.pid!), "dead");
      assert.deepEqual(signals, [{ pid: owned.pid!, signal: "SIGTERM" }]);
      assert.ok(errors.some(line => line.includes("signalling it for upgrade compatibility")));
      assert.equal(logs.filter(line => line.includes("older destructive SIGTERM handler may have reaped managed agents")).length, 1);
    });
  }
  await cell("manager-default-dead-legacy-clears-without-reaping-warning", async () => {
    const dead = await child("node unrelated-child");
    const path = record(MANAGER_PROCESS, dead.pid!, "legacy");
    const exited = once(dead, "exit");
    dead.kill("SIGTERM");
    await exited;
    observations.set(dead.pid!, { kind: "gone" });
    signals.length = 0;
    assert.equal(await stopManager(space), true);
    cleared(path);
    assert.deepEqual(signals, []);
    assert.equal(logs.some(line => line.includes("may have reaped")), false);
    assert.deepEqual(errors, []);
  });
  for (const component of components) {
    const stop = () => component.name === "manager" ? stopManager(space, { withAgents: true }) : stopDelivery(space, { preserveCredentials: true });
    for (const pin of ["mismatch", "legacy", "match"] as const) {
      await cell(`${component.name}-${pin}-foreign-record-clears-without-signal`, async () => {
        const path = record(component, foreignPid, pin);
        await stop();
        cleared(path);
        assert.equal(workspace.probeLiveness(foreignPid), "alive", "foreign child must not be signalled");
        assert.deepEqual(errors, [`! recorded ${component.label} pid ${foreignPid} is alive but is running \`node unrelated-child\`, which is not a ${component.label} - not signalling it; removing the stale record instead.`]);
      });
    }
    await cell(`${component.name}-accepted-command-mismatch-preserves-record`, async () => {
      observations.set(foreignPid, { kind: "command", command: component.name === "manager" ? "node supervise" : "node deliver" });
      const path = record(component, foreignPid, "mismatch");
      await assert.rejects(stop, /the pid has been reused/);
      preserved(path, foreignPid);
      workspace.removePidPair(path, String(foreignPid));
      observations.set(foreignPid, { kind: "command", command: "node unrelated-child" });
    });
    await cell(`${component.name}-unreadable-command-mismatch-preserves-record`, async () => {
      observations.set(foreignPid, { kind: "unreadable", why: "fixture denies command observation" });
      const path = record(component, foreignPid, "mismatch");
      await assert.rejects(stop, /the pid has been reused/);
      preserved(path, foreignPid);
      workspace.removePidPair(path, String(foreignPid));
      observations.set(foreignPid, { kind: "command", command: "node unrelated-child" });
    });
    await cell(`${component.name}-accepted-command-torn-pin-preserves-record`, async () => {
      observations.set(foreignPid, { kind: "command", command: component.name === "manager" ? "node supervise" : "node deliver" });
      const path = record(component, foreignPid, "torn");
      await assert.rejects(stop, /pin|identity/);
      preserved(path, foreignPid);
      workspace.removePidPair(path, String(foreignPid));
      observations.set(foreignPid, { kind: "command", command: "node unrelated-child" });
    });
    await cell(`${component.name}-matching-owned-process-stops`, async () => {
      const owned = await child(
        component.name === "manager" ? "node supervise" : "node deliver",
        workspace.localProcessPath(component.pidFile, context),
      );
      const path = record(component, owned.pid!, "match");
      await stop();
      assert.equal(workspace.probeLiveness(owned.pid!), "dead");
      cleared(path);
    });
    await cell(`${component.name}-dead-record-clears`, async () => {
      const dead = await child("node unrelated-child");
      const path = record(component, dead.pid!, "mismatch");
      const exited = once(dead, "exit");
      dead.kill("SIGTERM");
      await exited;
      observations.set(dead.pid!, { kind: "gone" });
      await stopLocalProcess(component, context);
      cleared(path);
      assert.ok(logs.some(line => line.includes("was not running")));
    });
  }
  assert.equal(failures.length, 0, `failed cells: ${failures.join(", ")}`);
  process.stdout.write(`COTAL_SMOKE_SENTINEL cells=${passed} passed=${passed} failed=0\n`);
} finally {
  mock.restoreAll();
  for (const owned of children) {
    if (owned.exitCode === null && owned.signalCode === null) {
      const exited = once(owned, "exit");
      owned.kill("SIGTERM");
      await exited;
    }
  }
  process.chdir(cwd);
  if (home === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = home;
  process.stdout.write(`STOP_ATTRIBUTION_TERMINAL retained=${root} children=${children.size}\n`);
}
