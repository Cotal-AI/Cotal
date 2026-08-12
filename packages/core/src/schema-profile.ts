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
  // THERE IS DELIBERATELY NO SUBSCHEMA-NODE BOUND HERE, and this note is the guard on that: a node
  // ceiling was proposed twice, and the second attempt was killed by the measurement it asked for.
  //
  // The proposal was to refuse a "pathological" schema by counting subschema nodes before compiling
  // — deterministic, host-independent, and unlike a timer, immune to the machine. Two bases were
  // offered for the constant, and both are dead:
  //
  //   COST. There is no knee. Compile cost varies by an ORDER OF MAGNITUDE across schema shapes at a
  //   single node count, the spread itself grows with node count, and no two measurements of one
  //   cell have ever agreed. NO FIGURE IS QUOTED HERE ON PURPOSE. Six runs of the same quantity
  //   across four parties spanned a factor of six, agreeing only where one had read another's number
  //   first, so any single ratio in this comment would be an unreplicated observation presented as a
  //   measurement. Node count is a sound bound and a poor predictor: a single scalar is set by the
  //   worst family and refuses the best, rejecting a cheap union while admitting a far costlier
  //   object schema. THAT SHAPE is what defeats the proposal, and unlike a ratio it survives a re-run
  //   on another host. To see the numbers for your host, run the probe named below.
  //
  //   CRASH. A 2048-node patterned-properties document was observed to RangeError in Ajv's codegen
  //   at ~186KB — inside `maxDocumentBytes` — which looked like a hard edge worth standing in front
  //   of. It is not an edge, and it failed to reproduce twice over. THE SAME SCHEMA IN THE SAME
  //   PROCESS threw after 95.7ms cold and then COMPILED in 1035.5ms on the immediate warm retry;
  //   and on the host these figures were taken from it does not throw at all, compiling in 679.8ms
  //   cold and 544.8ms warm. A boundary that moves between two consecutive runs of one process, and
  //   is absent on the next host, cannot be the basis of a frozen constant.
  //
  //   AND THE VALUE WAS UNSAFE ON AN AXIS NOBODY MEASURED. Under `node --stack-size=256` a 512-node
  //   object RangeErrors, while 384 compiles — so the proposed `maxSchemaNodes: 512` did not hold
  //   at a supported process configuration. A bound that is not a bound across the axes it ships on
  //   is not a bound.
  //
  // WHAT STANDS IN ITS PLACE is what was doing the work the whole time: `maxDocumentBytes` and
  // `maxClosureBytes`, `maxDepth`, `maxRefChain`, `maxPatternChars`, the admitted-vocabulary
  // refusal, and — for exactly the codegen overflow above — the compile-error catch in
  // `compileWithinBudget`, which has been normalising these to `contract-invalid` all along. That
  // set refuses everything it refused before; removing an unfounded bound only LOOSENS, and
  // loosening cannot break a contract that was already valid.
  //
  // BEFORE PROPOSING ONE AGAIN, run `implementations/manager/smoke/_probe-nodecount-rejected.ts`.
  // It MEASURES the spread and the crash boundary on your host, against the compiler that actually
  // ships, and reports no stored figures of its own. The first version of
  // this ceiling was derived from a corpus THE CEILING ITSELF BOUNDED — every synthetic above the
  // line was refused, so the calibration reported that nothing measured had exceeded the budget,
  // and the number was unfalsifiable the moment it shipped. Measure above the line, or do not set
  // the line.
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
 * The EXACT Ajv configuration the profile compiles with. Module-private: it was briefly exported so
 * a node-ceiling calibration could measure the real compiler, and that ceiling is gone (see
 * SCHEMA_PROFILE), so the export would be a public surface with nothing behind it.
 *
 * EVERY OPTION HERE IS PINNED RATHER THAN INHERITED, including the ones whose pinned value equals
 * Ajv's current default. An inherited default is a behaviour this profile depends on and does not
 * control: it can change in a minor release, and a `^8` range will take that change silently. The
 * two comments below record what each pin is load-bearing FOR, because a pin nobody can explain is
 * the first one someone deletes.
 */
