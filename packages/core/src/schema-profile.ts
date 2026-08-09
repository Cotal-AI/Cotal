/**
 * The normative JSON Schema 2020-12 execution profile for contract schemas (SPEC §13.7, D27).
 *
 * A contract schema is a CLOSED resource bundle: fully self-contained (local `#/…` refs) or
 * referencing other contract-store artifacts by digest (`cotal:sha256:<hex>`) only. Ambient
 * HTTP/file/URI resolution never happens; every external reference must be supplied by the
 * caller as an already-fetched, digest-verified bundle member. Registration-time violations are
 * `contract-invalid` (distinct from invocation-time `bad-request`), and all bounds are enforced
 * BEFORE compilation so a hostile descriptor cannot turn registration into a DoS.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { assertSafePattern } from "./safe-pattern.js";

/** Registration-time bounds (SPEC §13.7/§13.8). Fixed by the profile, not caller-tunable, and
 *  RUNTIME-frozen (the afa715b class): a post-import `maxDepth = MAX_SAFE_INTEGER` would remove
 *  the pre-compilation recursion/DoS ceiling, so mutation throws instead. */
export const SCHEMA_PROFILE = Object.freeze({
  /** One schema document's canonical form, bytes. */
  maxDocumentBytes: 256 * 1024,
  /** The complete resolved closure (root + digest-referenced members), bytes. */
  maxClosureBytes: 1024 * 1024,
  /** Structural nesting depth of any document. */
  maxDepth: 32,
  /** Max SUBSCHEMA NODES in a document. THIS BOUND EXISTS TO PREVENT A COMPILER CRASH, NOT A SLOW
   *  COMPILE, and that distinction is its entire basis. An earlier value was justified by compile
   *  time and could not be defended: the corpus that justified it was drawn from what the bound
   *  already admitted, so nothing above the line was ever observed.
   *
   *  A patterned-properties schema at 2048 nodes STACK-OVERFLOWS Ajv's codegen at 186,165 bytes —
   *  INSIDE `maxDocumentBytes`. No byte bound in this profile stands in front of that, and a node
   *  bound is the only thing that does. It is also not a budget overrun a timer could classify
   *  after the fact: there is no after.
   *
   *  MEASURED with the guard bypassed, raw Ajv with these exact options, each point in a fresh
   *  process. CPU ms, cold / warm-median-of-3:
   *
   *      nodes | object-patterned | boolean-anyOf | multi-member closure
   *       512  | 135.3 / 83.3     | 35.0 / 13.9   | 107.2 / 61.5
   *      1024  | 360.3 / 278.6    | 42.6 / 19.7   | 204.9 / 155.7
   *      2048  | STACK OVERFLOW   | 73.4 / 39.9   | 498.8 / 417.6
   *
   *  DERIVATION. The highest point safe in EVERY family is 1024, and a single scalar bound is set
   *  by the worst family — object-patterned — which dies somewhere in (1024, 2048]. 512 is one full
   *  doubling below the last known-good measurement, because the crash point belongs to Ajv rather
   *  than to this repo and can move without notice. Against real use it is 25x the largest schema
   *  registered here (20 nodes; the whole 23-schema startup set is 115), so it refuses nothing
   *  legitimate and leaves an order of magnitude for growth.
   *
   *  WHAT DID NOT DECIDE IT: there is no time knee anywhere in that table. Every family compiles in
   *  under 140ms cold at 512. Choosing by compile time is what produced the previous value.
   *
   *  INVALIDATING CONDITION, because this constant has a short half-life: the stack overflow is an
   *  Ajv-version and Node-version fact, measured on Ajv 8.20.0 / Node 26.7.0 / one macOS host. If
   *  either moves, RE-DERIVE — find where the object family crashes and set this a doubling below.
   *  A constant whose basis has expired is worse than one that never had a basis, because it looks
   *  derived.
   *
   *  AND IT IS NOT A COST MODEL. At a FIXED 1024 nodes the table spans 278.6ms (object) to 19.7ms
   *  (boolean): a 14x spread at one node count. This works because it sits below a CRASH, not
   *  because it tracks cost, and it will refuse a large cheap `anyOf` before a smaller expensive
   *  object schema. That false-refusal shape is known and accepted.
   *
   *  Counts SUBSCHEMA nodes via {@link countSchemaNodes}, booleans included — `true`/`false` are
   *  valid subschemas, and skipping them made the whole count bypassable. */
  maxSchemaNodes: 512,
  /** Max subschema nodes across a whole REFERENCE CLOSURE (root plus every reachable member).
   *
   *  ITS BASIS IS NOT THE SAME AS `maxSchemaNodes`, and conflating them would be wrong. The
   *  per-document bound sits below an Ajv CODEGEN CRASH. This one bounds AGGREGATE COMPILE COST:
   *  splitting a schema across members means every document passes the per-document check while the
   *  compiler pays the sum. Reproduced rather than theorised — members each under the document
   *  ceiling aggregated past it with every document passing.
   *
   *  A closure cannot crash the way one document can, because each member is independently held
   *  under `maxSchemaNodes` and the overflow is per-document codegen. So this is a cost ceiling, and
   *  the measured cost at it is ~500ms cold for a multi-member closure — a bounded, one-time
   *  registration cost rather than a failure mode.
   *
   *  4x the per-document ceiling, matching the ratio the profile already uses between
   *  `maxClosureBytes` (1 MiB) and `maxDocumentBytes` (256 KiB). That precedent existed for exactly
   *  this reason and should have been followed when the per-document bound was first added. Every
   *  contract this repo registers is 115 nodes for its ENTIRE 23-schema set, so this is far above
   *  real use. */
  maxClosureNodes: 2048,
  /** Digest-reference chain depth (root → member → member …). */
  maxRefChain: 32,
  /** Compile budget per closure, ms. */
  compileBudgetMs: 100,
  /** Bounded pattern complexity: max characters of any `pattern` / `patternProperties` regex. */
  maxPatternChars: 256,
  /** Per-value validation budget at the serving boundary, ms (§13.8 reference). REPORTED on the
   *  request path, not enforced — no available instrument can justify refusing a caller on it; see
   *  `reportValidateBudget` in endpoint-envelope.ts. */
  validateBudgetMs: 10,
  /** Compiled-schema cache entries (the SPEC's reference 256-entry LRU). */
  compiledCacheEntries: 256,
} as const);

