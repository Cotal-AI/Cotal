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
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import { prepareContractValidator, type ContractValidator } from "./contract-validator.js";
export type { ContractValidator, ContractValidationError } from "./contract-validator.js";
import { SCHEMA_PROFILE } from "./schema-bounds.js";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { assertSafePattern } from "./safe-pattern.js";
import { buildContractClosureManifest, type ContractClosureManifest } from "./contract-manifest.js";

export { SCHEMA_PROFILE };

/** Schema meta-validation only. Instance verdicts come from the shared interpreter. */
const AJV_PROFILE_OPTIONS = Object.freeze({
  strict: false,
  allErrors: true,
  ownProperties: true,
  validateFormats: false,
  loadSchema: undefined,
  validateSchema: true,
  meta: true,
  unicodeRegExp: true,
  inlineRefs: false,
} as const);

/** Built-in meta-validation is shared lazily. Caller documents are only data to this instance;
 *  it never registers or compiles them, so their IDs and references remain closure-local. */
let sharedMeta: { ajv: Ajv2020; keys: ReadonlySet<string> } | undefined;

/** A fresh compiler per closure, reusing only the meta-schemas every native instance starts with.
 *  A custom `$schema` stays on the closure's instance, where its members are registered. */
class ProfileAjv extends Ajv2020 {
  override validateSchema(schema: AnySchema, throwOrLogError?: boolean): boolean | Promise<unknown> {
    if (schema === null || typeof schema !== "object") return super.validateSchema(schema, throwOrLogError);
    if (!sharedMeta) {
      const ajv = new Ajv2020(AJV_PROFILE_OPTIONS);
      sharedMeta = { ajv, keys: new Set([...Object.keys(ajv.schemas), ...Object.keys(ajv.refs)]) };
    }
    if (schema.$schema !== undefined && !sharedMeta.keys.has(schema.$schema))
      return super.validateSchema(schema, throwOrLogError);
    try {
      return sharedMeta.ajv.validateSchema(schema, throwOrLogError);
    } finally {
      this.errors = sharedMeta.ajv.errors;
    }
  }
}

/** The §13.7 closure of one self-contained document: the manifest naming it with no members, and
 *  that manifest's digest, the closure digest a registration or an `op` digest carries. It needs no
 *  compile, and `compileContract` returns the same digest for a member-free schema. Producers build
 *  it here so none drifts from {@link import("./endpoint-cluster.js").verifyClusterManifest}; it is
 *  not beside that reader because `VOID_SCHEMA_DIGEST` is built from it at load and
 *  `endpoint-cluster` already imports this module. */
export function singleDocumentClosure(root: unknown): { manifest: ContractClosureManifest; closureDigest: string } {
  const manifest = buildContractClosureManifest(contractDigest(root), []);
  return { manifest, closureDigest: contractDigest(manifest) };
}

/** The canonical void schema (§13.7): the one artifact a side with no payload declares, so both
 *  `op` digests exist for every command. Validation against it means the payload is absent or
 *  `null`. */
export const VOID_SCHEMA = Object.freeze({ type: "null" } as const);
/** Artifact digest of the void schema document — one fixed value by construction. */
export const VOID_SCHEMA_ARTIFACT_DIGEST = contractDigest(VOID_SCHEMA);
/** The void schema's CLOSURE digest (the §13.7 manifest of a self-contained document) — the
 *  value `op.inputDigest`/`op.outputDigest` carry for a payload-free side. */
export const VOID_SCHEMA_DIGEST = singleDocumentClosure(VOID_SCHEMA).closureDigest;

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

