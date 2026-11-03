import { strict as assert } from "node:assert";
import { cpus, platform, totalmem } from "node:os";
import { EpEnvelopeError } from "@cotal-ai/core";
import {
  MANAGER_VITALS_MAX_MOUNTS,
  measureManagerVitals,
  type ManagerVitalsDeps,
} from "../src/vitals.js";

let passed = 0;
const cell = async (name: string, check: () => void | Promise<void>) => {
  try { await check(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.log(`FAIL ${name} - ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
};
const deps = (overrides: Partial<ManagerVitalsDeps> = {}): ManagerVitalsDeps => ({
  platform: () => "linux",
  logicalCount: () => 8,
  load: () => [0.25, 0.5, 0.75],
  totalMemory: () => 16_000,
  freeMemory: () => 4_000,
  linuxMeminfo: async () => "MemTotal: 16 kB\nMemAvailable: 12 kB\n",
  mounts: async () => ["/data", "/"],
  filesystem: async (mount) => mount === "/" ? { bsize: 10, blocks: 100, bfree: 40 } : { bsize: 10, blocks: 50, bfree: 20 },
  now: () => new Date("2026-10-21T22:00:00.000Z"),
  ...overrides,
});
const refusal = async (run: () => Promise<unknown>, code: string, text: RegExp) => {
  try { await run(); assert.fail("expected refusal"); }
  catch (error) {
    assert(error instanceof EpEnvelopeError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, "not-executed");
    assert.match(error.message, text);
  }
};

await cell("Linux returns a complete, sorted, invocation-time sample", async () => {
  if (platform() === "linux") {
    const live = await measureManagerVitals();
    assert.equal(live.cpu.logicalCount, cpus().length);
    assert.equal(live.memory.totalBytes, totalmem());
    assert(live.memory.availableBytes <= live.memory.totalBytes);
    assert(live.filesystems.length <= MANAGER_VITALS_MAX_MOUNTS);
    assert.deepEqual(live.filesystems.map((row) => row.mount), [...live.filesystems.map((row) => row.mount)].sort());
    assert(live.filesystems.every((row) => row.freeBytes <= row.totalBytes));
  }
  const value = await measureManagerVitals(deps());
  assert.equal(value.sampledAt, "2026-10-21T22:00:00.000Z");
  assert.deepEqual(value.cpu, { logicalCount: 8, load1: 0.25, load5: 0.5, load15: 0.75 });
  assert.deepEqual(value.memory, { totalBytes: 16_000, availableBytes: 12 * 1024 });
  assert.deepEqual(value.filesystems.map((row) => row.mount), ["/", "/data"]);
  assert(value.filesystems.every((row) => row.freeBytes <= row.totalBytes));
});
await cell("macOS uses defined free memory without enumerating protected user folders", async () => {
  let mounts: NodeJS.Platform | undefined;
  const value = await measureManagerVitals(deps({ platform: () => "darwin", mounts: async (os) => { mounts = os; return ["/"]; } }));
  assert.equal(mounts, "darwin");
  assert.equal(value.memory.availableBytes, 4_000);
  assert.deepEqual(value.filesystems.map((row) => row.mount), ["/"]);
});
await cell("Windows refuses unsupported zero load averages as one typed whole-command outcome", () =>
  refusal(() => measureManagerVitals(deps({ platform: () => "win32", load: () => [0, 0, 0] })), "unimplemented", /Windows/));
await cell("unsupported operating systems refuse rather than returning partial data", () =>
  refusal(() => measureManagerVitals(deps({ platform: () => "aix" })), "unimplemented", /unsupported/));
await cell("Linux requires MemAvailable and never substitutes free memory", () =>
  refusal(() => measureManagerVitals(deps({ linuxMeminfo: async () => "MemFree: 12 kB\n" })), "unimplemented", /MemAvailable/));
await cell("invalid or control-character mount strings refuse", () =>
  refusal(() => measureManagerVitals(deps({ mounts: async () => ["/bad\nmount"] })), "unimplemented", /invalid mount/));
await cell("remote mount endpoints refuse without being returned", () =>
  refusal(() => measureManagerVitals(deps({ mounts: async () => ["//secret/share"] })), "unimplemented", /remote filesystem/));
await cell("mount row count is bounded and never truncated", () =>
  refusal(() => measureManagerVitals(deps({ mounts: async () => Array.from({ length: MANAGER_VITALS_MAX_MOUNTS + 1 }, (_, i) => `/m${i}`) })), "resource-exhausted", /maximum/));
await cell("unsafe byte totals refuse instead of losing precision", () =>
  refusal(() => measureManagerVitals(deps({ filesystem: async () => ({ bsize: Number.MAX_SAFE_INTEGER, blocks: 2, bfree: 1 }) })), "resource-exhausted", /safe integer/));
await cell("inconsistent memory and filesystem values refuse", async () => {
  await refusal(() => measureManagerVitals(deps({ totalMemory: () => 1, linuxMeminfo: async () => "MemAvailable: 2 kB\n" })), "unimplemented", /exceeds total/);
  await refusal(() => measureManagerVitals(deps({ filesystem: async () => ({ bsize: 1, blocks: 1, bfree: 2 }) })), "unimplemented", /free bytes exceed/);
});

console.log(`manager vitals acceptance: ${passed} passed, ${10 - passed} failed, 10 total`);
if (passed !== 10) process.exitCode = 1;
