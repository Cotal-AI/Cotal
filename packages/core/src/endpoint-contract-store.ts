/**
 * The CONTRACT STORE (SPEC §13.7): content-addressed, public, immutable, permanent. One
 * artifact per digest-keyed subject `cotal.<space>.epc.<digest-hex>`, published as a SINGLE
 * message (bounded at 256 KiB; the §13.12 operator floor asserts `max_payload` covers it) —
 * deliberately NOT a chunked object store, whose chunk replay needs a consumer with a
 * body-selected delivery target (§13.9 forbids that shape). A closure is fetched
 * artifact-by-artifact through its digest references, never as one blob.
 *
 * CONTENT IDENTITY (§13.7 "Content addressing"): an artifact is its STRICT RFC 8785 CANONICAL
 * JSON — the digest is computed over the canonical bytes, publication REFUSES bytes that are
 * not already the canonical serialization of their own parse (a noncanonical encoding of an
 * equivalent value never gets its own identity; non-JSON bytes are never artifacts), and
 * verify-on-read re-proves BOTH the digest and the canonical form (a garbled store never
 * serves). TWO DIGESTS, NEVER CONFLATED: an ARTIFACT digest identifies one document's
 * canonical bytes; a CLOSURE digest identifies a whole resolved bundle and is the artifact
 * digest of that bundle's MANIFEST `{ v: 1, root, members }` — `members` being every artifact
 * transitively reachable THROUGH BY-DIGEST REFERENCES from `root` (the root itself is named by
 * its own field and appears in `members` only if a reference re-reaches it), sorted
 * lexicographically and deduplicated. The manifest is itself an ordinary artifact on its own
 * digest subject. Closure verification fetches the manifest BY the closure digest, walks the
 * references from `root`, and PROVES the walked set equals `members` EXACTLY — a manifest that
 * under- or over-names its closure never verifies.
 *
 * Reads are the subject-scoped last-by-subject Direct Get on the exact digest subject — no
 * consumer, no replay machinery, nothing body-selected. Publication is mediated and
 * create-only (`Nats-Expected-Last-Subject-Sequence: 0`): a digest subject is written at most
 * once, and the digest is computed HERE from the canonical bytes (never a caller claim). The
 * store seams run on a space-bonded BRANDED context (§13.4): JS + JSM derive from ONE
 * connection, so a lost publish CAS can never validate its "recorded artifact" through a
 * different broker. Every walk is BOUNDED by the frozen §13.7 registration bounds (closure
 * <= 1 MiB, ref chain <= 32, document <= 256 KiB, plus the artifact-count ceiling) and ONE
 * total monotonic time budget — the ceilings are non-raiseable (a caller may narrow, never
 * widen) and a truncated closure never verifies as complete.
 */
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders, type NatsConnection } from "@nats-io/transport-node";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epcSubject } from "./endpoint-subjects.js";
import { epcStreamName } from "./endpoint-binding.js";

/** The §13.7 artifact bound: a document above it cannot ride one message and is refused. */
export const CONTRACT_ARTIFACT_MAX_BYTES = 256 * 1024;
/** The §13.7 closure byte bound: the sum of every fetched artifact's canonical bytes. */
export const CONTRACT_CLOSURE_MAX_BYTES = 1024 * 1024;
/** The §13.7 reference-chain bound: the walk's depth from the root. */
export const CONTRACT_CLOSURE_MAX_REF_DEPTH = 32;
/** The artifact-count ceiling: a walk that would exceed it fails loud, never truncates. */
export const CONTRACT_CLOSURE_MAX_ARTIFACTS = 64;

const HEX64 = /^[0-9a-f]{64}$/;

/** A trusted, space-bonded contract-store context: JS + JSM DERIVE from one binding-layer
 *  connection and one space by the constructor (never injected independently), so a lost
 *  publish CAS can never validate its "recorded artifact" through a different broker than the
 *  one it published to. Every store seam takes this context. */
export interface ContractStoreContext {
  js: JetStreamClient;
  jsm: JetStreamManager;
  space: string;
}

/** Bond the resources to one space by CONSTRUCTION (frozen + branded, the shared context
 *  discipline): a hand-assembled structural look-alike is rejected at every seam. */
