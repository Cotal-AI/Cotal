/**
 * The release workflow must gate the GitHub Release on a full-closure verification of every package
 * in the lockstep group, not on a single `npm view` of one package (#1286). And the closure verifier
 * must read the response body on a 200, not just the status (#1257).
 *
 * This smoke has two sections:
 *
 * A. Workflow shape — parses `.github/workflows/changesets.yml` and asserts that the Release step
 *    depends on a prior closure-gate step, anchored on step ids. A positive-control fixture with
 *    the gate removed must fail the same assertion, so the check is shown to discriminate.
 *
 * B. Fake-registry gate — starts a local HTTP server returning controlled responses and runs the
 *    closure verifier against it. Four states: all present passes; one missing reds; one 200 with
 *    a wrong-version body reds; one 200 with an error body reds.
 *
 * Run: pnpm smoke:publish-closure-gate
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/publish-closure-gate.json
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  verifyClosure,
  DEFAULTS,
} from "../../scripts/verify-publish-closure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let passed = 0, failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 FAIL: ${name}`, detail ?? ""); }
}

// ================================================================ A. Workflow shape
const workflowText = readFileSync(join(ROOT, ".github/workflows/changesets.yml"), "utf8");
const workflow = parseYaml(workflowText);

// Find the version job (the one with the publish and release steps)
const versionJob = workflow?.jobs?.version;
check("the changesets workflow has a 'version' job", !!versionJob);

// Find steps by id
const steps = versionJob?.steps ?? [];
const closureGateStep = steps.find((s: Record<string, unknown>) => s.id === "closure-gate");
const releaseStep = steps.find((s: Record<string, unknown>) => s.id === "release-step");

check(
  "the version job has a step with id 'closure-gate'",
  !!closureGateStep,
);
check(
  "the closure-gate step invokes verify-publish-closure.mjs",
  typeof closureGateStep?.run === "string" && closureGateStep.run.includes("node scripts/verify-publish-closure.mjs"),
  closureGateStep?.run,
);
check(
  "the version job has a step with id 'release-step'",
  !!releaseStep,
);

// The release step must condition on closure-gate's output
check(
  "the release step's 'if' references the closure-gate step output",
  typeof releaseStep?.if === "string" && releaseStep.if.includes("steps.closure-gate.outputs.closure_ok"),
  releaseStep?.if,
);

// The closure-gate step must branch on all four exit codes, not treat any non-zero as failure.
// Exit 2 (UNSETTLED) and 3 (NONE) are quiet skips, not failures. Only exit 1 (PARTIAL) fails the job.
const gateRun = closureGateStep?.run ?? "";
check(
  "the closure-gate step branches on exit code 1 (PARTIAL) to fail the job",
  gateRun.includes('"$rc" -eq 1') && gateRun.includes('exit 1'),
  gateRun,
);
check(
  "the closure-gate step handles exit code 2 (UNSETTLED) without failing",
  gateRun.includes('"$rc" -eq 2'),
  gateRun,
);
check(
  "the closure-gate step handles exit code 3 (NONE) without failing",
  gateRun.includes('"$rc" -eq 3'),
  gateRun,
);

// The closure-gate step must come BEFORE the release step
const closureGateIndex = steps.indexOf(closureGateStep);
const releaseIndex = steps.indexOf(releaseStep);
check(
  "the closure-gate step appears before the release step in the version job",
  closureGateIndex >= 0 && releaseIndex >= 0 && closureGateIndex < releaseIndex,
  { closureGateIndex, releaseIndex },
);

// The old single-package check must NOT be present
check(
  "the old single-package npm view check is removed from the workflow",
  !workflowText.includes('npm view "cotal-ai@$version"'),
);

// Positive control: a fixture workflow WITHOUT the closure-gate must fail the step-id check
const fixtureWorkflowText = workflowText
  .replace(/- name: Verify publish closure[\s\S]*?fi\n\n/m, "")
  .replace(/steps\.closure-gate\.outputs\.closure_ok\s*==\s*'true'\s*&&?\s*/g, "");
const fixtureWorkflow = parseYaml(fixtureWorkflowText);
const fixtureSteps = fixtureWorkflow?.jobs?.version?.steps ?? [];
const fixtureGate = fixtureSteps.find((s: Record<string, unknown>) => s.id === "closure-gate");
check(
  "positive control: a workflow with the closure gate removed has no closure-gate step",
  !fixtureGate,
);

// ================================================================ B. Fake-registry gate
// A local HTTP server returning controlled responses for each package
type ServerState = Map<string, { status: number; body: object | null }>;

function createFakeRegistry(state: ServerState): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = decodeURIComponent(req.url ?? "");
      // Extract package name from URL: /<name>/<version>
      const parts = url.slice(1).split("/");
      const version = parts.pop()!;
      const name = parts.join("/").replace("%40", "@").replace("%2f", "/");

      const entry = state.get(name);
      if (!entry || entry.status === 404) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(entry.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entry.body ?? {}));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ port: addr.port, close: () => server.close() });
      }
    });
  });
}

const pkgs = ["a", "b", "c", "d"];
const fastOpts = { ...DEFAULTS, pollIntervalMs: 10, stableWindowMs: 20, deadlineMs: 60_000 };
const fastClock = () => { let t = 0; return { now: () => (t += 1000), sleep: async () => {} }; };

// B1. All present: passes
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: all packages present with correct body -> PUBLISHED",
    result.state === "published",
    result,
  );
}

// B2. One missing (404): reds
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, p === "c"
      ? { status: 404, body: null }
      : { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: one package missing (404) -> PARTIAL (red)",
    result.state === "partial",
    result,
  );
  check(
    "fake registry: the missing package is named in the verdict",
    result.missing?.includes("c"),
    result.missing,
  );
}

// B3. One 200 with wrong-version body: reds (no evidence of this version)
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, p === "b"
      ? { status: 200, body: { name: "b", version: "1.0.0" } }
      : { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: one 200 with wrong version in body -> does NOT pass as published",
    result.state !== "published",
    result,
  );
}

// B4. One 200 with error body (no name/version): reds
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, p === "a"
      ? { status: 200, body: { error: "internal error", code: 500 } }
      : { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: one 200 with an error body (no name/version) -> does NOT pass as published",
    result.state !== "published",
    result,
  );
}

// B5. One 200 naming a different package: reds
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, p === "d"
      ? { status: 200, body: { name: "wrong-pkg", version: "9.9.9" } }
      : { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: one 200 naming a different package -> does NOT pass as published",
    result.state !== "published",
    result,
  );
}

const EXPECTED = 17;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED, passed + failed);
console.log(`PUBLISH CLOSURE GATE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;