/**
 * Applicator keywords whose VALUE is a subschema, a map of them, or an array of them. Compile
 * cost is driven by how many subschemas the compiler generates code for, so the walk follows
 * exactly these and nothing else.
 *
 * THE ADMITTED VOCABULARY. Any keyword outside these three sets is REFUSED at registration.
 *
 * WHY AN ALLOWLIST RATHER THAN A LONGER WALK LIST, which is the whole lesson of this guard: the node
 * count was bypassed three separate times — booleans, closure splitting, legacy `dependencies` — and
 * each repair added entries to a hand-maintained list of things to walk. Then asking Ajv what it
 * actually registers (63 keywords, against 19 walked) produced a FOURTH within the hour:
 * `contentSchema` is native 2020-12 and holds a subschema, so it is admitted on the specification's
 * authority and NOT on any hole observed here: Ajv 8.20.0 does not implement it (absent from
 * `RULES.all`; codegen length is unchanged by a 400-property `contentSchema`), so counting it as one
 * node matched an ignore and hid no compiler work. It is listed because that stops being true the
 * day a compiler implements it. `dependencies` is the keyword that actually bypassed the counter.
 *
 * "Count the keywords I know" cannot be made sound by knowing more keywords, because its failure
 * mode is silent: an unrecognised schema-valued position contributes ZERO and the count still looks
 * like a count. Whether a fifth exists is unknowable from inside the list, which is the point.
 *
 * So the default inverts. A keyword this profile does not recognise is refused rather than skipped,
 * and the counting below then runs over a set that cannot contain a surprise — because a surprise
 * was already refused. That is the difference between "I counted what I know" and "nothing I do not
 * know can pass".
 *
 * THIS IS STRICTER THAN JSON SCHEMA, DELIBERATELY. The specification says an unknown keyword is
 * ignored as an annotation; this profile refuses it. That is consistent with what the profile
 * already does — closed bundles, no ambient resolution, a bounded pattern subset — and it is the
 * only form that stays sound when the compiler's vocabulary changes underneath it. A contract that
 * needs a keyword absent here is a request to extend this list, reviewed, rather than a silent
 * admission of something nobody has counted.
 */
const SCHEMA_VALUED_KEYS = ["not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "contentSchema", "additionalItems"];
const SCHEMA_VALUED_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];
const SCHEMA_VALUED_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
/** Admitted, never containing a subschema: validation assertions, annotations, and core identifiers.
 *  Listed exhaustively so an addition is a decision rather than an oversight.
 *
 *  THE RULE FOR ADMITTING A KEYWORD, because "ask the reviewer" is not a rule and the next person
 *  should not have to guess:
 *
 *  1. CAN IT HOLD A SUBSCHEMA? Then it belongs in one of the three positional lists above, never
 *     here. Getting this wrong is not a stylistic error — the walk stops descending, and a schema
 *     position gets treated as inert data. That is exactly how `dependencies` went unrecognised (600
 *     schemas under it counted as 1 while Ajv generated 684,811 source characters and enforced every
 *     one), and it is the defect this whole inversion exists to make impossible.
 *  2. IS IT INERT? An annotation that cannot change the validation outcome or its cost is admitted
 *     freely, and the ENTIRE 2020-12 annotation vocabulary is listed below for that reason:
 *     `title`, `description`, `default`, `deprecated`, `readOnly`, `writeOnly`, `examples`,
 *     `$comment`. Refusing a contract for carrying documentation would be an absurd outcome, and
 *     the inversion is only defensible if the admitted set is wide enough to hold everything inert.
 *  3. OTHERWISE it changes validation semantics or cost, and it goes here only once someone has
 *     confirmed it holds no subschema in any position.
 *
 *  AND AN UNLISTED KEYWORD IS REFUSED EVEN WHEN IT IS OBVIOUSLY HARMLESS — a vendor extension, a
 *  2020-13 annotation, anything invented after this line was written. That is the cost of the
 *  inversion and it is paid deliberately: the alternative is a prefix or heuristic escape hatch,
 *  and any rule of the form "keywords like THIS are fine" is a rule an attacker also gets to use.
 *  The remedy for a legitimately harmless keyword is one reviewed line here. */
