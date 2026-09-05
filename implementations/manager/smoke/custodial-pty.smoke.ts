/**
 * Production adopt path through the manager's pty runtime. Isolated. No fleet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, requireRuntimeAdopt } from "../src/index.js";
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

if (process.platform !== "linux") {
  const rt = createRuntime("pty", "cotal-smoke");
  let threw = "";
  try {
    rt.spawn("nope", { command: process.execPath, args: ["-e", "0"] }, process.cwd());
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    `pty spawn throws custody transport unsupported on ${process.platform}`,
    threw === `custody transport unsupported on ${process.platform}`,
    threw,
  );
  console.log(`CUSTODIAL PTY COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
} else {
  const root = mkdtempSync(join(tmpdir(), "cotal-custodial-"));
  process.env.COTAL_SEAT_ROOT = root;
  const rt = createRuntime("pty", "cotal-smoke");
  const h = rt.spawn("counter", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } }, process.cwd());
  check("spawned handle exposes a durable reference", h.reference !== undefined && h.reference.kind === "pty", h.reference);
  const adopted = requireRuntimeAdopt(rt, h.reference!);
  check("production adopt returns a live proxy", typeof adopted.attach === "function" && adopted.pid === h.pid);
  adopted.stop({ graceful: false });
  await adopted.waitForExit?.();
  const drop = (h: unknown): void => {
    (h as { close?: () => void }).close?.();
  };
  drop(adopted);
  drop(h);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nCUSTODIAL PTY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
