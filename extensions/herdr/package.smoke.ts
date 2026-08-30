import { strict as assert } from "node:assert";
import { visibilityDetail, waitUntilVisible } from "./probe.js";

let checks = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, name);
  checks++;
  console.log(`  ✓ ${name}`);
};

let time = 0;
const seen = await waitUntilVisible(() => 1, {
  deadlineMs: 0,
  intervalMs: 1,
  now: () => time,
  sleep: async (ms) => { time += ms; },
});
check("visible payload is observed on the first sample", seen.kind === "seen" && seen.tries === 1);
check("seen detail names the observed count", visibilityDetail(seen).startsWith("1 seen"));

const absent = await waitUntilVisible(() => 0, {
  deadlineMs: 0,
  intervalMs: 1,
  now: () => time,
  sleep: async (ms) => { time += ms; },
});
check("absent payload is a deadline, never success", absent.kind === "deadline" && absent.lastCount === 0);

console.log(`HERDR PACKAGE TESTS: ${checks} tests executed`);
