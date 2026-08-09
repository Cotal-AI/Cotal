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

// 6b) The pathological-schema ceiling is NODE COUNT, checked before compiling — deterministic and
// identical on every host. It replaced a CPU-time budget that refused the manager's own service
// contract on Windows CI at "125ms of CPU ... 80ms elapsed" (CPU above wall clock is only possible
// with concurrent threads, so that number was mostly V8's JIT threads, not the schema). The timing
// still prints as an observation and refuses nothing.
{
  const heavy: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) heavy[`p${i}`] = { type: "string", pattern: `^a{0,4}b${i}c[0-9]{1,3}$`, minLength: 1, maxLength: 40 };
  // The exact shape the deterministic bounds used to miss: ~90KB, inside maxDocumentBytes and
  // maxClosureBytes, depth 2, ref-chain 0, every pattern legal — and 1001 nodes.
  refuses("the schema that genuinely burns the compiler is refused, now by NODE COUNT", () =>
    compileContractSchema({ root: { type: "object", properties: heavy, additionalProperties: false } }), "subschema nodes");
}
// The refusal must be the NODE bound and nothing else, so pin the boundary rather than only a
// wildly-over case: maxSchemaNodes properties compile, one more refuses. A ceiling asserted only
// far from its edge would still pass if the constant silently moved.
{
  const atLimit: Record<string, unknown> = {};
  for (let i = 0; i < SCHEMA_PROFILE.maxSchemaNodes - 1; i++) atLimit[`p${i}`] = { type: "string" };
  ok("a schema exactly AT the node ceiling compiles", (() => {
    compileContractSchema({ root: { type: "object", properties: atLimit, additionalProperties: false } });
    return true;
  })());
  const overLimit = { ...atLimit, extra: { type: "string" } };
  refuses("one node OVER the ceiling refuses", () =>
    compileContractSchema({ root: { type: "object", properties: overLimit, additionalProperties: false } }), "subschema nodes");
}
// The bound must not tax ordinary contracts: every schema this repo registers is far below it.
ok("a trivial closure compiles well inside the node ceiling", (() => {
  compileContractSchema({ root: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } });
  return true;
})());

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

// 11) The safe-subset pattern gate: length alone does not bound backtracking, and a
//     nested-quantifier denylist alone does not either.
refuses("nested-repetition pattern refused (the ^(a+)+$ exponential class)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(a+)+$" } }), "repeats a group");
refuses("bounded-brace repetition of a quantified group refused", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(a*){2,}$" } }), "repeats a group");
refuses("backreference pattern refused", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(a)\\1$" } }), "backreference");
refuses("ambiguous alternation under repetition refused (the ^(a|aa)+$ exponential class)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(a|aa)+$" } }), "ambiguous alternation");
refuses("overlapping variable repetitions in sequence refused (the a*a* polynomial class)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^a*a*a*b$" } }), "overlapping variable repetitions");
refuses("overlap through a nullable separator refused (a*b?a*)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^a*b?a*$" } }), "overlapping variable repetitions");
refuses("repeated nullable body refused ((a?)*)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(a?)*$" } }), "repeats a group");
refuses("lookaround refused (outside the safe subset)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(?=a)ab$" } }), "safe subset");
refuses("an unanchored pattern refused (Ajv tests unanchored → O(n²) at every start position)", () =>
  compileContractSchema({ root: { type: "string", pattern: "[0b]*$" } }), "start anchor");
refuses("an unanchored alternation branch refused (^a|b$ leaves the 2nd branch unpinned)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^[ba]+|[0b]*$" } }), "start anchor");
refuses("double-negated class overlap refused ([^\\D]* \\d* is digit* digit*)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^[^\\D]*\\d*X$" } }), "overlapping variable repetitions");
refuses("unknown alphanumeric escape refused (\\cA is control-A, not literal c+A)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^\\cA*\\cA*X$" } }), "safe subset");
refuses("astral overlap refused (an emoji is ONE code point under /u)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^😀*😀*X$" } }), "overlapping variable repetitions");
refuses("surrogate escapes refused", () =>
  compileContractSchema({ root: { type: "string", pattern: "^\\uD83D\\uDE00*$" } }), "surrogate");
refuses("repetition hidden in a leading alternation refused ((a*|b)a*)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(a*|b)a*X$" } }), "overlapping variable repetitions");
refuses("repetition hidden in a trailing alternation refused (a*(a*|b))", () =>
  compileContractSchema({ root: { type: "string", pattern: "^a*(a*|b)X$" } }), "overlapping variable repetitions");
