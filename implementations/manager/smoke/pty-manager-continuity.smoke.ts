/** The public PTY runtime must keep a Linux seat alive when its manager process ends. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentHandle, RuntimeReference } from "@cotal-ai/core";
import { loadSeat, processStartToken, reapSeat } from "@cotal-ai/seat";
import { createRuntime } from "../src/runtime/index.js";

if (process.platform !== "linux") {
  console.log(`PTY MANAGER CONTINUITY: rolling custody unsupported on ${process.platform}`);
} else {
  const root = mkdtempSync(join(tmpdir(), "pty-roll-"));
  const seats = join(root, "s");
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const oldSeatRoot = process.env.COTAL_SEAT_ROOT;
  process.env.COTAL_SEAT_ROOT = seats;
  const entry = pathToFileURL(join(import.meta.dirname, "../dist/runtime/index.js")).href;
  const direct = pathToFileURL(join(import.meta.dirname, "../dist/runtime/pty.js")).href;
  const child = join(root, "counter.cjs");
  writeFileSync(child, `const fs = require("node:fs");
fs.writeFileSync(process.env.PIDFILE, String(process.pid));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", data => {
  fs.appendFileSync(process.env.INPUT, data);
  process.stdout.write("accepted:" + data.toString() + "\\r\\n");
});
let n = 0;
setInterval(() => process.stdout.write("count:" + (++n) + "\\r\\n"), 50);
`);
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const until = async (read: () => boolean | Promise<boolean>, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!(await read())) {
      if (Date.now() >= deadline) throw new Error(label);
      await wait(25);
    }
  };
  const live = (pid: number): boolean => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] !== "Z";
    } catch { return false; }
  };
  const read = (path: string): string => {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
  };
  let checks = 0;
  const check = (name: string, value: unknown): void => {
    assert.ok(value, name);
    checks++;
    console.log(`  ✓ ${name}`);
  };
  const processes: ChildProcess[] = [];
  const refs: RuntimeReference[] = [];
  const handles: AgentHandle[] = [];
  let controlPid = 0;
  let controlStart: string | undefined;
  try {
    // The detached child is a positive control for process lifetime, not PTY continuity.
    const controlFile = join(root, "control.pid");
    const control = spawn(process.execPath, ["-e", `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.PIDFILE, String(process.pid));setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: process.env });
c.unref();setInterval(()=>{},1000);`], {
      env: { PATH: process.env.PATH ?? "", PIDFILE: controlFile }, stdio: "ignore",
    });
    processes.push(control);
    await until(() => Number(read(controlFile)) > 0, "detached positive control did not start");
    controlPid = Number(read(controlFile));
    controlStart = processStartToken(controlPid);
    const controlExit = once(control, "exit");
    control.kill("SIGKILL");
    await controlExit;
    check("positive control: detached child survives parent SIGKILL", live(controlPid));

    for (const mode of ["direct", "factory", "auto"] as const) {
      const ready = join(root, `${mode}.json`);
      const pidfile = join(root, `${mode}.pid`);
      const input = join(root, `${mode}.input`);
      const ownerFile = join(root, `${mode}.mjs`);
      writeFileSync(ownerFile, `import { createRuntime } from ${JSON.stringify(entry)};
import { PtyRuntime } from ${JSON.stringify(direct)};
import { writeFileSync } from "node:fs";
const runtime = ${mode === "direct" ? "new PtyRuntime()" : `createRuntime(${JSON.stringify(mode === "auto" ? "auto" : "pty")}, "continuity")`};
const handle = runtime.spawn(${JSON.stringify(mode)}, { command: process.execPath, args: [${JSON.stringify(child)}], env: { PATH: process.env.PATH ?? "", PIDFILE: ${JSON.stringify(pidfile)}, INPUT: ${JSON.stringify(input)} } }, ${JSON.stringify(root)});
await handle.attach().backlog();
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: handle.pid, reference: handle.reference, supportsRelease: runtime.supportsRelease === true }));
setInterval(()=>{},1000);
`);
      const owner = spawn(process.execPath, [ownerFile], {
        env: { PATH: process.env.PATH ?? "", HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: home, XDG_RUNTIME_DIR: home, TMPDIR: tmpdir(), COTAL_SEAT_ROOT: seats, COTAL_RUN: "pty-manager-continuity" },
        cwd: root, stdio: ["ignore", "ignore", "pipe"],
      });
      processes.push(owner);
      let error = "";
      owner.stderr?.on("data", (chunk) => { error += String(chunk); });
      await until(() => read(ready) !== "" && read(pidfile) !== "", `owner ${mode} did not start: ${error}`);
      const ids = JSON.parse(read(ready)) as { pid: number; reference?: RuntimeReference; supportsRelease: boolean };
      if (ids.reference) refs.push(ids.reference);
      check(`${mode}: handle names the child's own live PID`, ids.pid === Number(read(pidfile)) && live(ids.pid));
      const exited = once(owner, "exit");
      owner.kill("SIGKILL");
      await exited;
      await wait(300);
      check(`${mode}: manager death leaves the same PTY child alive`, live(ids.pid));
      check(`${mode}: runtime exposes release support and a durable reference`, ids.supportsRelease && ids.reference?.kind === "pty");
      const record = loadSeat(seats, ids.reference!.id);
      check(`${mode}: custodian is distinct from manager and child`, record.custodianPid !== owner.pid && record.custodianPid !== ids.pid && live(record.custodianPid));
      const runtime = createRuntime("pty", "successor");
      const adopted = runtime.adopt!(ids.reference!);
      handles.push(adopted);
      check(`${mode}: successor adopts without a replacement PID`, adopted.pid === ids.pid && (await adopted.attach().backlog()).includes("count:"));
      const session = adopted.attach();
      let output = "";
      const off = session.onData((chunk) => { output += String(chunk); });
      await until(() => output.includes("count:"), "successor received no continuing output");
      const marker = `marker-${mode}`;
      check(`${mode}: successor write is acknowledged`, await adopted.write!(marker) === marker.length);
      await until(() => read(input) === marker && output.includes(`accepted:${marker}`), "successor input was not observed by the original child");
      check(`${mode}: original child accepts one marker`, read(input) === marker);
      session.resize(87, 23);
      await session.backlog();
      check(`${mode}: successor retains terminal geometry`, session.cols === 87 && session.rows === 23);
      off();
      adopted.release!();
      await wait(100);
      check(`${mode}: releasing the proxy keeps the same child alive`, live(ids.pid));
      const again = runtime.adopt!(ids.reference!);
      handles.push(again);
      await again.attach().backlog();
      again.stop({ graceful: false });
      await again.waitForExit!();
      await until(() => !live(ids.pid), "successor stop did not end the original child");
      check(`${mode}: successor proves the original child's exit`, again.status() === "exited");
      again.release!();
    }
  } finally {
    for (const handle of handles) handle.release?.();
    for (const childProcess of processes) {
      if (childProcess.exitCode === null && childProcess.signalCode === null) {
        const ended = once(childProcess, "exit");
        childProcess.kill("SIGKILL");
        await ended;
      }
    }
    for (const ref of refs) {
      const result = await reapSeat(seats, ref.id);
      assert.ok(result.outcome === "reaped" || result.outcome === "absent");
    }
    if (controlPid && controlStart !== undefined && processStartToken(controlPid) === controlStart && live(controlPid)) {
      process.kill(controlPid, "SIGKILL");
      await until(() => !live(controlPid), "positive-control child did not stop");
    }
    if (oldSeatRoot === undefined) delete process.env.COTAL_SEAT_ROOT;
    else process.env.COTAL_SEAT_ROOT = oldSeatRoot;
    console.log(`Retained continuity fixture: ${root}`);
  }
  console.log(`PTY MANAGER CONTINUITY OK (${checks} checks)`);
}
