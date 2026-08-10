/**
 * A PERSONA IS UNTRUSTED INPUT, AND THE ONLY THING KEEPING POLICY OUT OF ONE IS A CLOSED SCHEMA.
 *
 * `define-persona` is in `SPAWN_SERVICE_COMMANDS`, so **any spawn-capable mesh peer holds the row** and
 * can write a persona file into the workspace directory that `cotal spawn` and the manager's own spawn
 * path later resolve personas from. That is a confused-deputy shape by construction: the peer plants
 * the definition, an operator or the manager later mints a credential from it.
 *
 * What stops a planted persona from carrying POLICY — `endpointCapabilities`, a pinned instance route,
 * anything else that shapes a grant — is not a trust boundary and not the caller's honesty. It is that
 * the `define-persona` input schema is CLOSED over exactly three content fields, and that
 * `opDefinePersona` CONSTRUCTS its record rather than merging caller input (fresh: `{name, model,
 * persona, owner: caller}` with the manager setting `owner`; redefine: ownership-checked, then content
 * overwritten and "all policy preserved").
 *
 * WHY THIS IS A SUITE AND NOT A NOTE IN A REVIEW. The non-blocking status of the cell-4 residual rests
 * on that closure, and **nothing anywhere tells the next person editing this schema what it protects.**
 * A field added for an entirely good reason silently puts policy on an untrusted-input path, and no
 * review would connect the two. The measurement was made once; this is what makes it stay made.
 *
 * WHAT IT ASSERTS, against the artifact the manager actually PUBLISHES to the EPC store
 * (`managerContractArtifactValues`) rather than against a module-local constant — so it cannot pass by
 * reading a copy of the thing under test:
 *
 *   1. exactly ONE published document is the persona input (identification is unambiguous)
 *   2. it is `additionalProperties: false`            <- the closure itself
 *   3. its property set is exactly {name, persona, model}
 *
 * (1) is a control, not decoration: if the finder matched zero documents every later assertion would
 * be vacuously true, and if it matched several this file would be grading an arbitrary one of them.
 *
 * WHAT IT DOES NOT COVER, said plainly: it does not assert that `opDefinePersona` still constructs
 * rather than merges — that is the second half of the guarantee and it lives in the handler, not the
 * schema. A future handler that spread caller input would pass this file. The schema is the half that
 * is checkable from a published artifact; the handler half is covered only by review.
 *
 * Run: pnpm smoke:persona-input-closed
 */
import { managerContractArtifactValues } from "../src/manager-service-contract.js";

type Doc = Record<string, unknown>;
const isDoc = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const published = managerContractArtifactValues();

/** The persona input is identified by its REQUIRED set, not by object identity or array position:
 *  a positional index would silently grade a different document the moment a row is added above it. */
const personaInputs = published.filter((v): v is Doc => {
  if (!isDoc(v)) return false;
  const req = v.required;
  return Array.isArray(req) && req.includes("persona") && req.includes("name");
});

console.log(`\n${published.length} published contract artifacts scanned`);
check("exactly one published document is the define-persona input (identification is unambiguous)",
  personaInputs.length === 1, { matched: personaInputs.length });

if (personaInputs.length !== 1) {
  console.log("\n  => the identification is ambiguous or empty, so every assertion below would be");
  console.log("     vacuous. Refusing to report a colour on the closure itself.");
  console.log(`\nPERSONA INPUT CLOSED FAILED ❌`);
  process.exit(1);
}

const schema = personaInputs[0]!;
const props = isDoc(schema.properties) ? Object.keys(schema.properties).sort() : [];
const EXPECTED = ["model", "name", "persona"];

check("the define-persona input schema is `additionalProperties: false` (a planted persona cannot carry policy)",
  schema.additionalProperties === false, { additionalProperties: schema.additionalProperties });
check(`its property set is exactly {${EXPECTED.join(", ")}}`,
  props.length === EXPECTED.length && props.every((p, i) => p === EXPECTED[i]), { found: props });

if (failures > 0) {
  console.log("\n  WHAT A FAILURE HERE MEANS: `define-persona` accepts input this file did not expect.");
  console.log("  A persona is reachable by any spawn-capable mesh peer and is later minted from, so a");
  console.log("  new field on this schema is a new field on an UNTRUSTED-INPUT path. If the field is");
  console.log("  content (like `persona` or `model`), widen EXPECTED here and say so. If it is policy");
  console.log("  in any form — capabilities, endpoint capabilities, an instance pin, a role — do not");
  console.log("  widen this file: that is the vector it exists to catch.");
}

console.log(`\nPERSONA INPUT CLOSED ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
