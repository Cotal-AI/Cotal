/** D27 execution-profile proofs for schema-profile.ts: full 2020-12 features validate, the
 *  closure is closed (no ambient resolution), and every bound refuses loudly at registration
 *  time with contract-invalid — distinct from invocation-time arg rejection (SPEC §13.7). */
import {
  compileContractSchema, compileContract, createCompiledContractCache, ContractInvalidError,
  SCHEMA_PROFILE, VOID_SCHEMA, VOID_SCHEMA_ARTIFACT_DIGEST, VOID_SCHEMA_DIGEST,
} from "../src/schema-profile.js";
import { contractDigest } from "../src/canonical.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const refuses = (name: string, fn: () => unknown, needle: string) => {
  try {
    fn();
  } catch (e) {
    ok(name, e instanceof ContractInvalidError && e.message.includes(needle), (e as Error).message);
    return;
  }
  throw new Error(`FAIL: ${name} — expected contract-invalid`);
};

// 1) Full 2020-12 features that zod's converter cannot represent MUST validate here:
//    if/then/else, not, dependentRequired, unevaluatedProperties, local $defs/$ref, oneOf.
const rich = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    kind: { $ref: "#/$defs/kind" },
    mode: { oneOf: [{ const: "fast" }, { const: "safe" }] },
    retries: { type: "integer" },
  },
  required: ["kind"],
  if: { properties: { kind: { const: "timed" } } },
  then: { required: ["retries"] },
  not: { required: ["forbidden"] },
  dependentRequired: { retries: ["mode"] },
  unevaluatedProperties: false,
  $defs: { kind: { enum: ["plain", "timed"] } },
};
const validate = compileContractSchema({ root: rich });
ok("full 2020-12 compiles (if/then, not, dependentRequired, unevaluated, $defs, oneOf)", true);
ok("valid args pass", validate({ kind: "plain" }) === true);
ok("if/then enforced", validate({ kind: "timed" }) === false);
ok("dependentRequired enforced", validate({ kind: "plain", retries: 2 }) === false);
ok("unevaluatedProperties enforced", validate({ kind: "plain", extra: 1 }) === false);
ok("conditional satisfied validates", validate({ kind: "timed", retries: 1, mode: "fast" }) === true);

// 2) Digest-pinned bundle members resolve locally; nothing is fetched.
const member = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "string", minLength: 2 };
const memberDigest = contractDigest(member);
const withMember = compileContractSchema({
  root: { type: "object", properties: { name: { $ref: `cotal:${memberDigest}` } }, required: ["name"] },
  members: { [memberDigest]: member },
});
ok("digest-pinned member resolves from the bundle", withMember({ name: "ok" }) === true && withMember({ name: "x" }) === false);

// 3) Closure violations refuse loudly at registration.
refuses("http $ref refused (no ambient resolution)", () =>
  compileContractSchema({ root: { $ref: "https://example.com/schema.json" } }), "external $ref");
refuses("file $ref refused", () =>
  compileContractSchema({ root: { $ref: "file:///etc/schema.json" } }), "external $ref");
refuses("missing digest member refused (closed bundle)", () =>
  compileContractSchema({ root: { $ref: `cotal:${contractDigest({ marker: "absent" })}` } }), "unresolved digest reference");
refuses("malformed member key refused", () =>
  compileContractSchema({ root: { type: "object" }, members: { "sha256:short": {} } }), "not a sha256 digest");

// 4) Bounds: depth and document size refuse before compilation.
let deep: Record<string, unknown> = { type: "string" };
for (let i = 0; i <= SCHEMA_PROFILE.maxDepth + 2; i++) deep = { type: "object", properties: { n: deep } };
refuses("depth bomb refused", () => compileContractSchema({ root: deep }), "depth");
refuses("oversized document refused", () =>
  compileContractSchema({ root: { type: "string", description: "x".repeat(SCHEMA_PROFILE.maxDocumentBytes + 1) } }), "bytes");

// 5) An uncompilable schema is contract-invalid, not a crash.
refuses("broken schema is contract-invalid", () =>
  compileContractSchema({ root: { type: "object", properties: { a: { $ref: "#/$defs/missing" } } } }), "does not compile");

// 6) Bounded pattern complexity (both regex surfaces).
refuses("pattern bomb refused", () =>
  compileContractSchema({ root: { type: "string", pattern: "(a|b)".repeat(SCHEMA_PROFILE.maxPatternChars) } }), "complexity bound");
refuses("patternProperties key bomb refused", () =>
  compileContractSchema({ root: { type: "object", patternProperties: { ["x".repeat(SCHEMA_PROFILE.maxPatternChars + 1)]: { type: "string" } } } }), "complexity bound");

// 7) A member that does not hash to its digest key refuses (also the cache-soundness gate).
refuses("forged member content refused", () =>
  compileContractSchema({
    root: { $ref: `cotal:${memberDigest}` },
    members: { [memberDigest]: { type: "number" } },
  }), "does not hash");

// 8) Closure identity is the §13.7 manifest digest (root digest + reachable members, sorted).
ok("self-contained closure digest is the manifest digest",
  compileContract({ root: member }).closureDigest === contractDigest({ v: 1, root: memberDigest, members: [] }));
const memberedRoot = { type: "object", properties: { name: { $ref: `cotal:${memberDigest}` } } };
ok("membered closure digest lists the reachable member",
  compileContract({ root: memberedRoot, members: { [memberDigest]: member } }).closureDigest
  === contractDigest({ v: 1, root: contractDigest(memberedRoot), members: [memberDigest] }));

// 9) The void schema's digests are the fixed values every payload-free side pins.
ok("void artifact digest is contractDigest({type:'null'})", VOID_SCHEMA_ARTIFACT_DIGEST === contractDigest({ type: "null" }));
ok("void closure digest is its manifest digest", VOID_SCHEMA_DIGEST === contractDigest({ v: 1, root: VOID_SCHEMA_ARTIFACT_DIGEST, members: [] }));
ok("the void schema validates null only", (() => {
  const v = compileContractSchema({ root: VOID_SCHEMA });
  return v(null) === true && v({}) === false && v("x") === false;
})());

// 10) The compiled LRU: hit reuses, capacity evicts, eviction recompiles.
const cache = createCompiledContractCache(2);
const a = cache.compile({ root: member });
ok("cache hit returns the same compiled validator", cache.compile({ root: member }).validate === a.validate && cache.size() === 1);
cache.compile({ root: { type: "integer" } });
cache.compile({ root: { type: "boolean" } });
ok("capacity bounds the cache", cache.size() === 2);
ok("an evicted closure recompiles to a fresh validator", cache.compile({ root: member }).validate !== a.validate);

console.log(`schema-profile.smoke: ${pass} checks passed`);
