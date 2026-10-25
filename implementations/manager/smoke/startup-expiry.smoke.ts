/** Real PTY children must never receive startup input after the confirmation gate expires. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHandle, Runtime } from "@cotal-ai/core";
import { ConnectorDiagnosticReader, StartupConfirmGate } from "@cotal-ai/seat";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { LegacyPtyRuntime } from "../src/runtime/pty.js";
import { CustodialPtyRuntime } from "../src/runtime/custodial-pty.js";

type Event = { kind: "ready" | "stop" | "input"; stopping?: boolean; bytes?: number[] };
const root = mkdtempSync(join(tmpdir(), "cotal-expiry-"));
const fixture = fileURLToPath(new URL("./fixtures/startup-expiry.cjs", import.meta.url));
const handles: AgentHandle[] = [];
const reapers: (() => Promise<unknown>)[] = [];
const failures: string[] = [];
let passed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${(error as Error).message}`); }
}
const rows = (path: string): Event[] => {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};
async function boundedExit(handle: AgentHandle): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handle.waitForExit!(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${handle.name}: exit exceeded 25s`)), 25_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

try {
  // Disarming is terminal even if output or an arm call arrives afterwards.
  const gate = new StartupConfirmGate("Enter to confirm");
  gate.disarm();
  check("disarmed gate rejects a later prompt", () => assert.equal(gate.push("Enter to confirm"), false));
  const rearmed = new StartupConfirmGate("Enter to confirm");
  rearmed.disarm();
  const diagnostic = new ConnectorDiagnosticReader();
  rearmed.arm(diagnostic, { report: () => {}, stop: () => {} });
  check("disarmed gate cannot be rearmed", () => assert.equal(rearmed.push("Enter to confirm"), false));
  rearmed.disarm();
  const normal = new StartupConfirmGate("Enter to confirm");
  check("pending gate confirms once before arm", () => {
    assert.equal(normal.push("Enter to confirm"), true);
    assert.equal(normal.push("Enter to confirm"), false);
  });

  if (process.platform === "win32") {
    console.log("SKIP PTY expiry: the SIGTERM fixture requires POSIX signals");
  } else {
    const runtimes: [string, Runtime][] = [["pty", new LegacyPtyRuntime()]];
    if (process.platform === "linux") runtimes.push(["custody", new CustodialPtyRuntime(join(root, "seats"))]);
    else console.log(`SKIP custody: Linux-only transport (host: ${process.platform})`);
    const cases = runtimes.flatMap(([runtimeName, runtime]) => ["early", "late", "none"].map((mode) => {
      const name = `${runtimeName}-${mode}`;
      const path = join(root, `${name}.jsonl`);
      const handle = runtime.spawn(name, {
        command: process.execPath, args: [fixture, path, mode],
        env: { PATH: process.env.PATH ?? "" }, confirm: "Enter to confirm",
      }, root);
      handles.push(handle);
      if (runtime instanceof CustodialPtyRuntime) reapers.push(() => runtime.reap(handle.reference!));
      return { name, path, handle, mode };
    }));
    await Promise.all(cases.filter((test) => test.mode !== "early").map((test) => boundedExit(test.handle)));
    for (const test of cases) {
      const observed = rows(test.path);
      check(`${test.name}: child reached raw input`, () => assert.equal(observed[0]?.kind, "ready"));
      const inputs = observed.filter((event) => event.kind === "input");
      if (test.mode === "early") {
        check(`${test.name}: normal confirmation stays running past deadline`, () => assert.equal(test.handle.status(), "running"));
        check(`${test.name}: normal confirmation sends Enter once`, () =>
          assert.deepEqual(inputs, [{ kind: "input", stopping: false, bytes: [13] }]));
      } else {
        check(`${test.name}: timeout stopped the child`, () => {
          assert.equal(test.handle.status(), "exited");
          assert.equal(observed.filter((event) => event.kind === "stop").length, 1);
          assert.match(test.handle.exitInfo!()?.diagnostic ?? "", /startup confirmation failed/);
        });
        check(`${test.name}: no input after startup failure`, () => assert.deepEqual(inputs, []));
      }
    }
  }
} finally {
  for (const handle of handles) handle.stop({ graceful: false });
  await Promise.all(handles.map(boundedExit));
  for (const handle of handles) (handle as AgentHandle & { close?: () => void }).close?.();
  await Promise.all(reapers.map((reap) => reap()));
  rmSync(root, { recursive: true, force: true });
}
console.log(`STARTUP EXPIRY (${passed} passed, ${failures.length} failed)`);
assert.equal(failures.length, 0, failures.join("\n"));
emitSentinel({ passed, failed: 0 });