const SCALAR_KEYS = [
  "type", "enum", "const", "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
  "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems", "maxContains",
  "minContains", "maxProperties", "minProperties", "required", "dependentRequired",
  "format", "contentEncoding", "contentMediaType",
  "title", "description", "default", "deprecated", "readOnly", "writeOnly", "examples", "$comment",
  "$id", "$schema", "$ref", "$anchor", "$dynamicRef", "$dynamicAnchor", "$vocabulary",
];
const ADMITTED = new Set([...SCHEMA_VALUED_KEYS, ...SCHEMA_VALUED_MAP_KEYS, ...SCHEMA_VALUED_LIST_KEYS, ...SCALAR_KEYS]);

/** Refuse any keyword the profile does not admit. Runs BEFORE counting, so the count never has to
 *  reason about a keyword nobody enumerated.
 *
 *  SCHEMA-POSITION AWARE, and it has to be: the keys of `properties`, `patternProperties`, `$defs`,
 *  `definitions`, `dependentSchemas` and `dependencies` are USER-CHOSEN NAMES, not keywords. A naive
 *  walk that checked every object key against the vocabulary would refuse every schema with a field
 *  called `name`. And the values of `enum`, `const`, `default` and `examples` are arbitrary JSON
 *  INSTANCE data, not schemas, so descending into them would refuse a legitimate default whose
 *  object happened to carry an unrecognised key. Keyword positions and data positions are different
 *  places and only the first is vocabulary. */
function assertAdmittedVocabulary(doc: unknown, label: string): void {
  const atSchema = (d: unknown, path: string): void => {
    if (typeof d === "boolean") return;                       // `true`/`false` are valid subschemas
    if (d === null || typeof d !== "object" || Array.isArray(d)) return;
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (!ADMITTED.has(k))
        throw new ContractInvalidError(`${label}: keyword ${JSON.stringify(k)} at ${path || "/"} is not in the profile's admitted vocabulary; an unrecognised keyword is REFUSED rather than ignored, because this profile cannot count what it does not recognise`);
      const here = `${path}/${k}`;
      if (SCHEMA_VALUED_KEYS.includes(k)) atSchema(v, here);
      else if (SCHEMA_VALUED_MAP_KEYS.includes(k) && v && typeof v === "object" && !Array.isArray(v))
        for (const [name, sub] of Object.entries(v as Record<string, unknown>)) atSchema(sub, `${here}/${name}`);
      else if (SCHEMA_VALUED_LIST_KEYS.includes(k) && Array.isArray(v))
        v.forEach((sub, i) => atSchema(sub, `${here}/${i}`));
      // everything else is a scalar assertion, an annotation, or instance data — not walked
    }
  };
  atSchema(doc, "");
}



/** Enforce the D27 profile on one document: size, depth, vocabulary, and reference closure.
 *  Returns the digest-refs the document makes (for closure walking). */
function assertDocumentProfile(doc: unknown, label: string): string[] {
  const canonical = canonicalOrInvalid(doc, label); // also enforces I-JSON, as contract-invalid
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > SCHEMA_PROFILE.maxDocumentBytes)
    throw new ContractInvalidError(`${label}: document is ${bytes} bytes (profile max ${SCHEMA_PROFILE.maxDocumentBytes})`);
  if (structuralDepth(doc) > SCHEMA_PROFILE.maxDepth)
    throw new ContractInvalidError(`${label}: nesting exceeds profile depth ${SCHEMA_PROFILE.maxDepth}`);
  assertAdmittedVocabulary(doc, label);
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
  validate: ContractValidator;
  closureDigest: string;
}

/** Provenance brand: exactly the frozen objects this compiler returned. A WeakSet (not a
 *  field) so the brand is unforgeable and unserializable; the freeze makes field swaps on a
 *  branded object impossible, so brand membership proves BOTH fields came out of one compile. */
const COMPILED = new WeakSet<CompiledContract>();