/**
 * The EXACT Ajv configuration the profile compiles with. Exported so a calibration can measure the
 * real compiler rather than an approximation of it.
 *
 * WHY THIS IS EXPORTED, and it is the structural fix for how `maxSchemaNodes` came to be wrong: the
 * first version of that ceiling was derived from a corpus THE CEILING ITSELF BOUNDED. Every
 * synthetic above the line was refused, so it measured as "unmeasurable", and the calibration then
 * reported that nothing measured had exceeded the budget. Circular by construction — no evidence
 * above the line could exist, so the number was unfalsifiable the moment it shipped.
 *
 * A bound whose calibration must go through the bound cannot be re-derived. So the re-derivation
 * path compiles with THESE OPTIONS DIRECTLY, past every profile bound, and asks where the compiler
 * actually fails:
 *
 *     import { Ajv2020 } from "ajv/dist/2020.js";
 *     const ajv = new Ajv2020(AJV_PROFILE_OPTIONS);
 *     ajv.compile(schemaWayAboveTheCeiling);   // no profile bounds involved
 *
 * That is NOT a bypass of enforcement: nothing here weakens `compileContract`, and any caller could
 * already construct its own Ajv. What it removes is the need to reverse-engineer the compiler's
 * configuration in order to check whether the constants still hold — the two must be identical or
 * the measurement describes a different compiler than the one that ships.
 *
 * Re-derive whenever Ajv or Node moves: find where the object-patterned family stack-overflows and
 * set `maxSchemaNodes` a doubling below it.
 */