const AJV_PROFILE_OPTIONS = Object.freeze({
  strict: false, // the wire accepts full 2020-12, not ajv's strict-mode dialect subset
  allErrors: false,
  validateFormats: false,
  loadSchema: undefined,
  // PINNED, never inherited from Ajv's default: the safe-pattern analyzer models `/u`
  // semantics exactly (astral atoms, surrogate refusals), so the engine MUST compile
  // `pattern` with the `u` flag. If this ever flipped, patterns would be proven under one
  // grammar and executed under another (an admitting under-approximation).
  unicodeRegExp: true,
  // PINNED for the same reason as `unicodeRegExp`, and discovered the same way — by checking what
  // an inherited default actually does rather than assuming it does nothing.
  //
  // Ajv defaults this to TRUE (`ajv@8.20.0/dist/core.js:83`), and with it on, a referenced schema
  // with no refs of its own is INLINED INTO ITS REFERRER'S GENERATED CODE. A closure is compiled by
  // ONE `ajv.compile` on the root, with members merely `addSchema`'d — so under inlining the
  // codegen units are NOT one-per-document: leaf members merge upward into the root's function.
  //
  // THE PER-DOCUMENT BOUNDS DEPEND ON THAT NOT HAPPENING. `maxDocumentBytes` and `maxDepth` are
  // enforced per document, and they are worth something only if a document is what gets compiled.
  // Under inlining, N members each comfortably inside the per-document bounds become ONE generated
  // function that no per-document bound describes — the check keeps passing while the thing it
  // claims to bound stops existing. `maxClosureBytes` still caps the aggregate, so this is not a
  // hole; it is the difference between a bound that means what it says and one that happens to be
  // covered by a neighbour.
  //
  // It is also observably load-bearing rather than theoretically so: flipping it changes compile
  // cost and changes the outcome of a high-fanout closure that otherwise compiles. `false` costs a
  // function call per referenced schema at validation time and buys the structural guarantee that
  // each referenced schema is its own compiled unit. On a DoS boundary a deterministic structure is
  // worth more than inlining's marginal speed.
  inlineRefs: false,
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
/**
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
  // NOTHING HERE REFUSES A SCHEMA FOR BEING EXPENSIVE, and that is deliberate rather than
  // overlooked. The timing below is an OBSERVATION and refuses nothing; the node ceiling that was
  // briefly going to carry the refusal is gone, for the reasons recorded at `SCHEMA_PROFILE`.
  //
  // SO SAY PLAINLY WHAT IS ADMITTED NOW. A document of ~1000 patterned properties is ~90KB, depth
  // 2, ref-chain 0, every pattern inside `maxPatternChars` — it passes every remaining bound and
  // COMPILES, in a few hundred ms. It is admitted. The reason that is the right trade and not a
  // hole: reaching this function at all requires the authority to REGISTER a contract, the cost is
  // paid once at registration rather than per call, and the alternative on offer was a constant
  // whose two candidate bases were both falsified by measurement. An unfounded bound is not a
  // cheap safety margin — it refuses real contracts on a number nobody can defend, which is the
  // failure this profile already made once with a timer.
  //
  // AND THE CODEGEN OVERFLOW IS CAUGHT, not unguarded. A large patterned document can RangeError
  // inside Ajv's code generator; that throw lands in the catch below and is normalised to
  // `contract-invalid`, the same as any other schema that does not compile. It has been doing that
  // the whole time. The overflow is also not a stable edge to bound against — the same schema in
  // this same process has thrown cold and compiled on the immediate warm retry.
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
  // SPEC 2458 gives 100ms as a REFERENCE budget, not a normative constant, so reporting rather than
  // refusing on it needs no spec amendment. What §13.8 must be amended to say is that the profile
  // enforces its registration bounds structurally — bytes, depth, ref-chain, pattern length,
  // vocabulary — and treats the time budget as an observation, because no instrument available on
  // the supported Node floor measures the quantity the budget names.
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
      `Not a refusal, and no schema-size ceiling stands behind it: registration is bounded structurally ` +
      `(document/closure bytes, depth, ref-chain, pattern length, admitted vocabulary).`,
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
