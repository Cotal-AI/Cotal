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
import { canonicalJson, isContractDigest } from "./canonical.js";

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
} as const;

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

/** Collect every `$ref` string in a schema document (structural walk; `$ref` in 2020-12 is
 *  always a string-valued keyword wherever it appears). */
function collectRefs(v: unknown, out: string[] = []): string[] {
  if (v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    for (const c of v) collectRefs(c, out);
    return out;
  }
  for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
    if ((k === "$ref" || k === "$dynamicRef") && typeof c === "string") out.push(c);
    collectRefs(c, out);
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
  const canonical = canonicalJson(doc); // also enforces I-JSON
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > SCHEMA_PROFILE.maxDocumentBytes)
    throw new ContractInvalidError(`${label}: document is ${bytes} bytes (profile max ${SCHEMA_PROFILE.maxDocumentBytes})`);
  if (structuralDepth(doc) > SCHEMA_PROFILE.maxDepth)
    throw new ContractInvalidError(`${label}: nesting exceeds profile depth ${SCHEMA_PROFILE.maxDepth}`);
  const storeRefs: string[] = [];
  for (const ref of collectRefs(doc)) {
    if (ref.startsWith("#")) continue; // local pointer/anchor — resolved within the document
    const m = STORE_REF.exec(ref);
    if (!m) throw new ContractInvalidError(`${label}: external $ref ${JSON.stringify(ref)} — only local '#…' or digest-pinned 'cotal:sha256:<hex>' references are permitted (no ambient resolution)`);
    storeRefs.push(m[1]);
  }
  return storeRefs;
}

/** Validate the whole closure against the profile and compile it with a real 2020-12
 *  validator. No network, no filesystem: `loadSchema` is never installed, and every
 *  `cotal:` reference must be present in `bundle.members`. */
export function compileContractSchema(bundle: SchemaBundle): ValidateFunction {
  const started = Date.now();
  const members = bundle.members ?? {};
  for (const d of Object.keys(members)) {
    if (!isContractDigest(d)) throw new ContractInvalidError(`bundle member key ${JSON.stringify(d)} is not a sha256 digest`);
  }

  // Walk the closure breadth-first, bounding chain depth and total size.
  let closureBytes = Buffer.byteLength(canonicalJson(bundle.root), "utf8");
  const seen = new Set<string>();
  let frontier = assertDocumentProfile(bundle.root, "root schema");
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
      closureBytes += Buffer.byteLength(canonicalJson(member), "utf8");
      if (closureBytes > SCHEMA_PROFILE.maxClosureBytes)
        throw new ContractInvalidError(`closure is ${closureBytes} bytes (profile max ${SCHEMA_PROFILE.maxClosureBytes})`);
      next.push(...assertDocumentProfile(member, `member ${digest}`));
    }
    frontier = next;
  }

  // Compile with deterministic local resolution only. Members register under their cotal: URI
  // so in-document `$ref: "cotal:sha256:…"` resolves from the bundle, never the network.
  const ajv = new Ajv2020({
    strict: false, // the wire accepts full 2020-12, not ajv's strict-mode dialect subset
    allErrors: false,
    validateFormats: false,
    loadSchema: undefined,
  });
  for (const [digest, member] of Object.entries(members)) ajv.addSchema(member as object, `cotal:${digest}`);
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(bundle.root as object);
  } catch (e) {
    throw new ContractInvalidError(`schema does not compile under the 2020-12 profile: ${(e as Error).message}`);
  }
  const elapsed = Date.now() - started;
  if (elapsed > SCHEMA_PROFILE.compileBudgetMs)
    throw new ContractInvalidError(`compile took ${elapsed}ms (profile budget ${SCHEMA_PROFILE.compileBudgetMs}ms)`);
  return validate;
}