export async function contractStoreContext(nc: NatsConnection, space: string): Promise<ContractStoreContext> {
  if (nc === null || typeof nc !== "object" || typeof (nc as unknown as { close?: unknown }).close !== "function")
    throw new EpEnvelopeError("failed-precondition", "a contract-store context is constructed from ONE binding-layer connection; separate resources are never accepted (SPEC 13.4)");
  if (typeof space !== "string" || space.length === 0)
    throw new EpEnvelopeError("failed-precondition", "a contract-store context needs a space");
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const ctx = Object.freeze({ js, jsm, space });
  BRANDED_STORE_CONTEXTS.add(ctx);
  return ctx;
}

const BRANDED_STORE_CONTEXTS = new WeakSet<ContractStoreContext>();

function assertCtx(ctx: ContractStoreContext): void {
  if (!BRANDED_STORE_CONTEXTS.has(ctx))
    throw new EpEnvelopeError("failed-precondition", `the contract-store context was not constructed by contractStoreContext(); a hand-assembled resource bundle never authorizes - the space bond is constructed, not asserted (SPEC 13.4)`);
}

/** The artifact's subject token: SHA-256 hex over the artifact's CANONICAL bytes (§13.7: the
 *  `sha256:` prefix is not a subject token). The bytes handed here MUST already be canonical —
 *  publication and verify-on-read enforce that ({@link assertCanonicalArtifactBytes}). */
export function contractArtifactDigestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Normalize a digest reference (`<hex>` or `sha256:<hex>`) to the bare subject token; a
 *  malformed reference fails loud (a garbled ref never fetches an unintended subject). */
export function contractRefToHex(ref: string): string {
  const hex = ref.startsWith("sha256:") ? ref.slice("sha256:".length) : ref;
  if (!HEX64.test(hex))
    throw new EpEnvelopeError("contract-invalid", `contract reference ${JSON.stringify(ref)} is not a sha256 digest; a garbled reference never resolves (SPEC 13.7)`);
  return hex;
}

/** A value's canonical artifact bytes (strict RFC 8785 over I-JSON): what publication stores
 *  and what the digest identifies. Non-interchangeable values refuse. */
export function contractArtifactCanonicalBytes(value: unknown): Uint8Array {
  try { return new TextEncoder().encode(canonicalJson(value)); }
  catch (e) { throw new EpEnvelopeError("contract-invalid", `the value is not interchangeable JSON (${(e as Error).message}); only strict I-JSON is a contract artifact (SPEC 13.7)`); }
}

/** Prove presented bytes ARE their own parse's strict RFC 8785 canonical serialization and
 *  return the parsed value (§13.7 content identity): invalid UTF-8, non-JSON, and every
 *  noncanonical encoding (reordered keys, whitespace, duplicate keys, noncanonical numbers)
 *  refuse — an equivalent value in a different encoding never gets its own identity, so two
 *  implementations can never disagree on an artifact's digest. */
export function assertCanonicalArtifactBytes(bytes: Uint8Array, what: string): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new EpEnvelopeError("contract-invalid", `${what} is not valid UTF-8; only strict canonical JSON is a contract artifact (SPEC 13.7)`); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (e) { throw new EpEnvelopeError("contract-invalid", `${what} does not parse as JSON (${(e as Error).message}); only strict canonical JSON is a contract artifact (SPEC 13.7)`); }
  let canonical: string;
  try { canonical = canonicalJson(value); }
  catch (e) { throw new EpEnvelopeError("contract-invalid", `${what} is not interchangeable I-JSON (${(e as Error).message}); only strict canonical JSON is a contract artifact (SPEC 13.7)`); }
  if (canonical !== text)
    throw new EpEnvelopeError("contract-invalid", `${what} is not its own RFC 8785 canonical serialization; a noncanonical encoding never gets its own content identity (SPEC 13.7)`);
  return value;
}

/** Publish one artifact at its content address, create-only. The bytes are DETACHED at entry
 *  (a caller mutating the buffer across the publish await changes nothing), PROVEN canonical
 *  ({@link assertCanonicalArtifactBytes}), and the digest is computed FROM that snapshot; a
 *  lost CAS fetches the recorded artifact and — because the subject IS the digest and the
 *  fetch verifies — the loss is an idempotent no-op ({won: false}). Oversize refuses. */
