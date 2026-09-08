/**
 * Production adopt path through the manager's pty runtime. Isolated. No fleet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, requireRuntimeAdopt } from "../src/index.js";
import { MANAGER_STATUS_CONTRACT } from "../src/manager-service-contract.js";
import { LegacyPtyRuntime } from "../src/runtime/pty.js";
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

{
  const sample = {
    instanceId: "i",
    runtime: "pty",
    custody: "custodied",
    agentCount: 0,
    uptimeMs: 0,
    connectors: [],
  };
  check("status output accepts custodied", MANAGER_STATUS_CONTRACT.output.validate(sample) === true);
  check("status output still accepts legacy", MANAGER_STATUS_CONTRACT.output.validate({ ...sample, custody: "legacy" }) === true);
  check("status output refuses unknown custody", MANAGER_STATUS_CONTRACT.output.validate({ ...sample, custody: "other" }) === false);
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
  const rt = createRuntime("pty", "cotal-smoke");
  const h = rt.spawn("counter", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } }, process.cwd());
  check("spawned handle exposes a durable reference", h.reference !== undefined && h.reference.kind === "pty", h.reference);
  const adopted = requireRuntimeAdopt(rt, h.reference!);
  check("production adopt returns a live proxy", typeof adopted.attach === "function" && adopted.pid === h.pid);
  h.stop({ graceful: false });
  await h.waitForExit?.();
  drop(adopted);
  drop(h);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nCUSTODIAL PTY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
