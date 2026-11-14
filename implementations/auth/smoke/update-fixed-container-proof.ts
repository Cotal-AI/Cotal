import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareUpdateParticipant } from "./update-participant.fixture.js";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const route = process.argv[2];
assert(route === "bootstrap" || route === "self" || route === "control");
const root = resolve(process.env.UPDATE_CANDIDATE_ROOT!);
const output = resolve(process.env.UPDATE_MEASUREMENT_OUT!);
mkdirSync(output, { recursive: true, mode: 0o700 });
const a = JSON.parse(readFileSync(join(root, "A/manifest.json"), "utf8"));
const b = JSON.parse(readFileSync(join(root, "B/manifest.json"), "utf8"));
assert.equal(a.source, process.env.PRODUCT_SHA);
assert.equal(b.source, a.source);
const harness = resolve("scripts/automatic-update-platform-baseline.mjs");
writeFileSync(join(output, "harness-identity.json"), JSON.stringify({ upstream: process.env.SHARED_SHA, upstreamSha256: "dfcc2c53af9270e8f99b90cff7b5e5bc33e5a558a58300b3165bbaa9114b2e67", extendedSha256: createHash("sha256").update(readFileSync(harness)).digest("hex"), product: a.source, route }, null, 2));
writeFileSync(join(output, "candidate-A-manifest.json"), JSON.stringify(a, null, 2));
writeFileSync(join(output, "candidate-B-manifest.json"), JSON.stringify(b, null, 2));
const { matrixCell } = await import(pathToFileURL(harness).href);
const report = await matrixCell({
  source: "0.164.6", layout: "npm", state: "configured", method: "self", output,
  candidate: join(root, "B"), direction: "B", "expected-target": "0.164.8", "expected-public-target": "0.164.6",
  ...(route === "self" ? { "source-candidate": join(root, "A") } : { "bootstrap-reconcile": "true" }),
  "container-manager": route === "control" ? "false" : "true",
  prepare: async (context: Parameters<typeof prepareUpdateParticipant>[0] & { cotal: (label: string, args: string[]) => Promise<unknown> }) => {
    const close = await prepareUpdateParticipant(context);
    return async () => {
      try { context.report.versionAfter = await context.cotal("detailed version after fixed update", ["version"]); }
      finally { await close(); }
    };
  },
});
assert.equal(report.result, "passed", report.refusal);
assert.equal(report.update?.exit, 0);
assert.equal(report.participant?.selected, true);
if (route !== "control") assert.equal(report.foreignContainerCleanup, "owned container stopped, not deleted, before reporting");
else assert.equal(report.foreignContainer, undefined, "control started no foreign container");
assert.equal(report.candidate.source, a.source);
if (route === "self") {
  assert.equal(report.source, "0.164.7");
  assert.equal(report.sourceCandidate.source, a.source);
} else {
  assert.equal(report.source, "0.164.6");
  assert.equal(report.bootstrapInstall.exit, 0);
}
console.log(JSON.stringify({ route, fixedSource: a.source, target: report.target, result: report.result }));