export async function publishContractArtifact(
  ctx: ContractStoreContext,
  bytes: Uint8Array,
): Promise<{ digestHex: string; won: boolean }> {
  assertCtx(ctx);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0)
    throw new EpEnvelopeError("contract-invalid", "a contract artifact is non-empty canonical JSON bytes (SPEC 13.7)");
  if (bytes.length > CONTRACT_ARTIFACT_MAX_BYTES)
    throw new EpEnvelopeError("contract-invalid", `a contract artifact is bounded at ${CONTRACT_ARTIFACT_MAX_BYTES} bytes (got ${bytes.length}); a document above the bound cannot ride one message and is refused, never chunked (SPEC 13.7/13.12)`);
  const snapshot = new Uint8Array(bytes); // detached at entry (a real copy — Buffer.slice would ALIAS): validated, digested, and published as ONE value
  assertCanonicalArtifactBytes(snapshot, "the artifact");
  const digestHex = contractArtifactDigestHex(snapshot);
  const subject = epcSubject(ctx.space, digestHex);
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    await ctx.js.publish(subject, snapshot, { headers: h });
    return { digestHex, won: true };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== 10071 && code !== 10164) throw e;
    // The subject is the digest: a prior write with this address holds these bytes (verified
    // on fetch). The loss is idempotent; an unreadable prior write is loud.
    const prior = await fetchContractArtifact(ctx, digestHex);
    if (prior === undefined)
      throw new EpEnvelopeError("internal", `the artifact CAS for ${subject} was lost but the recorded artifact is not readable (SPEC 13.4)`);
    return { digestHex, won: false };
  }
}

/** Fetch one artifact by digest (`undefined` = not published). VERIFY-ON-READ is unconditional
 *  and TWO-PROOF: the fetched bytes must recompute the digest AND be strict canonical JSON —
 *  content addressing is the tamper boundary and a garbled store never serves (§13.7). */
export async function fetchContractArtifact(
  ctx: ContractStoreContext,
  digestHex: string,
): Promise<Uint8Array | undefined> {
  assertCtx(ctx);
  const subject = epcSubject(ctx.space, digestHex); // validates the token
  let stored;
  try {
    stored = await ctx.jsm.direct.getMessage(epcStreamName(ctx.space), { last_by_subj: subject });
  } catch (e) {
    if ((e as { code?: unknown })?.code === 10037) return undefined; // the ONLY "genuinely absent" result
    throw new EpEnvelopeError("unavailable", `the contract-store read for ${digestHex} failed (a failed observation is never absence, SPEC 13.7): ${(e as Error)?.message ?? String(e)}`);
  }
  if (stored === null) return undefined;
  if (contractArtifactDigestHex(stored.data) !== digestHex)
    throw new EpEnvelopeError("internal", `the artifact at ${subject} does not recompute its digest; verify-on-read is the tamper boundary and fails loud (SPEC 13.7)`);
  try { assertCanonicalArtifactBytes(stored.data, `the artifact at ${subject}`); }
  catch { throw new EpEnvelopeError("internal", `the artifact at ${subject} is not strict canonical JSON; a garbled store never serves (SPEC 13.7)`); }
  return stored.data;
}

// ---- the closure manifest (§13.7 "Two digests, never conflated") ------------------------------

/** The §13.7 closure MANIFEST artifact: contract identity is THIS artifact's digest (the
 *  closure digest), never the root document digest alone. Digest fields carry the one scalar
 *  shape `sha256:<hex>`. */
export interface ContractClosureManifest {
  v: 1;
  root: string;
  /** Every artifact transitively reachable through by-digest references from `root` (the root
   *  appears only if a reference re-reaches it), sorted lexicographically, deduplicated. */
  members: string[];
}

const sha256Ref = (hex: string): string => `sha256:${hex}`;

/** Build the canonical manifest for a walked closure: refs normalize, members sort + dedup.
 *  The ROOT is named by its own field and belongs in `members` only when a reference
 *  re-reaches it (the §13.7 "reachable THROUGH references" rule, pinned here so two
 *  implementations always mint the identical manifest). */
export function buildContractClosureManifest(rootRef: string, memberRefs: readonly string[]): ContractClosureManifest {
  const root = sha256Ref(contractRefToHex(rootRef));
  const members = [...new Set(memberRefs.map((r) => sha256Ref(contractRefToHex(r))))].sort();
  return { v: 1, root, members };
}

