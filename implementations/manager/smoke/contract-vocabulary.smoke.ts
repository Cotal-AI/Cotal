/**
 * EVERY CONTRACT DOCUMENT THIS REPO DECLARES STILL COMPILES UNDER THE PROFILE.
 *
 * The profile refuses any keyword outside its admitted vocabulary (SPEC §13.7) rather than ignoring
 * it as JSON Schema would. That inversion is right — counting only recognised keywords is what let
 * `contentSchema` and `dependencies` through uncounted — but it is the one change in this area that
 * REFUSES MORE, so it can break a document that registered before. This asserts that none of ours
 * is such a document.
 *
 * WHY A SUITE AND NOT A ONE-OFF CHECK. The proof is only worth having if it runs again. Any future
 * schema edit, or any narrowing of the vocabulary, can turn one of these into a `contract-invalid`
 * at import — and the manager compiles its whole contract set AT IMPORT, so the failure mode is a
 * process that will not start. That is a red worth catching in the gate rather than at a customer's
 * boot.
 *
 * WHAT IT COVERS, and the scope was chosen by enumeration rather than by assumption. `compileContract`
 * call sites across every tree: `packages/` and `implementations/` only — `extensions/`, `examples/`,
 * `bin/`, `deploy/` and `scripts/` have ZERO. The `schema:` fields in `extensions/connector-core`
 * look like a counterexample and are not: they are Zod raw shapes handed to the MCP SDK
 * (`z.string().optional().describe(…)`), never JSON Schema, and never reach the profile. Checked by
 * reading the literals, because the type comment saying so is not evidence.
 *
 * WHAT IT DOES NOT COVER, said plainly: schemas registered by a CALLER at runtime. `endpoint-traits`
 * and `endpoint-invoke` compile documents read from the contract store, which are user-supplied by
 * construction. Those are exactly the population the vocabulary refusal can break, and no suite in
 * this repo can enumerate them — which is why the change ships with a changeset that says so.
 *
 * Run: pnpm smoke:contract-vocabulary
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileContract, VOID_SCHEMA } from "@cotal-ai/core";
import { managerClusterDocument, managerContractArtifactValues } from "../src/manager-service-contract.js";

let checked = 0;
let refused = 0;

/** Reports EVERY document by name, pass or fail. A count alone would let an empty input set read as
 *  success — the vacuous-instrument shape this campaign kept finding. The total is asserted below
 *  against a floor for the same reason. */
function check(label: string, root: unknown): void {
  checked++;
  try {
    compileContract({ root: root as Record<string, unknown> });
    console.log(`  ok    ${label}`);
  } catch (e) {
    refused++;
    console.log(`  FAIL  ${label}: ${(e as Error).message.slice(0, 140)}`);
  }
}

console.log("contract documents this repo declares, compiled under the live profile\n");

// Core's canonical payload-free artifact.
//
// `DESCRIBE_ANSWER_SCHEMA` is the other document core declares, and it is NOT checked here because
// it is module-private in `endpoint-serve.ts`. Stated rather than quietly omitted: it is covered
// only indirectly, by any suite that stands up a serving endpoint, since `serveEndpoint` compiles
// it on the describe rail. Exporting it to widen this file's reach would add public surface to the
// wire package for a test's convenience, which is the wrong trade.
check("core VOID_SCHEMA", VOID_SCHEMA);

// The manager's service contract: 23 schemas, compiled at IMPORT. Reaching this line already proves
// they compile — the import above would have thrown otherwise — so the loop's value is naming which
// document failed if one ever does, rather than leaving a stack trace at module load.
const artifacts = managerContractArtifactValues();
artifacts.forEach((a, i) => {
  // The closure manifests (`{v, root, members}`) are published beside each root but are not schemas.
  if (a && typeof a === "object" && "members" in (a as object) && "root" in (a as object)) return;
  check(`manager contract artifact #${i}`, a);
});

