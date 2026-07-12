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

/** Registration-time bounds (SPEC §13.7/§13.8). Fixed by the profile, not caller-tunable. */
export const SCHEMA_PROFILE = {
  /** One schema document's canonical form, bytes. */
  maxDocumentBytes: 256 * 1024,
  /** The complete resolved closure (root + digest-referenced members), bytes. */
  maxClosureBytes: 1024 * 1024,
  /** Structural nesting depth of any document. */
  maxDepth: 32,
  /** Digest-reference chain depth (root → member → member …). */
  maxRefChain: 32,
  /** Compile budget per closure, ms. */
  compileBudgetMs: 100,
  /** Bounded pattern complexity: max characters of any `pattern` / `patternProperties` regex. */
  maxPatternChars: 256,
  /** Per-value validation budget at the serving boundary, ms (§13.8 reference; post-hoc,
   *  fail-loud as `bad-request`). */
  validateBudgetMs: 10,
  /** Compiled-schema cache entries (the SPEC's reference 256-entry LRU). */
  compiledCacheEntries: 256,
} as const;

/** The canonical void schema (§13.7): the one artifact a side with no payload declares, so both
 *  `op` digests exist for every command. Validation against it means the payload is absent or
 *  `null`. */
export const VOID_SCHEMA = { type: "null" } as const;
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

/** Enforce the D27 profile on one document: size, depth, and reference closure. Returns the
 *  digest-refs the document makes (for closure walking). */
function assertDocumentProfile(doc: unknown, label: string): string[] {
  const canonical = canonicalOrInvalid(doc, label); // also enforces I-JSON, as contract-invalid
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > SCHEMA_PROFILE.maxDocumentBytes)
    throw new ContractInvalidError(`${label}: document is ${bytes} bytes (profile max ${SCHEMA_PROFILE.maxDocumentBytes})`);
  if (structuralDepth(doc) > SCHEMA_PROFILE.maxDepth)
    throw new ContractInvalidError(`${label}: nesting exceeds profile depth ${SCHEMA_PROFILE.maxDepth}`);
  const storeRefs: string[] = [];
  for (const ref of collectRefs(doc, label)) {
    if (ref.startsWith("#")) continue; // local pointer/anchor — resolved within the document
    const m = STORE_REF.exec(ref);
    if (!m) throw new ContractInvalidError(`${label}: external $ref ${JSON.stringify(ref)} — only local '#…' or digest-pinned 'cotal:sha256:<hex>' references are permitted (no ambient resolution)`);
    storeRefs.push(m[1]);
  }
  return storeRefs;
}

/** A registered contract schema: the compiled validator plus the bundle's CLOSURE digest —
 *  the artifact digest of the §13.7 manifest `{ v: 1, root, members[] }` (members = every
 *  artifact transitively REACHABLE from the root, sorted and deduplicated). The closure digest
 *  is the contract identity `op.inputDigest`/`op.outputDigest` pin. */
export interface CompiledContract {
  validate: ValidateFunction;
  closureDigest: string;
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
  const started = Date.now();
  // Compile with deterministic local resolution only. Members register under their cotal: URI
  // so in-document `$ref: "cotal:sha256:…"` resolves from the bundle, never the network.
  const ajv = new Ajv2020({
    strict: false, // the wire accepts full 2020-12, not ajv's strict-mode dialect subset
    allErrors: false,
    validateFormats: false,
    loadSchema: undefined,
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
  const elapsed = Date.now() - started;
  if (elapsed > SCHEMA_PROFILE.compileBudgetMs)
    throw new ContractInvalidError(`compile took ${elapsed}ms (profile budget ${SCHEMA_PROFILE.compileBudgetMs}ms)`);
  return validate;
}

/** Validate the whole closure against the profile and compile it with a real 2020-12
 *  validator. No network, no filesystem: `loadSchema` is never installed, and every
 *  `cotal:` reference must be present in `bundle.members`. */
export function compileContract(bundle: SchemaBundle): CompiledContract {
  const closureDigest = assertClosureProfile(bundle);
  return { validate: compileWithinBudget(bundle), closureDigest };
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
      const compiled: CompiledContract = { validate: compileWithinBudget(bundle), closureDigest };
      lru.set(closureDigest, compiled);
      if (lru.size > capacity) lru.delete(lru.keys().next().value as string);
      return compiled;
    },
    size: () => lru.size,
  };
}