function parseClosureManifest(value: unknown, what: string): ContractClosureManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new EpEnvelopeError("contract-invalid", `${what} is not a manifest object (SPEC 13.7)`);
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!["v", "root", "members"].includes(k))
      throw new EpEnvelopeError("contract-invalid", `${what} carries the unknown field "${k}"; the manifest schema is closed (SPEC 13.7)`);
  if (o.v !== 1 || typeof o.root !== "string" || !Array.isArray(o.members))
    throw new EpEnvelopeError("contract-invalid", `${what} is not { v: 1, root, members } (SPEC 13.7)`);
  contractRefToHex(o.root);
  if (o.members.length > CONTRACT_CLOSURE_MAX_ARTIFACTS)
    throw new EpEnvelopeError("contract-invalid", `${what} names ${o.members.length} members, above the ${CONTRACT_CLOSURE_MAX_ARTIFACTS}-artifact ceiling (SPEC 13.7)`);
  for (let i = 0; i < o.members.length; i++) {
    const m = o.members[i];
    if (typeof m !== "string") throw new EpEnvelopeError("contract-invalid", `${what} member ${i} is not a string (SPEC 13.7)`);
    contractRefToHex(m);
    // The canonical form IS sorted + deduplicated: an unsorted or duplicated members list is a
    // DIFFERENT byte sequence claiming the same closure — refused, never silently normalized.
    if (i > 0 && (o.members[i - 1] as string) >= m)
      throw new EpEnvelopeError("contract-invalid", `${what} members are not strictly sorted/deduplicated at index ${i}; a noncanonical manifest never names a closure (SPEC 13.7)`);
  }
  return { v: 1, root: o.root, members: o.members as string[] };
}

/** Publish a closure's manifest as an ordinary canonical artifact; the returned digest IS the
 *  closure digest (§13.7). */
export async function publishContractClosureManifest(
  ctx: ContractStoreContext,
  manifest: ContractClosureManifest,
): Promise<{ closureDigestHex: string; won: boolean }> {
  assertCtx(ctx);
  const value = parseClosureManifest(manifest, "the manifest");
  const res = await publishContractArtifact(ctx, contractArtifactCanonicalBytes(value));
  return { closureDigestHex: res.digestHex, won: res.won };
}

/** Fetch and VERIFY a closure by its CLOSURE digest (§13.7): fetch the manifest artifact at
 *  that digest (its identity is proven by the fetch), then walk the by-digest references from
 *  `root` through the `extractRefs` resolution seam and PROVE the walked set equals
 *  `manifest.members` exactly — an under-naming manifest (the walk reaches an unlisted
 *  artifact) and an over-naming one (a listed member is never reached) both refuse; a missing
 *  artifact anywhere is all-or-nothing loud. The walk is BOUNDED: the frozen closure byte
 *  bound, the reference-chain depth, the artifact-count ceiling (non-raiseable; a caller may
 *  narrow), a per-artifact reference cap, and ONE total monotonic time budget. `extractRefs`
 *  receives a DETACHED copy of each artifact's bytes (a mutating seam cannot poison the
 *  returned map) and its answer is size-capped. Returns digest → bytes (manifest excluded;
 *  root first, then first-visit order) plus the parsed manifest. */