export const AJV_PROFILE_OPTIONS = Object.freeze({
  strict: false, // the wire accepts full 2020-12, not ajv's strict-mode dialect subset
  allErrors: false,
  validateFormats: false,
  loadSchema: undefined,
  // PINNED, never inherited from Ajv's default: the safe-pattern analyzer models `/u`
  // semantics exactly (astral atoms, surrogate refusals), so the engine MUST compile
  // `pattern` with the `u` flag. If this ever flipped, patterns would be proven under one
  // grammar and executed under another (an admitting under-approximation).
  unicodeRegExp: true,
} as const);

/** The canonical void schema (§13.7): the one artifact a side with no payload declares, so both
 *  `op` digests exist for every command. Validation against it means the payload is absent or
 *  `null`. */
export const VOID_SCHEMA = Object.freeze({ type: "null" } as const);
/** Artifact digest of the void schema document — one fixed value by construction. */
export const VOID_SCHEMA_ARTIFACT_DIGEST = contractDigest(VOID_SCHEMA);
/** The void schema's CLOSURE digest (the §13.7 manifest of a self-contained document) — the
 *  value `op.inputDigest`/`op.outputDigest` carry for a payload-free side. */
export const VOID_SCHEMA_DIGEST = contractDigest({ v: 1, root: VOID_SCHEMA_ARTIFACT_DIGEST, members: [] });

/** The digest-pinned contract-store reference scheme: `cotal:sha256:<hex>[#/json/pointer]`. */
const STORE_REF = /^cotal:(sha256:[0-9a-f]{64})(#.*)?$/;

/** Thrown for every profile violation at registration/ingest time; maps to the wire error
 *  code `contract-invalid` (never `bad-request`, which is for invocation-time args). */
export class ContractInvalidError extends Error {
  readonly code = "contract-invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "ContractInvalidError";
  }
}

/** Canonicalize within the profile boundary: an I-JSON violation (lone surrogate, undefined,
 *  non-finite number) in a schema document is a PROFILE violation and must surface as
 *  `contract-invalid`, never as a raw canonicalizer error (§13.7). */
function canonicalOrInvalid(v: unknown, label: string): string {
  try {
    return canonicalJson(v);
  } catch (e) {
    throw new ContractInvalidError(`${label}: ${(e as Error).message}`);
  }
}

function digestOrInvalid(v: unknown, label: string): string {
  try {
    return contractDigest(v);
  } catch (e) {
    throw new ContractInvalidError(`${label}: ${(e as Error).message}`);
  }
}

function structuralDepth(v: unknown, depth = 0): number {
  if (depth > SCHEMA_PROFILE.maxDepth) return depth; // short-circuit, caller throws
  if (v === null || typeof v !== "object") return depth;
  let max = depth;
  const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
  for (const c of children) {
    const d = structuralDepth(c, depth + 1);
    if (d > max) max = d;
    if (max > SCHEMA_PROFILE.maxDepth) return max;
  }
  return max;
}

/** The bounded-pattern-complexity gate (§13.7/§13.8 "bounded pattern complexity", "bounded
 *  regex"): the {@link assertSafePattern} SAFE SUBSET — a length bound plus an admission
 *  analysis that refuses nested repetition, repeated nullable or ambiguous-alternation bodies,
 *  overlapping variable repetitions in sequence, backreferences, lookarounds, and anything it
 *  cannot parse. Conservative by construction: uncertainty refuses. A refused pattern is
 *  rewritten by its author at registration time (`contract-invalid`), never probed at
 *  validation time — the post-hoc validate budget can only classify a stall, not prevent it. */
function assertBoundedPattern(p: string, label: string, where: string): void {
  try {
    assertSafePattern(p, SCHEMA_PROFILE.maxPatternChars);
  } catch (e) {
    throw new ContractInvalidError(`${label}: ${where} refused: ${(e as Error).message}`);
  }
}

