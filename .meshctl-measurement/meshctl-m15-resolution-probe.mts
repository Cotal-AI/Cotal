/**
 * m15 — does the CODE UNDER TEST resolve to the artifact I am about to mutate?
 *
 * THE QUESTION MX14 DID NOT ASK. That run mutated core, compiled it into a private build, confirmed
 * the SUITE loaded that build, graded a cell, and reported SURVIVED. The mutant was never on the
 * path: the cell drives a `MeshAgent`, `connector-core` imports core by bare specifier, and that
 * resolves to the shared `packages/core/dist`. Compiled is not executed.
 *
 * WHAT THIS PROBE ASSERTS, AND WHY IT IS NOT A PRINTED PATH. A resolved path is a CLAIM about
 * resolution, and the harness's existing confirmation line is worse still — it is a message the
 * suite prints about its own import, so it checks the messenger. This asserts IDENTITY instead:
 *
 *   `connector-core` imports `CotalEndpoint` from the bare "@cotal-ai/core"  (agent.ts:11/:29)
 *   and exposes `readonly ep: CotalEndpoint`                                 (:138, assigned :192)
 *   this probe imports `CotalEndpoint` by the SAME bare specifier
 *   ESM keys the module registry by RESOLVED URL
 *   => if the subject's core and this probe's core are different artifacts, `instanceof` is FALSE
 *
 * It requires no cooperation from the code under test, cannot be satisfied by a message, and fails
 * closed. The resolved path is still printed — as a DIAGNOSTIC, not as the evidence.
 *
 * SAFETY: constructs a `MeshAgent` and never starts it. The constructor builds an endpoint and
 * registers listeners; it does not dial. No broker, no network, no writes.
 *
 * Run BOTH ways, which is the whole point:
 *   node_modules/.bin/tsx .meshctl-measurement/meshctl-m15-resolution-probe.mts
 *     -> expect SHARED: the arms can differ, so a later PRIVATE result means something
 *   COTAL_PRIVATE_CORE=<abs>/index.js NODE_OPTIONS="--import ./scripts/private-core-register.mjs" \
 *     node_modules/.bin/tsx .meshctl-measurement/meshctl-m15-resolution-probe.mts
 *     -> expect PRIVATE
 */
import { CotalEndpoint } from "@cotal-ai/core";
import { MeshAgent } from "../extensions/connector-core/src/agent.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

console.log("=== m15: does the SUBJECT resolve to the artifact under mutation? ===\n");

// --- the diagnostic: where the bare specifier lands in THIS process --------------------------
const resolvedHere = import.meta.resolve("@cotal-ai/core");
const wanted = process.env.COTAL_PRIVATE_CORE;
console.log(`  [diagnostic] "@cotal-ai/core" resolves to: ${resolvedHere}`);
console.log(`  [diagnostic] COTAL_PRIVATE_CORE          : ${wanted ?? "(unset — expecting the SHARED build)"}`);
console.log(`  [diagnostic] provenance                  : ${wanted ? "PRIVATE build" : "shared dist"}\n`);

// --- the evidence: identity of the class the SUBJECT actually constructed ---------------------
// Never started. A config just complete enough to construct.
const agent = new MeshAgent({
  name: "m15-probe",
  role: "worker",
  space: "m15",
  servers: "nats://127.0.0.1:1",   // never dialled: nothing calls start()
  subscribe: ["general"],
  allowPublish: ["general"],
} as never);

check("the subject constructed an endpoint at all (else the identity check is vacuous)",
  agent.ep !== undefined && agent.ep !== null);

check("SUBJECT-SIDE: agent.ep instanceof CotalEndpoint — the subject's core IS this probe's core",
  agent.ep instanceof CotalEndpoint,
  { hint: "false means the subject resolved to a DIFFERENT artifact than the bare specifier here" });

// --- CAN the identity check ever be FALSE? Otherwise it is a decoration, not an assertion. -----
// The hook moves the bare specifier for the WHOLE process, so the subject and this probe always
// travel together and `instanceof` above is true in both arms. That is agreement, not evidence of
// privateness. So reach the SHARED build by absolute path, which the hook does not touch, and
// require the two classes to be distinguishable exactly when they are different artifacts.
const sharedUrl = new URL("../packages/core/dist/index.js", import.meta.url).href;
const { CotalEndpoint: SharedEndpoint } = (await import(sharedUrl)) as { CotalEndpoint: unknown };
const sameAsShared = agent.ep instanceof (SharedEndpoint as new () => unknown);
check(wanted
  ? "DISCRIMINATION: with the hook active the subject is NOT an instance of the SHARED class (so the identity check can fail, and did not)"
  : "DISCRIMINATION CONTROL: with no hook the subject IS an instance of the SHARED class (same artifact, as it must be)",
  wanted ? sameAsShared === false : sameAsShared === true,
  { sameAsShared, sharedUrl });

// --- and the two must agree, or the probe is lying in one direction or the other --------------
if (wanted) {
  const wantedHref = new URL(`file://${wanted}`).href;
  check("the resolved path IS the private build the harness asked for",
    resolvedHere === wantedHref, { resolvedHere, wantedHref });
} else {
  check("CONTROL: with no hook, the subject resolves to the SHARED dist (so the arms CAN differ)",
    resolvedHere.includes("/packages/core/dist/"), resolvedHere);
}

console.log(`\n${fail === 0 ? "M15 OK ✅" : "M15 FAILED ❌"}  (${pass} passed, ${fail} failed)`);
console.log(fail === 0 && wanted
  ? "VERDICT: the subject resolves to the PRIVATE build — a mutation there IS on the graded path."
  : fail === 0
    ? "VERDICT: the subject resolves to the SHARED build — a mutation in a private build is NOT on the graded path (this is MX14's defect, reproduced deliberately)."
    : "VERDICT: UNGRADEABLE — do not open a window on this.");
process.exit(fail === 0 ? 0 : 1);
