/** Descriptor attribution is shared by manager and delivery stops (#3701).
 * Uses built entrypoints, real owned children, identity pins and records. Only the command reader
 * is replaced with known fixture text, so this suite never reads a process's argv. It does not
 * validate the OS command reader, daemon startup or manager seat preservation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import * as workspace from "@cotal-ai/workspace";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-stop-attribution-")));
const cwd = process.cwd();
const space = "stop-attribution";
const context = { root, space };
let command: workspace.ProcessCommand = { kind: "command", command: "node fixture-idle.js" };
let reads = 0, passed = 0;
const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
const exited = once(child, "exit");
const ready = once(child, "message");
const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
const check = (name: string, value: boolean): void => {
  assert.ok(value, name);
  passed++;
  console.log(`  OK ${name}`);
};

try {
  await Promise.race([ready, exited.then(() => { throw new Error("fixture exited before ready"); })]);
  assert.ok(child.pid);
  const pid = child.pid;
  const token = workspace.defaultStartToken(pid);
  assert.ok(token, "the owned child has a readable creation identity");
  const stale = `${token}-stale`;
  mkdirSync(join(root, ".cotal"));
  process.chdir(root);
  mock.module("@cotal-ai/workspace", {
    cache: true,
    namedExports: {
      ...workspace,
      readProcessCommand: (target: number): workspace.ProcessCommand => {
        assert.equal(target, pid, "command reads target only the owned fixture");
        reads++;
        return command;
      },
    },
  });
  const { stopLocalProcess } = await import("../dist/lib/local-process-stop.js");
  const { MANAGER_PROCESS, stopManager } = await import("../dist/lib/manager-proc.js");
  const { DELIVERY_PROCESS, stopDelivery } = await import("../dist/lib/delivery-proc.js");
  const stops = [
    { component: MANAGER_PROCESS, stop: () => stopLocalProcess(MANAGER_PROCESS, context) },
    { component: DELIVERY_PROCESS, stop: () => stopLocalProcess(DELIVERY_PROCESS, context) },
    { component: MANAGER_PROCESS, stop: () => stopManager(space) },
    { component: MANAGER_PROCESS, stop: () => stopManager(space, { withAgents: true }) },
    { component: DELIVERY_PROCESS, stop: () => stopDelivery(space, { preserveCredentials: true }) },
  ];
  const pathOf = (component: workspace.LocalProcess) => workspace.localProcessPath(component.pidFile, context);
  const record = (component: workspace.LocalProcess, pin: string | undefined): string => {
    const path = pathOf(component);
    writeFileSync(path, `${pid}\n`);
    if (pin === undefined) rmSync(workspace.identityPinPath(path), { force: true });
    else writeFileSync(workspace.identityPinPath(path), `${pid} ${pin}\n`);
    return path;
  };
  const originalKill = process.kill;
  const signal = mock.method(process, "kill", (target: number, value?: NodeJS.Signals | number) => {
    assert.ok(value === 0 || value === undefined, "the stop must never signal a fixture in these cells");
    return originalKill(target, value);
  });
  // The primary regression and no-pin positive control go through both shared descriptors and
  // both shipped wrappers. A foreign record must never reach manager spare/intent hooks.
  for (const [index, entry] of stops.entries()) {
    for (const pin of [stale, undefined]) {
      const path = record(entry.component, pin);
      reads = 0;
      const messages: string[] = [];
      const output = mock.method(console, "error", (...args: unknown[]) => { messages.push(args.join(" ")); });
      try { await entry.stop(); } finally { output.mock.restore(); }
      check(`stop ${index} clears foreign ${pin === undefined ? "legacy" : "pinned"} record`,
        !existsSync(path) && !existsSync(workspace.identityPinPath(path)));
      check(`stop ${index} uses one attribution branch`, reads === 1 && messages.length === 1 && /! recorded .*not signalling it/.test(messages[0]));
      check(`stop ${index} leaves foreign child alive and releases reservation`,
        workspace.probeLiveness(pid) === "alive" && !existsSync(workspace.stopReservationPath(path)));
    }
  }
  for (const component of [MANAGER_PROCESS, DELIVERY_PROCESS]) {
    command = { kind: "command", command: component.name === "manager" ? "node cotal.js __daemon-manager" : "node cotal.js __daemon-deliver" };
    const path = record(component, stale);
    reads = 0;
    await assert.rejects(() => stopLocalProcess(component, context), /pid has been reused/);
    check(`${component.name} retains a mismatched pin when attribution matches`,
      existsSync(path) && readFileSync(workspace.identityPinPath(path), "utf8") === `${pid} ${stale}\n` && reads === 1);
    command = { kind: "unreadable", why: "fixture boundary" };
    await assert.rejects(() => stopLocalProcess(component, context), /pid has been reused/);
    check(`${component.name} does not treat unreadable command as foreign`, existsSync(path));
    command = { kind: "command", command: component.name === "manager" ? "node cotal.js supervise" : "node cotal.js deliver" };
    record(component, token);
    writeFileSync(workspace.identityPinPath(path), "torn\n");
    await assert.rejects(() => stopLocalProcess(component, context), /refusing/);
    check(`${component.name} preserves a torn pin`, readFileSync(workspace.identityPinPath(path), "utf8") === "torn\n");
    record(component, token);
    const denied = new Error("fixture authorization refusal");
    await assert.rejects(() => stopLocalProcess(component, context, { beforeSignal: () => { throw denied; } }), error => error === denied);
    check(`${component.name} preserves matching records on hook refusal`, existsSync(path) && !existsSync(workspace.stopReservationPath(path)));
    reads = 0;
    check(`${component.name} leaves a successor record before attribution`,
      await stopLocalProcess(component, context, { pid: pid + 1 }) === false && reads === 0 && existsSync(path));
    workspace.removePidPair(path, String(pid));
  }
  signal.mock.restore();
  child.kill("SIGTERM");
  await exited;
  // A proven-dead target clears even with an old pin. The replaced command reader reports gone,
  // as the OS reader would, without inspecting any foreign process.
  for (const component of [MANAGER_PROCESS, DELIVERY_PROCESS]) {
    const path = record(component, stale);
    reads = 0;
    command = { kind: "gone" };
    await stopLocalProcess(component, context);
    check(`${component.name} clears dead records`, !existsSync(path) && !existsSync(workspace.identityPinPath(path)) && reads === 1);
  }
  console.log(`COTAL_SMOKE_SENTINEL cells=${passed} passed=${passed} failed=0`);
} finally {
  mock.restoreAll();
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
  process.chdir(cwd);
  console.log(`Retained fixture: ${root}`);
}
