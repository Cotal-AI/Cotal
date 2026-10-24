/**
 * Production adopt path through the manager's pty runtime. Isolated. No fleet.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, requireRuntimeAdopt } from "../src/index.js";
import { MANAGER_STATUS_CONTRACT } from "../src/manager-service-contract.js";
import { LegacyPtyRuntime } from "../src/runtime/pty.js";
import { CustodialPtyRuntime } from "../src/runtime/custodial-pty.js";
import type { Runtime } from "@cotal-ai/core";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await wait(25);
  return predicate();
};
const file = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

{
  const unsupported: Runtime = { kind: "fixture", spawn: () => { throw new Error("unused"); } };
  let threw = "";
  try {
    requireRuntimeAdopt(unsupported, { kind: "fixture", id: "opaque" });
  } catch (e) {
    threw = (e as Error).message;
  }
  check('absent adopt refuses by runtime name', threw === 'runtime "fixture" does not support adopt');
}

{
  const sample = {
    instanceId: "i",
    execution: "runtime",
    runHosting: true,
    terminalSessions: true,
    runtime: "pty",
    custody: "custodied",
    agentCount: 0,
    uptimeMs: 0,
    connectors: [],
    classSpawn: true,
    staticReconciliation: { state: "idle", failures: [] },
  };
  check("status output accepts custodied", MANAGER_STATUS_CONTRACT.output.validate(sample) === true);
  check("status output still accepts legacy", MANAGER_STATUS_CONTRACT.output.validate({ ...sample, custody: "legacy" }) === true);
  check("status output refuses unknown custody", MANAGER_STATUS_CONTRACT.output.validate({ ...sample, custody: "other" }) === false);
  // The refusal above must be caused by the custody value, not by an absent required field.
  // `staticReconciliation` became required, so a fixture predating it would be refused for the
  // missing member and would keep passing even if unknown-custody handling were deleted. The
  // accept cells above carry the field, so the only difference here is the custody value itself.
  check(
    "status output refuses a payload missing staticReconciliation",
    MANAGER_STATUS_CONTRACT.output.validate({
      instanceId: "i",
      execution: "runtime",
      runHosting: true,
      terminalSessions: true,
      runtime: "pty",
      custody: "custodied",
      agentCount: 0,
      uptimeMs: 0,
      connectors: [],
      classSpawn: true,
    }) === false,
  );
}

{
  const legacy = new LegacyPtyRuntime();
  let threw = "";
  try {
    legacy.adopt({ kind: "pty", id: "opaque" });
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    `in-process pty adopt throws custody transport unsupported on ${process.platform}`,
    threw === `custody transport unsupported on ${process.platform}`,
    threw,
  );
}

const drop = (target: unknown): void => {
  (target as { close?: () => void }).close?.();
};

if (process.platform !== "linux") {
  const rt = createRuntime("pty", "cotal-smoke");
  const h = rt.spawn("counter", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } }, process.cwd());
  check("pty spawn still returns an in-process handle", typeof h.attach === "function" && typeof h.stop === "function");
  let threw = "";
  try {
    requireRuntimeAdopt(rt, h.reference ?? { kind: "pty", id: "missing" });
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    `pty adopt throws custody transport unsupported on ${process.platform}`,
    threw === `custody transport unsupported on ${process.platform}`,
    threw,
  );
  h.stop({ graceful: false });
  await h.waitForExit?.();
  drop(h);
  console.log(`CUSTODIAL PTY COMPLETE on ${process.platform}: spawn in-process, adopt unsupported (no skip-as-pass)`);
} else {
  const root = mkdtempSync(join(tmpdir(), "cotal-custodial-"));
  process.env.COTAL_SEAT_ROOT = root;
  const rt = new CustodialPtyRuntime();
  const h = rt.spawn("counter", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } }, process.cwd());
  check("spawned handle exposes a durable reference", h.reference !== undefined && h.reference.kind === "pty", h.reference);
  const adopted = requireRuntimeAdopt(rt, h.reference!);
  check("production adopt returns a live proxy", typeof adopted.attach === "function" && adopted.pid === h.pid);
  check("custodial pty declares release-safe manager custody", rt.supportsRelease === true);
  h.release?.();
  adopted.release?.();
  let survivedRelease = false;
  try {
    process.kill(h.pid!, 0);
    survivedRelease = true;
  } catch { /* failed below */ }
  check("releasing every manager proxy leaves the detached custodian child alive", survivedRelease, { pid: h.pid });
  const cleanup = requireRuntimeAdopt(rt, h.reference!);
  cleanup.stop({ graceful: false });
  await cleanup.waitForExit?.();
  drop(cleanup);
  drop(adopted);
  drop(h);

  const fixture = join(root, "confirm-child.mjs");
  writeFileSync(fixture, `
import { appendFileSync } from "node:fs";
const sink = process.env.SINK;
const prompt = "\u001b[1mEnter\u001b[0m     to confirm";
const delay = Number(process.env.PROMPT_DELAY_MS ?? "0");
let gateVisible = false;
process.stdin.setRawMode?.(true);
process.stdin.resume();
setTimeout(() => {
  process.stdout.write(prompt.slice(0, 9));
  setTimeout(() => { gateVisible = true; process.stdout.write(prompt.slice(9)); }, 25);
}, delay);
process.stdin.on("data", (chunk) => {
  appendFileSync(sink, chunk);
  if (gateVisible && chunk.includes(13)) process.stdout.write("\\r\\nNORMAL INPUT\\r\\n");
});
setInterval(() => {}, 1_000);
`);

  const confirmationCell = async (name: string, delayMs: number): Promise<void> => {
    const sink = join(root, `${name}.input`);
    const handle = rt.spawn(name, {
      command: process.execPath,
      args: [fixture],
      env: { PATH: process.env.PATH ?? "", SINK: sink, PROMPT_DELAY_MS: String(delayMs) },
      confirm: "Enter to confirm",
    }, process.cwd());
    const session = handle.attach();
    let output = "";
    const off = session.onData((chunk) => { output += chunk.toString("utf8"); });
    check(`${name}: the declared prompt appears`, await until(() => output.includes("to confirm"), delayMs + 3_000), output);
    check(`${name}: the seat reaches normal input`, await until(() => output.includes("NORMAL INPUT"), 3_000), output);
    check(`${name}: exactly one Enter reaches the child`, file(sink) === "\r", file(sink));
    handle.stop({ graceful: false });
    await handle.waitForExit?.();
    off();
    drop(handle);
  };

  await confirmationCell("early prompt", 50);
  await confirmationCell("late prompt after the old five-second window", 5_500);

  const noPromptSink = join(root, "no-prompt.input");
  const noPrompt = rt.spawn("no prompt", {
    command: process.execPath,
    args: ["-e", "process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.on('data',c=>require('node:fs').appendFileSync(process.env.SINK,c));setInterval(()=>{},1000)"],
    env: { PATH: process.env.PATH ?? "", SINK: noPromptSink },
    confirm: "Enter to confirm",
  }, process.cwd());
  await wait(5_750);
  check("no prompt: no stray Enter reaches the child after the old confirmation window", file(noPromptSink) === "", file(noPromptSink));
  noPrompt.stop({ graceful: false });
  await noPrompt.waitForExit?.();
  drop(noPrompt);

  // The child prints the prompt only from its SIGTERM handler, after the gate has failed and stopped
  // it. Both runtimes that own a child's output run the cell, at once to share the 15 s window.
  const unmatchedCell = async (label: string, runtime: Runtime): Promise<void> => {
    const sink = join(root, `${label} unmatched.input`);
    const unmatched = runtime.spawn(`${label} unmatched prompt`, {
      command: process.execPath,
      args: ["-e", "process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.on('data',c=>require('node:fs').appendFileSync(process.env.SINK,c));process.on('SIGTERM',()=>process.stdout.write('Enter to confirm\\r\\n'));setInterval(()=>{},1000)"],
      env: { PATH: process.env.PATH ?? "", SINK: sink },
      confirm: "Enter to confirm",
    }, process.cwd());
    const session = unmatched.attach();
    let output = "";
    const off = session.onData((chunk) => { output += chunk.toString("utf8"); });
    await unmatched.waitForExit?.();
    const failure = 'startup confirmation failed: prompt "Enter to confirm" did not appear within 15000ms';
    const failedAt = output.indexOf(failure);
    check(`${label} unmatched prompt: the seat fails bounded with the connector-owned prompt named`, failedAt >= 0, output);
    check(`${label} unmatched prompt: the child prints the prompt after the failure`, failedAt >= 0 && output.lastIndexOf("Enter to confirm") > failedAt + failure.length, output);
    check(`${label} unmatched prompt: a prompt printed after the failure gets no Enter`, file(sink) === "", file(sink));
    off();
    drop(unmatched);
  };
  await Promise.all([unmatchedCell("custodial", rt), unmatchedCell("in-process", createRuntime("pty", "cotal-smoke"))]);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nCUSTODIAL PTY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
