import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const route = process.argv[2];
assert(route === "bootstrap" || route === "self");
const candidates = resolve(process.env.UPDATE_CANDIDATE_ROOT!);
const output = resolve(process.env.UPDATE_MEASUREMENT_OUT!);
mkdirSync(output, { recursive: true, mode: 0o700 });
const a = JSON.parse(readFileSync(join(candidates, "A/manifest.json"), "utf8"));
const b = JSON.parse(readFileSync(join(candidates, "B/manifest.json"), "utf8"));
assert.equal(a.source, process.env.PRODUCT_SHA);
assert.equal(b.source, a.source);
const harness = resolve("scripts/automatic-update-platform-baseline.mjs");
const { matrixCell } = await import(pathToFileURL(harness).href);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const report = await matrixCell({
  source: "0.164.6", layout: route === "bootstrap" ? "installer" : "npm", state: "configured", method: route === "bootstrap" ? "installer" : "self", output,
  candidate: join(candidates, "B"), direction: "B", "expected-target": "0.164.8", "expected-public-target": "0.164.6",
  ...(route === "self" ? { "source-candidate": join(candidates, "A") } : {}),
  "container-manager": "false",
  prepare: async ({ root, cotalHome, report: cell }: { root: string; cotalHome: string; report: Record<string, unknown> }) => {
    mkdirSync(cotalHome, { recursive: true, mode: 0o700 });
    const foreign = join(root, "other-config/cotal/.update-snapshot-foreign");
    mkdirSync(foreign, { recursive: true, mode: 0o700 });
    const sentinel = join(foreign, "foreign-owner-sentinel");
    writeFileSync(sentinel, "belongs to another installation\n", { mode: 0o600 });
    const recovery = Buffer.from(JSON.stringify({ v: 1, previous: "0.13.1", target: "0.14.0", installed: "unknown", phase: "paused", owner: { pid: 2147483647, start: "dead-start", nonce: "old-update" }, snapshot: foreign, reason: "interrupted update", recordedAt: "2026-11-12T00:00:00.000Z" }, null, 2) + "\n");
    const attempt = Buffer.from('{"version":"0.14.0","failures":2,"result":"interrupted update","next":0}\n');
    writeFileSync(join(cotalHome, "update-recovery.json"), recovery, { mode: 0o600 });
    writeFileSync(join(cotalHome, "update-attempt.json"), attempt, { mode: 0o600 });
    writeFileSync(join(output, "recovery-before.json"), recovery);
    writeFileSync(join(output, "attempt-before.json"), attempt);
    cell.recoveryFixture = { snapshot: foreign, recoverySha256: sha(recovery), attemptSha256: sha(attempt), sentinelSha256: sha(readFileSync(sentinel)) };
    return async () => {
      const retained = readdirSync(cotalHome).filter(name => name.startsWith("update-recovery-retained-"));
      assert.equal(retained.length, 1);
      assert.deepEqual(readFileSync(join(cotalHome, retained[0]!, "update-recovery.json")), recovery);
      assert.deepEqual(readFileSync(join(cotalHome, retained[0]!, "update-attempt.json")), attempt);
      assert.deepEqual(readdirSync(foreign), ["foreign-owner-sentinel"]);
      assert.equal(readFileSync(sentinel, "utf8"), "belongs to another installation\n");
      cell.retainedRecovery = { folder: retained[0], exactBytes: true, foreignSnapshotUnchanged: true };
      writeFileSync(join(output, "retained-recovery.json"), JSON.stringify(cell.retainedRecovery, null, 2));
    };
  },
});
assert.equal(report.result, "passed", report.refusal);
assert.equal(report.update?.exit, 0);
assert.equal(report.retainedRecovery?.exactBytes, true);
console.log(JSON.stringify({ route, source: a.source, target: report.target, result: report.result }));