refuses("repetitions hidden in both alternations refused ((a*|b)(a*|b))", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(a*|b)(a*|b)X$" } }), "overlapping variable repetitions");
ok("a disjoint repetition hidden in an alternation still compiles ((a*|c)b*)", (() => {
  const v = compileContractSchema({ root: { type: "string", pattern: "^(a*|c)b*X$" } });
  return v("aabbX") === true && v("cbX") === true && v("aaY") === false;
})());
refuses("overlapping FINITE-range repetitions refused (a{0,100000}a{0,100000} is not constant)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^a{0,100000}a{0,100000}X$" } }), "overlapping variable repetitions");
refuses("finite range hidden in an alternation refused ((a{0,9}|b)a{0,9})", () =>
  compileContractSchema({ root: { type: "string", pattern: "^(a{0,100000}|b)a{0,100000}X$" } }), "overlapping variable repetitions");
refuses("a chain of overlapping optionals refused (a?a?a?a? is bounded-backtracking)", () =>
  compileContractSchema({ root: { type: "string", pattern: "^a?a?a?a?X$" } }), "overlapping variable repetitions");
ok("a single optional still compiles (colou?r)", (() => {
  const v = compileContractSchema({ root: { type: "string", pattern: "^colou?r$" } });
  return v("color") === true && v("colour") === true && v("colouur") === false;
})());
ok("disjoint finite ranges still compile (\\d{1,9}[a-z]{1,9})", (() => {
  const v = compileContractSchema({ root: { type: "string", pattern: "^[0-9]{1,9}[a-z]{1,9}$" } });
  return v("12ab") === true && v("12") === false;
})());
ok("negated classes and braced code points still compile", (() => {
  const v = compileContractSchema({ root: { type: "string", pattern: "^[^a-z]+x\\u{1F600}*$" } });
  return v("A1x😀") === true && v("abc") === false;
})());
ok("the (…)? label idiom still compiles (a ? adds one alternative, not per-character ambiguity)", (() => {
  const v = compileContractSchema({ root: { type: "string", pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" } });
  return v("ok-1") === true && v("-no") === false;
})());
ok("disjoint alternation under repetition still compiles ((a|b)+)", (() => {
  const v = compileContractSchema({ root: { type: "string", pattern: "^(a|b)+$" } });
  return v("abab") === true && v("c") === false;
})());
ok("disjoint sequential repetitions and fixed counts still compile", (() => {
  const v = compileContractSchema({ root: { type: "string", pattern: "^[a-z]+[0-9]*-\\d{4}$" } });
  return v("ab12-2026") === true && v("ab-26") === false;
})());
ok("the digest-shape pattern still compiles", (() => {
  const v = compileContractSchema({ root: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } });
  return v(`sha256:${"a".repeat(64)}`) === true && v("sha256:xyz") === false;
})());

// 12) I-JSON violations in a schema surface as contract-invalid, never a raw canonicalizer error.
refuses("lone-surrogate schema is contract-invalid", () =>
  compileContractSchema({ root: { type: "string", description: "bad \ud800" } }), "I-JSON");

// 13) Unreachable members refuse deterministically — cold, warm, and forged alike (nothing
//     unverified or outside the closure identity ever reaches the compiler).
refuses("unreachable extra member refused", () =>
  compileContractSchema({ root: { type: "string" }, members: { [memberDigest]: member } }), "unreachable");
refuses("unreachable FORGED member refused", () =>
  compileContractSchema({ root: { type: "string" }, members: { [contractDigest({ type: "number" })]: { type: "boolean" } } }), "unreachable");
const warm = createCompiledContractCache(4);
warm.compile({ root: { type: "string" } });
refuses("extras refuse even when the closure is already cached (no history dependence)", () =>
  warm.compile({ root: { type: "string" }, members: { [memberDigest]: member } }), "unreachable");

// 14) A reachable-member $id collision is contract-invalid, not a raw ajv error.
const idA = { $id: "urn:test:same", type: "string" };
const idB = { $id: "urn:test:same", type: "number" };
const dA = contractDigest(idA);
const dB = contractDigest(idB);
refuses("member $id collision is contract-invalid", () =>
  compileContractSchema({
    root: { type: "object", properties: { a: { $ref: `cotal:${dA}` }, b: { $ref: `cotal:${dB}` } } },
    members: { [dA]: idA, [dB]: idB },
  }), "does not compile");

console.log(`schema-profile.smoke: ${pass} checks passed`);
