import { once } from "node:events";
import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { reportRunningManagers } from "../src/commands/update.js";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const seen: Record<string, unknown>[] = [];
// The selected mesh must not decide which local Managers share the installation.
const report = reportRunningManagers as unknown as (
  flags: Record<string, unknown>,
  read: (flags: Record<string, unknown>) => Promise<"none" | "legacy">,
  census: () => { space: string; server: string; root: string; instanceId: string; pid: number }[],
) => Promise<"none" | "legacy">;
await report({}, async flags => { seen.push(flags); return "none"; }, () => [
  { space: "A", server: "nats://127.0.0.1:4222", root: "/a", instanceId: "0123456789abcdefghijklmnopqrstuv", pid: 1 },
  { space: "A", server: "nats://127.0.0.1:4222", root: "/b", instanceId: "localtwo", pid: 2 },
]);
assert.deepEqual(seen.map(flags => [flags.space, flags.on]), [["A", "0123456789abcdefghijklmnopqrstuv"], ["A", "localtwo"]]);
seen.length = 0;
await report({ space: "B" }, async flags => { seen.push(flags); return "none"; }, () => [
  { space: "A", server: "nats://127.0.0.1:4222", root: "/a", instanceId: "0123456789abcdefghijklmnopqrstuv", pid: 1 },
]);
assert.deepEqual([...seen], [{ space: "B" }], "an explicit space still narrows the report");
seen.length = 0;
await report({ creds: "/explicit.creds" }, async flags => { seen.push(flags); return "none"; }, () => { throw Error("raw credentials must not enumerate unrelated Managers"); });
assert.deepEqual(seen, [{ creds: "/explicit.creds" }]);
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { spaceKey } = await import("@cotal-ai/workspace");
const { readUpdateManagerIdentity } = await import("../src/lib/update-managers.js");
const root = mkdtempSync(join(tmpdir(), "cotal-update-identity-"));
try {
  mkdirSync(join(root, ".cotal", "auth"), { recursive: true });
  const file = join(root, ".cotal", "auth", `manager-instance.${spaceKey("A")}.json`);
  const bytes = JSON.stringify({ instanceId: "0123456789abcdefghijklmnopqrstuv", serveIdentity: { id: "unused", seed: "unused" } });
  writeFileSync(file, bytes);
  assert.equal(readUpdateManagerIdentity(root, "A"), "0123456789abcdefghijklmnopqrstuv");
  assert.equal(readFileSync(file, "utf8"), bytes, "legacy identity is retained without migration");
  assert.throws(() => readUpdateManagerIdentity(root, "missing"), /missing identity/);
  writeFileSync(file, "{}");
  assert.throws(() => readUpdateManagerIdentity(root, "A"), /invalid identity/);
} finally { rmSync(root, { recursive: true, force: true }); }
// A real argv-bearing process with a missing identity must not poison another explicit space.
if (process.platform === "linux") {
  const { spawn } = await import("node:child_process");
  const fixture = mkdtempSync(join(tmpdir(), "cotal-update-census-process-"));
  const entry = join(fixture, "cotal.ts");
  writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [entry, "supervise", "--space", "unrelated", "--server", "nats://127.0.0.1:4222"], { cwd: fixture, stdio: "ignore" });
  const priorEntry = process.argv[1];
  try {
    await once(child, "spawn");
    process.argv[1] = entry;
    const { localUpdateManagers } = await import("../src/lib/update-managers.js");
    const scoped = localUpdateManagers as unknown as (flags: { space: string }) => unknown[];
    assert.deepEqual(scoped({ space: "selected" }), [], "unrelated missing identity is excluded before validation");
  } finally {
    process.argv[1] = priorEntry!;
    child.kill();
    await once(child, "exit");
    rmSync(fixture, { recursive: true, force: true });
  }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