export async function fetchContractClosure(
  ctx: ContractStoreContext,
  closureDigestRef: string,
  extractRefs: (bytes: Uint8Array, digestHex: string) => string[],
  opts: { maxArtifacts?: number; walkBudgetMs?: number } = {},
): Promise<{ manifest: ContractClosureManifest; artifacts: Map<string, Uint8Array> }> {
  assertCtx(ctx);
  const max = opts.maxArtifacts ?? CONTRACT_CLOSURE_MAX_ARTIFACTS;
  if (!Number.isSafeInteger(max) || max <= 0 || max > CONTRACT_CLOSURE_MAX_ARTIFACTS)
    throw new EpEnvelopeError("failed-precondition", `maxArtifacts must be a positive integer at or below the frozen ${CONTRACT_CLOSURE_MAX_ARTIFACTS}-artifact ceiling (a caller narrows, never widens); got ${JSON.stringify(opts.maxArtifacts)} (SPEC 13.7)`);
  const budgetMs = opts.walkBudgetMs ?? 30_000;
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0)
    throw new EpEnvelopeError("failed-precondition", `walkBudgetMs must be a positive integer; got ${JSON.stringify(opts.walkBudgetMs)}`);
  if (typeof extractRefs !== "function")
    throw new EpEnvelopeError("failed-precondition", "a closure fetch requires the reference-resolution seam (extractRefs); the store never guesses a document's reference shape (SPEC 13.7)");
  const startedAt = performance.now();
  const overBudget = (): boolean => performance.now() - startedAt > budgetMs;

  const closureHex = contractRefToHex(closureDigestRef);
  const manifestBytes = await fetchContractArtifact(ctx, closureHex);
  if (manifestBytes === undefined)
    throw new EpEnvelopeError("failed-precondition", `the closure manifest ${closureHex} is not published; a closure digest names its manifest artifact (SPEC 13.7)`);
  const manifest = parseClosureManifest(assertCanonicalArtifactBytes(manifestBytes, `the manifest ${closureHex}`), `the manifest ${closureHex}`);

  const rootHex = contractRefToHex(manifest.root);
  const out = new Map<string, Uint8Array>();
  let totalBytes = 0;
  let rootReReached = false; // a reference naming the root makes it reference-reachable (a member)
  // BFS with depth tracking: the queue carries (hex, depth); depth is the reference-chain
  // length from the root (§13.7 ref chain <= 32).
  const queue: Array<{ hex: string; depth: number }> = [{ hex: rootHex, depth: 0 }];
  while (queue.length > 0) {
    if (overBudget())
      throw new EpEnvelopeError("deadline-exceeded", `the closure walk for ${closureHex} exceeded its ${budgetMs}ms budget; a closure fetch is bounded and fails loud, never hangs (SPEC 13.7/13.8)`);
    const { hex, depth } = queue.shift()!;
    if (out.has(hex)) continue; // cycle/diamond-safe
    if (depth > CONTRACT_CLOSURE_MAX_REF_DEPTH)
      throw new EpEnvelopeError("contract-invalid", `the closure walk for ${closureHex} exceeds the ${CONTRACT_CLOSURE_MAX_REF_DEPTH}-deep reference chain bound (SPEC 13.7)`);
    if (out.size >= max)
      throw new EpEnvelopeError("failed-precondition", `the contract closure exceeds the ${max}-artifact bound; a truncated closure never verifies as complete (SPEC 13.7)`);
    const bytes = await fetchContractArtifact(ctx, hex);
    if (bytes === undefined)
      throw new EpEnvelopeError("failed-precondition", `the closure references artifact ${hex} but it is not published; a closure is fetched all-or-nothing (SPEC 13.7)`);
    totalBytes += bytes.length;
    if (totalBytes > CONTRACT_CLOSURE_MAX_BYTES)
      throw new EpEnvelopeError("contract-invalid", `the closure for ${closureHex} exceeds the ${CONTRACT_CLOSURE_MAX_BYTES}-byte bound (SPEC 13.7)`);
    out.set(hex, bytes);
    const refs = extractRefs(new Uint8Array(bytes), hex); // DETACHED copy (a real copy — Buffer.slice would ALIAS the stored bytes): a mutating seam cannot poison the returned map
    if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string"))
      throw new EpEnvelopeError("internal", `the reference-resolution seam returned a non-string-array for ${hex}; a garbled resolution never extends a closure (SPEC 13.7)`);
    if (refs.length > CONTRACT_CLOSURE_MAX_ARTIFACTS)
      throw new EpEnvelopeError("contract-invalid", `artifact ${hex} names ${refs.length} references, above the ${CONTRACT_CLOSURE_MAX_ARTIFACTS}-reference cap; an unbounded reference list never extends a closure (SPEC 13.7)`);
    for (const r of refs) {
      const rHex = contractRefToHex(r);
      if (rHex === rootHex) rootReReached = true; // a cycle back makes the root a member too
      queue.push({ hex: rHex, depth: depth + 1 });
    }
  }

  // The walked reachable-THROUGH-references set must equal the manifest's members EXACTLY
  // (§13.7): the root belongs iff a reference re-reached it — tracked during the walk, so
  // exactly ONE manifest (one closure digest) names any given closure, never two.
  const walked = new Set<string>();
  for (const hex of out.keys()) if (hex !== rootHex || rootReReached) walked.add(sha256Ref(hex));
  const memberSet = new Set(manifest.members);
  for (const m of walked)
    if (!memberSet.has(m))
      throw new EpEnvelopeError("contract-invalid", `the closure walk reached ${m} but the manifest ${closureHex} does not name it; an under-naming manifest never verifies (SPEC 13.7)`);
  for (const m of memberSet)
    if (!walked.has(m))
      throw new EpEnvelopeError("contract-invalid", `the manifest ${closureHex} names ${m} but the walk never reached it; an over-naming manifest never verifies (SPEC 13.7)`);
  return { manifest, artifacts: out };
}