function makeCompiled(validate: ContractValidator, closureDigest: string): CompiledContract {
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
  return contractDigest(buildContractClosureManifest(digestOrInvalid(bundle.root, "root schema"), [...seen]));
}

function compileWithinBudget(bundle: SchemaBundle): ContractValidator {
  try {
    // Ajv checks schema validity and closure-local custom meta-schemas only. It never
    // compiles an instance validator and never decides an instance verdict.
    const meta = new ProfileAjv(AJV_PROFILE_OPTIONS);
    for (const [digest, member] of Object.entries(bundle.members ?? {}))
      meta.addSchema(member as object, `cotal:${digest}`);
    meta.addSchema(bundle.root as AnySchema);
    return prepareContractValidator(bundle);
  } catch (error) {
    throw new ContractInvalidError(`schema does not compile under the 2020-12 profile: ${(error as Error).message}`);
  }
}

/** Validate the whole closure against the profile and compile it with a real 2020-12
 *  validator. No network, no filesystem: `loadSchema` is never installed, and every
 *  `cotal:` reference must be present in `bundle.members`. */
export function compileContract(bundle: SchemaBundle): CompiledContract {
  const closureDigest = assertClosureProfile(bundle);
  return makeCompiled(compileWithinBudget(bundle), closureDigest);
}

/** Build-time module source for a checked closure. The module imports the node-free interpreter
 * and prepares the authored schema as data, with the same verdicts as compileContract. */
export function standaloneContractSource(bundle: SchemaBundle): { closureDigest: string; source: string } {
  const closureDigest = assertClosureProfile(bundle);
  compileWithinBudget(bundle);
  const literal = `JSON.parse(${JSON.stringify(JSON.stringify(bundle)).replace(/</g, "\\u003c")})`;
  return { closureDigest, source: `import { prepareContractValidator } from "@cotal-ai/core/contract-validator";\nexport const validate = prepareContractValidator(${literal});\nexport default validate;\n` };
}

/** {@link compileContract} without the closure identity, kept for validation-only callers. */
export function compileContractSchema(bundle: SchemaBundle): ContractValidator {
  return compileContract(bundle).validate;
}

/** A bounded compiled-schema LRU (SPEC §13.7's reference 256-entry cache), keyed by CLOSURE
 *  digest. The profile walk (incl. member digest verification) runs on EVERY call — only the
 *  preparation is skipped on a hit. Sound across callers: two bundles with one closure
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

type ContractPair = Readonly<{ input: CompiledContract; output: CompiledContract }>;

/** A service's compiled command contracts and the §13.7 artifacts its registration publishes,
 *  from its command rows. The frozen `contracts` table compiles and freezes a command's pair on
 *  its first access and keeps it, so a module can build its table at load while a process that only
 *  reads digests pays no validator preparation. `artifactValues()` returns each distinct schema root followed
 *  by its closure manifest. */
export function serviceContractTable(rows: ReadonlyArray<{ name: string; input: unknown; output: unknown }>): {
  contracts: Readonly<Record<string, ContractPair>>;
  artifactValues: () => unknown[];
} {
  const contracts: Record<string, ContractPair> = Object.create(null);
  for (const row of rows) {
    let pair: ContractPair | undefined;
    Object.defineProperty(contracts, row.name, {
      enumerable: true,
      get: () => {
        if (!pair) {
          pair = Object.freeze({ input: compileContract({ root: row.input as Record<string, unknown> }), output: compileContract({ root: row.output as Record<string, unknown> }) });
        }
        return pair;
      },
    });
  }
  return {
    contracts: Object.freeze(contracts),
    artifactValues: () => {
      const values: unknown[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        for (const source of [r.input, r.output]) {
          const { manifest } = singleDocumentClosure(source);
          if (seen.has(manifest.root)) continue;
          seen.add(manifest.root);
          values.push(source, manifest);
        }
      }
      return values;
    },
  };
}