/** Collect every `$ref` string in a schema document and gate its regex patterns (structural
 *  walk; `$ref` in 2020-12 is always a string-valued keyword wherever it appears; `pattern`
 *  values and `patternProperties` keys are the profile's bounded-pattern-complexity surface). */
function collectRefs(v: unknown, label: string, out: string[] = []): string[] {
  if (v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    for (const c of v) collectRefs(c, label, out);
    return out;
  }
  for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
    if ((k === "$ref" || k === "$dynamicRef") && typeof c === "string") out.push(c);
    if (k === "pattern" && typeof c === "string") assertBoundedPattern(c, label, "a pattern");
    if (k === "patternProperties" && c !== null && typeof c === "object" && !Array.isArray(c)) {
      for (const p of Object.keys(c as Record<string, unknown>)) assertBoundedPattern(p, label, "a patternProperties key");
    }
    collectRefs(c, label, out);
  }
  return out;
}

/** A closed schema bundle: the root document plus every digest-referenced member, already
 *  fetched and digest-verified (see `verifyArtifact`). Keyed by `sha256:<hex>`. */
export interface SchemaBundle {
  root: unknown;
  /** Digest → verified member document. Every `cotal:` ref in the closure must resolve here. */
  members?: Record<string, unknown>;
}

/** Applicator keywords whose VALUE is a subschema, a map of them, or an array of them. Compile
 *  cost is driven by how many subschemas the compiler generates code for, so the walk follows
 *  exactly these and nothing else. */
const SUBSCHEMA_KEYS = ["not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames", "unevaluatedItems", "unevaluatedProperties"];
const SUBSCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SUBSCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];

/** Count the subschema nodes in a schema document. Deterministic, cheap, computable BEFORE
 *  compiling, and identical on every host — which is the entire point, since the instrument it
 *  replaces (`process.cpuUsage()` around the compile) measures the machine as much as the schema.
 *  Independent of spelling: 1000 patterned properties is ~1000 nodes however tersely written.
 *
 *  Exported so the calibration probe measures the SAME quantity this bound enforces. A ceiling
 *  calibrated against one definition of "node" and enforced against another is not calibrated. */
export function countSchemaNodes(doc: unknown): number {
  let nodes = 0;
  const walk = (d: unknown): void => {
    // A BOOLEAN IS A SUBSCHEMA. `true` and `false` are valid 2020-12 schemas, and in an applicator
    // position each one is a branch the compiler generates code for. Skipping them made the whole
    // count bypassable: `{anyOf: [false, …x40000]}` is legal, costs ~3.8s to compile at 240KB —
    // inside every byte bound — and counted as ONE node, so the ceiling never engaged. Reproduced
    // before this line existed.
    if (typeof d === "boolean") { nodes++; return; }
    if (d === null || typeof d !== "object") return;
    if (Array.isArray(d)) { for (const v of d) walk(v); return; }
    nodes++;
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (SUBSCHEMA_KEYS.includes(k)) walk(v);
      else if (SUBSCHEMA_MAP_KEYS.includes(k) && v && typeof v === "object") for (const s of Object.values(v as object)) walk(s);
      else if (SUBSCHEMA_LIST_KEYS.includes(k) && Array.isArray(v)) for (const s of v) walk(s);
    }
  };
  walk(doc);
  return nodes;
}

/** Enforce the D27 profile on one document: size, depth, node count, and reference closure.
 *  Returns the digest-refs the document makes (for closure walking). */
