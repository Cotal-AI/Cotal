/** ProcessRecord's public type and native reader agree on the evidence each state carries.
 * Run: pnpm smoke:process-record; package typecheck also checks the negative type cases.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessRecord, type ProcessRecord, type ProcessRecordState } from "@cotal-ai/workspace";
import * as workspace from "@cotal-ai/workspace";

// This is compiled, never called. Unused @ts-expect-error directives fail the typecheck if a
// forbidden field becomes readable again; the valid reads must compile without assertions.
function evidenceByState(record: ProcessRecord): number | string | undefined {
  switch (record.state) {
    case "absent":
      // @ts-expect-error absent records have no pid
      void record.pid;
      // @ts-expect-error absent records have no content
      void record.content;
      // @ts-expect-error absent records have no command
      void record.command;
      // @ts-expect-error absent records have no path
      void record.path;
      return undefined;
    case "unattributable":
      // @ts-expect-error malformed records have no pid
      void record.pid;
      // @ts-expect-error malformed records have no command
      void record.command;
      return record.content.toUpperCase();
    case "alive":
    case "foreign": {
      const pid: number = record.pid;
      const command: string | undefined = record.command;
      // @ts-expect-error live records do not carry malformed content
      void record.content;
      // @ts-expect-error a real pid is a number, not text (compiler control)
      const wrong: string = record.pid;
      void wrong;
      return command ?? pid;
    }
    case "dead":
    case "unknown":
      // @ts-expect-error dead or unproven records have no command evidence
      void record.command;
      // @ts-expect-error dead or unproven records have no malformed content
      void record.content;
      return record.pid.toFixed();
    default: {
      const exhausted: never = record;
      return exhausted;
    }
  }
}
void evidenceByState;
const shapes: Record<ProcessRecordState, ProcessRecord> = {
  absent: { state: "absent" },
  unattributable: { state: "unattributable", path: "record", content: "garbage" },
  alive: { state: "alive", path: "record", pid: 1 },
  foreign: { state: "foreign", path: "record", pid: 1, command: "fixture" },
  dead: { state: "dead", path: "record", pid: 1 },
  unknown: { state: "unknown", path: "record", pid: 1 },
};
void shapes;

let pass = 0;
const check = (label: string, actual: unknown, expected: unknown): void => {
  assert.deepEqual(actual, expected, label);
  pass++;
  console.log(`  ✓ ${label}`);
};
check("the supported pair-removal API remains exported", typeof workspace.removePidPair, "function");
check("the deprecated unlocked pin-removal API is absent", "removeIdentityPin" in workspace, false);
const root = mkdtempSync(join(tmpdir(), "cotal-process-record-"));
const path = join(root, "record.pid");
const unexpected = (): never => { throw new Error("unexpected process probe or argv read"); };
const unreadable = () => ({ kind: "unreadable" as const, why: "fixture does not read argv" });
// Only our inert child is probed. No process command line is read or printed.
const child = spawn(process.execPath, ["-e", "process.on('message',()=>process.exit(0));process.send('ready')"], {
  env: { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
const exited = once(child, "exit");
try {
  await once(child, "message", { signal: AbortSignal.timeout(10_000) });
  const pid = child.pid!;
  check("native child has a pid", Number.isSafeInteger(pid) && pid > 0, true);
  check("missing file has no evidence", readProcessRecord(path, unexpected, unexpected, unexpected), { state: "absent" });
  writeFileSync(path, " \n");
  check("empty file has no evidence", readProcessRecord(path, unexpected, unexpected, unexpected), { state: "absent" });
  for (const content of ["garbage", "2147483648"]) {
    writeFileSync(path, content);
    check("malformed record carries only its path and content", readProcessRecord(path, unexpected, unexpected, unexpected), { state: "unattributable", path, content });
  }
  const pair = join(root, "owned-pair.pid");
  workspace.writePidPair(pair, pid);
  check("the public writer pins our live child", workspace.verifyIdentityPin(pair).kind, "match");
  writeFileSync(path, String(pid));
  check("native alive verdict with unreadable argv has a pid", readProcessRecord(path, unexpected, undefined, unreadable), { state: "alive", path, pid });
  check("native alive verdict with gone argv retains its pid", readProcessRecord(path, unexpected, undefined, () => ({ kind: "gone" })), { state: "alive", path, pid });
  check("matching supplied command retains its evidence", readProcessRecord(path, (cmd) => cmd === "fixture", undefined, () => ({ kind: "command", command: "fixture" })), { state: "alive", path, pid, command: "fixture" });
  check("rejected supplied command is foreign", readProcessRecord(path, () => false, undefined, () => ({ kind: "command", command: "fixture" })), { state: "foreign", path, pid, command: "fixture" });
  // Unknown kernel outcomes are explicit dependency seams, not claimed native observations.
  check("unknown probe preserves pid without reading argv", readProcessRecord(path, unexpected, () => "unknown", unexpected), { state: "unknown", path, pid });
  child.send("exit");
  await exited;
  check("reaped native child is dead with its pid", readProcessRecord(path, unexpected, undefined, unexpected), { state: "dead", path, pid });
  check("reads did not alter the pidfile", readFileSync(path, "utf8"), String(pid));
  workspace.removePidPair(pair, String(pid + 1));
  check("a different adjudicated record preserves the pair", existsSync(pair) && existsSync(workspace.identityPinPath(pair)), true);
  workspace.removePidPair(pair, String(pid));
  check("the matching exited-child record removes both files", existsSync(pair) || existsSync(workspace.identityPinPath(pair)), false);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
  rmSync(root, { recursive: true, force: true });
}
assert.equal(pass, 17, "all expected native/shape checks ran");
console.log(`PROCESS RECORD OK (${pass} checks)`);