// A FLOOR, so a future refactor that stops producing artifacts cannot pass this file by checking
// nothing. 23 schemas plus core's void schema; the floor is deliberately below that rather than
// equal to it, because this asserts "the set is not empty or gutted", not "the set never grows".
const FLOOR = 20;
const enough = checked >= FLOOR;
console.log(`\n${checked} documents checked, ${refused} refused by the admitted vocabulary`);
if (!enough) console.log(`  FAIL  only ${checked} documents reached the check (floor ${FLOOR}) - the input set collapsed`);

// THE IMPORT-COST CELL (#1323): importing the contract module must not compile the schemas. The
// compile used to run at module scope, so EVERY CLI invocation paid ~1.8 CPU-seconds of Ajv work
// before its verb was read (`cotal --version` included). Two fresh children measure what the
// module adds on top of its own dependency floor (`@cotal-ai/core`: the NATS graph, Ajv itself,
// the digest code — plus, under tsx, the loader's per-module tax, which lands on both sides):
// one imports the floor, the other imports the contract module and reads one cluster-document
// digest (the describe-only path a `describe` reader takes — digests, never validators). The
// DELTA between the two children is the module's own cost; the compile alone accounts for
// ~500 ms of it, so a lazy module sits far below the bound and a module-scope compile trips it
// by an order of magnitude. CPU, not wall: wall counts the machine (SCHEMA_PROFILE's own record
// of the 101-158 ms trivial-compile refusal), and the bound carries margin for a loaded runner.
const TSX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", ".bin", "tsx");
const PROBE = join(dirname(fileURLToPath(import.meta.url)), "_probe-1323-contract-import.ts");
const probeCpu = (mode: "--control" | "--contract"): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(TSX, [PROBE, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.on("error", reject);
    child.on("exit", (rc) => {
      const m = /PROBE (?:control|contract) (\d+) \d+/.exec(out);
      if (rc !== 0 || !m) return reject(new Error(`probe ${mode} exited ${rc}: ${out.trim().slice(0, 200)}`));
      resolve(Number(m[1]));
    });
  });
let lazyOk = false;
let lazyDetail = "";
try {
  const [control, contract] = [await probeCpu("--control"), await probeCpu("--contract")];
  const overhead = contract - control;
  lazyOk = overhead <= 150;
  lazyDetail = `module adds ${overhead} ms CPU over its dependency floor (bound 150; compile at import measured ~500+)`;
} catch (e) {
  lazyDetail = `probe failed: ${(e as Error).message}`;
}
console.log(`  ${lazyOk ? "ok  " : "FAIL"}  importing the contract module compiles nothing (describe-only readers pay no Ajv): ${lazyDetail}`);

// THE DIGEST-IDENTITY CELL: the cluster document's source-derived digests must be the SAME VALUES
// compileContract returns as closureDigest — that equality is what lets the document pin digests
// without compiling while a compiled pair still registers under the document's pins. One command
// proves it end to end (the document's first row), against the SAME compiled validator the serve
// table would carry.
let digestOk = false;
{
  const doc = managerClusterDocument();
  const first = doc.commands[0]!;
  // A real compiled pair, through the same lazy export a caller hand-imports: its closure digests
  // must equal the document's source-derived pins for the SAME command.
  const { MANAGER_CONTRACTS } = await import("../src/manager-service-contract.js");
  const pair = MANAGER_CONTRACTS[first.name];
  digestOk = pair.input.closureDigest === first.inputDigest && pair.output.closureDigest === first.outputDigest;
  if (digestOk) {
    checked++;
    console.log(`  ok    cluster document digest == compiled closure digest (${first.name})`);
  } else {
    refused++;
    console.log(`  FAIL  cluster document digest != compiled closure digest (${first.name}): ${first.inputDigest} vs ${pair.input.closureDigest}`);
  }
}

const pass = refused === 0 && enough && lazyOk;
console.log(`\nCONTRACT VOCABULARY ${pass ? "OK ✅" : "FAILED ❌"}`);
process.exit(pass ? 0 : 1);