function assertDocumentProfile(doc: unknown, label: string): string[] {
  const canonical = canonicalOrInvalid(doc, label); // also enforces I-JSON, as contract-invalid
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > SCHEMA_PROFILE.maxDocumentBytes)
    throw new ContractInvalidError(`${label}: document is ${bytes} bytes (profile max ${SCHEMA_PROFILE.maxDocumentBytes})`);
  if (structuralDepth(doc) > SCHEMA_PROFILE.maxDepth)
    throw new ContractInvalidError(`${label}: nesting exceeds profile depth ${SCHEMA_PROFILE.maxDepth}`);
  const nodes = countSchemaNodes(doc);
  if (nodes > SCHEMA_PROFILE.maxSchemaNodes)
    throw new ContractInvalidError(`${label}: ${nodes} subschema nodes (profile max ${SCHEMA_PROFILE.maxSchemaNodes}); the compile cost of a contract is bounded BEFORE compiling it, deterministically and identically on every host`);
  const storeRefs: string[] = [];
  for (const ref of collectRefs(doc, label)) {
    if (ref.startsWith("#")) continue; // local pointer/anchor — resolved within the document
    const m = STORE_REF.exec(ref);
    if (!m) throw new ContractInvalidError(`${label}: external $ref ${JSON.stringify(ref)}; only local '#…' or digest-pinned 'cotal:sha256:<hex>' references are permitted (no ambient resolution)`);
    storeRefs.push(m[1]);
  }
  return storeRefs;
}

/** A registered contract schema: the compiled validator plus the bundle's CLOSURE digest —
 *  the artifact digest of the §13.7 manifest `{ v: 1, root, members[] }` (members = every
 *  artifact transitively REACHABLE from the root, sorted and deduplicated). The closure digest
 *  is the contract identity `op.inputDigest`/`op.outputDigest` pin.
 *
 *  The interface is structural for CONSUMERS, but authority seams never accept structure: a
 *  compiled contract is FROZEN and brand-registered by this compiler ({@link compileContract}),
 *  and {@link assertCompiledContract} refuses any object the profile compiler did not produce —
 *  so a hand-built `{validate, closureDigest}` pair (an arbitrary validator wearing a
 *  registered digest) can never enter a serve table (§13.7: the digest and its enforcing
 *  validator are one value). */
export interface CompiledContract {
  validate: ValidateFunction;
  closureDigest: string;
}

/** Provenance brand: exactly the frozen objects this compiler returned. A WeakSet (not a
 *  field) so the brand is unforgeable and unserializable; the freeze makes field swaps on a
 *  branded object impossible, so brand membership proves BOTH fields came out of one compile. */
const COMPILED = new WeakSet<CompiledContract>();

function makeCompiled(validate: ValidateFunction, closureDigest: string): CompiledContract {
  const compiled: CompiledContract = Object.freeze({ validate, closureDigest });
  COMPILED.add(compiled);
  return compiled;
}

/** True iff `c` is a frozen contract this profile compiler produced (never structural). */
export function isCompiledContract(c: unknown): c is CompiledContract {
  return typeof c === "object" && c !== null && COMPILED.has(c as CompiledContract);
}

/** Refuse anything that is not a compiler-produced contract: authority seams (the serve table,
 *  the grant mint) call this so a fabricated validator/digest pair fails loud, never serves. */
export function assertCompiledContract(c: unknown, what: string): CompiledContract {
  if (!isCompiledContract(c))
    throw new ContractInvalidError(`${what} is not a profile-compiled contract (schema-profile compileContract); a structural {validate, closureDigest} pair carries no compile provenance and is refused (SPEC 13.7)`);
  return c;
}

/** Enforce the profile on the whole closure WITHOUT compiling: bounds every document, walks the
 *  digest-reference graph breadth-first (chain depth + total size), VERIFIES every reachable
 *  member against its digest key (fail-loud `contract-invalid`, so a mis-assembled bundle can
 *  neither register nor poison the compiled cache), and returns the closure identity — the
 *  §13.7 manifest digest. */
