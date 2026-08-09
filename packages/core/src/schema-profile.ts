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
  /** Max SUBSCHEMA NODES in a document — the deterministic replacement for the compile-time
   *  budget, computable exactly before compiling and identical on every host.
   *
   *  256 is a decision, taken from measurement, and here is the measurement so a later reader can
   *  re-derive it instead of treating the number as folklore. On a quiet box, warm (each schema
   *  compiled once and discarded first, so this is the schema's intrinsic cost and not V8 cold
   *  start):
   *
   *    largest contract this repo actually registers   20 nodes    6.4ms CPU
   *    cheapest schema that genuinely burns the budget  801 nodes  112.0ms CPU
   *    margin                                          781 nodes / 40.0x
   *
   *  256 sits 12.8x above everything we register and 3.1x below the pathological edge. 100 would
   *  leave only 5x of headroom against contracts that will grow; 400 spends margin we have no use
   *  for.
   *
   *  READ THIS BEFORE TRUSTING THE NUMBER FOR ANYTHING ELSE: node count is a sound BOUND, not a
   *  good PREDICTOR. Cost varies ~5x at IDENTICAL node count across schema shapes (at 801 nodes,
   *  a wide `anyOf` costs 23ms where patterned properties cost 112ms), and on our own contract the
   *  costliest schema is not the largest. The 40x margin absorbs that spread with room left, which
   *  is what makes the bound usable — but a large, cheap `anyOf` schema an order of magnitude
   *  bigger than anything we register today could be refused while being fast. That is the known
   *  and accepted false-refusal shape.
   *
   *  Counts SUBSCHEMA nodes, matching {@link countSchemaNodes} — the same function the calibration
   *  runs, so the ceiling is enforced against the quantity it was calibrated on. */
  maxSchemaNodes: 256,
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
  const ajv = new Ajv2020({
    strict: false, // the wire accepts full 2020-12, not ajv's strict-mode dialect subset
    allErrors: false,
    validateFormats: false,
    loadSchema: undefined,
    // PINNED, never inherited from Ajv's default: the safe-pattern analyzer models `/u`
    // semantics exactly (astral atoms, surrogate refusals), so the engine MUST compile
    // `pattern` with the `u` flag. If this ever flipped, patterns would be proven under one
    // grammar and executed under another (an admitting under-approximation).
    unicodeRegExp: true,
  });
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