function assertClosureProfile(bundle: SchemaBundle): string {
  const members = bundle.members ?? {};
  for (const d of Object.keys(members)) {
    if (!isContractDigest(d)) throw new ContractInvalidError(`bundle member key ${JSON.stringify(d)} is not a sha256 digest`);
  }
  const seen = new Set<string>();
  let closureBytes = 0;
  let frontier = assertDocumentProfile(bundle.root, "root schema");
  closureBytes += Buffer.byteLength(canonicalOrInvalid(bundle.root, "root schema"), "utf8");
  // Nodes accumulate across the closure exactly as bytes do. The per-document ceiling alone is
  // bypassable by splitting: 16 members of 252 nodes each is 4,049 nodes with every document
  // passing 256, and the compiler pays the aggregate.
  let closureNodes = countSchemaNodes(bundle.root);
  for (let chain = 0; frontier.length > 0; chain++) {
    if (chain >= SCHEMA_PROFILE.maxRefChain)
      throw new ContractInvalidError(`reference chain exceeds profile depth ${SCHEMA_PROFILE.maxRefChain}`);
    const next: string[] = [];
    for (const digest of frontier) {
      if (seen.has(digest)) continue;
      seen.add(digest);
      const member = members[digest];
      if (member === undefined)
        throw new ContractInvalidError(`unresolved digest reference ${digest}: not present in the bundle (schemas are closed; nothing is fetched)`);
      if (digestOrInvalid(member, `member ${digest}`) !== digest)
        throw new ContractInvalidError(`bundle member under ${digest} does not hash to its key (content is ${digestOrInvalid(member, `member ${digest}`)})`);
      closureBytes += Buffer.byteLength(canonicalOrInvalid(member, `member ${digest}`), "utf8");
      if (closureBytes > SCHEMA_PROFILE.maxClosureBytes)
        throw new ContractInvalidError(`closure is ${closureBytes} bytes (profile max ${SCHEMA_PROFILE.maxClosureBytes})`);
      closureNodes += countSchemaNodes(member);
      if (closureNodes > SCHEMA_PROFILE.maxClosureNodes)
        throw new ContractInvalidError(`closure is ${closureNodes} subschema nodes (profile max ${SCHEMA_PROFILE.maxClosureNodes}); a per-document bound alone is bypassable by splitting one schema across members`);
      next.push(...assertDocumentProfile(member, `member ${digest}`));
    }
    frontier = next;
  }
  // A closed bundle lists EXACTLY the closure: a member unreachable from the root escaped every
  // bound and digest check above and never enters the closure identity, so accepting it would
  // make registration history-dependent (cold compile vs cache hit) and hand unverified,
  // unbounded input to the compiler. Refused deterministically, before hit and miss alike.
  const extras = Object.keys(members).filter((d) => !seen.has(d));
  if (extras.length > 0)
    throw new ContractInvalidError(`bundle carries ${extras.length} member(s) unreachable from the root (${extras.slice(0, 3).join(", ")}${extras.length > 3 ? ", …" : ""})`);
  return contractDigest({ v: 1, root: digestOrInvalid(bundle.root, "root schema"), members: [...seen].sort() });
}

function compileWithinBudget(bundle: SchemaBundle): ValidateFunction {
  // THE REFUSAL HAS MOVED. The pathological-schema ceiling is now `maxSchemaNodes`, enforced in
  // `assertDocumentProfile` BEFORE this function runs. The timing below is kept as an OBSERVATION
  // and refuses nothing.
  //
  // Why the timing could not stay a refusal: no instrument available on this package's Node floor
  // measures the right quantity. Wall clock counts the machine — a trivial two-property closure
  // compiles in ~4ms warm, yet on a loaded host measured 101-158ms elapsed and was refused, so a
  // manager could not import its own contracts. `process.cpuUsage()` sums EVERY THREAD in the
  // process, so V8's background optimizing-compiler threads land in it, as does any sibling Worker
  // (16.4ms of process CPU against 0.18ms on the measuring thread). Node exposes no per-thread CPU
  // below 22.19 and the floor is `>=22`, so there was no third instrument.
  //
  // That was not theoretical. `Windows / required` refused the manager's OWN service contract with
  // `compile took 125ms of CPU (profile budget 100ms; 80ms elapsed)` — CPU above wall clock, which
  // is only possible with concurrent threads. The costliest schema in that contract measures 6.4ms
  // warm and ALL 23 of its schemas together total 71.5ms. A 3-node schema cannot cost 125ms of
  // compile work, and the same contract compiled fine in four sibling jobs on the same runner
  // image. The number was very nearly all instrument, and it made the required gate unmergeable.
  //
  // Nothing is left unguarded by the move. The gap the other deterministic bounds miss — 1000
  // patterned properties is ~90KB, inside maxDocumentBytes and maxClosureBytes, depth 2, ref-chain
  // 0, every pattern legal — is 1001 NODES, so the node bound refuses it four times over while
  // every contract this repo registers sits at or below 20.
  //
  // SPEC 2458 gives 100ms as a REFERENCE budget, not a normative constant, and a node-count refusal
  // is still `contract-invalid` at registration, so this needs no spec amendment.
  const startedCpu = process.cpuUsage();
  const started = Date.now();
  // Compile with deterministic local resolution only. Members register under their cotal: URI
  // so in-document `$ref: "cotal:sha256:…"` resolves from the bundle, never the network.
  const ajv = new Ajv2020(AJV_PROFILE_OPTIONS);
  let validate: ValidateFunction;
  try {
    // Every member is reachable and digest-verified (assertClosureProfile refuses extras), so
    // exactly the closure registers. A registration failure (e.g. a `$id` collision between
    // members) is a profile rejection, same as a compile failure.
    for (const [digest, member] of Object.entries(bundle.members ?? {})) ajv.addSchema(member as object, `cotal:${digest}`);
    validate = ajv.compile(bundle.root as object);
  } catch (e) {
    throw new ContractInvalidError(`schema does not compile under the 2020-12 profile: ${(e as Error).message}`);
  }
  const cpu = process.cpuUsage(startedCpu);
  const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
  if (cpuMs > SCHEMA_PROFILE.compileBudgetMs)
    console.error(
      `! schema: compile took ~${cpuMs}ms of process CPU (SPEC 2458 reference budget ${SCHEMA_PROFILE.compileBudgetMs}ms; ` +
      `${Date.now() - started}ms elapsed). Approximate - process-wide CPU includes JIT/Worker threads. ` +
      `Not a refusal: the enforced ceiling is ${SCHEMA_PROFILE.maxSchemaNodes} subschema nodes, checked before compiling.`,
    );
  return validate;
}

/** Validate the whole closure against the profile and compile it with a real 2020-12
 *  validator. No network, no filesystem: `loadSchema` is never installed, and every
 *  `cotal:` reference must be present in `bundle.members`. */
export function compileContract(bundle: SchemaBundle): CompiledContract {
  const closureDigest = assertClosureProfile(bundle);
  return makeCompiled(compileWithinBudget(bundle), closureDigest);
}

/** {@link compileContract} without the closure identity, kept for validation-only callers. */
export function compileContractSchema(bundle: SchemaBundle): ValidateFunction {
  return compileContract(bundle).validate;
}

/** A bounded compiled-schema LRU (SPEC §13.7's reference 256-entry cache), keyed by CLOSURE
 *  digest. The profile walk (incl. member digest verification) runs on EVERY call — only the
 *  ajv compilation is skipped on a hit. Sound across callers: two bundles with one closure
 *  digest are byte-identical closures, so a hit can never serve another caller's
 *  mis-assembled bundle. */
export function createCompiledContractCache(capacity: number = SCHEMA_PROFILE.compiledCacheEntries): {
  compile: (bundle: SchemaBundle) => CompiledContract;
  size: () => number;
} {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error(`cache capacity ${capacity} is not a positive integer`);
  const lru = new Map<string, CompiledContract>();
  return {
    compile(bundle: SchemaBundle): CompiledContract {
      const closureDigest = assertClosureProfile(bundle);
      const hit = lru.get(closureDigest);
      if (hit) {
        lru.delete(closureDigest); // refresh recency
        lru.set(closureDigest, hit);
        return hit;
      }
      const compiled = makeCompiled(compileWithinBudget(bundle), closureDigest);
      lru.set(closureDigest, compiled);
      if (lru.size > capacity) lru.delete(lru.keys().next().value as string);
      return compiled;
    },
    size: () => lru.size,
  };
}
