/**
 * The CONTRACT STORE (SPEC §13.7): content-addressed, public, immutable, permanent. One
 * artifact per digest-keyed subject `cotal.<space>.epc.<digest-hex>`, published as a SINGLE
 * message (bounded at 256 KiB; the §13.12 operator floor asserts `max_payload` covers it) —
 * deliberately NOT a chunked object store, whose chunk replay needs a consumer with a
 * body-selected delivery target (§13.9 forbids that shape). A closure is fetched
 * artifact-by-artifact through its digest references, never as one blob.
 *
 * Reads are the subject-scoped last-by-subject Direct Get on the exact digest subject — no
 * consumer, no replay machinery, nothing body-selected. READERS MUST VERIFY fetched bytes
 * against the digest and fail loud on mismatch: content addressing IS the tamper boundary
 * (the store is public; injection, not exposure, is the risk). Publication is mediated and
 * create-only (`Nats-Expected-Last-Subject-Sequence: 0`): a digest subject is written at most
 * once, and the digest is computed HERE from the exact bytes (never a caller claim).
 */
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders } from "@nats-io/transport-node";
import { createHash } from "node:crypto";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epcSubject } from "./endpoint-subjects.js";
import { epcStreamName } from "./endpoint-binding.js";

/** The §13.7 artifact bound: a document above it cannot ride one message and is refused. */
export const CONTRACT_ARTIFACT_MAX_BYTES = 256 * 1024;
/** The default closure bound: a walk that would exceed it fails loud, never truncates. */
export const CONTRACT_CLOSURE_MAX_ARTIFACTS = 64;

const HEX64 = /^[0-9a-f]{64}$/;

/** The artifact's subject token: SHA-256 hex over the EXACT raw bytes (§13.7: the `sha256:`
 *  prefix is not a subject token). */
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

/** Publish one artifact at its content address, create-only. The digest is computed FROM the
 *  bytes; a lost CAS fetches the recorded artifact and — because the subject IS the digest and
 *  the fetch verifies — the loss is an idempotent no-op ({won: false}). Oversize refuses. */
export async function publishContractArtifact(
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  bytes: Uint8Array,
): Promise<{ digestHex: string; won: boolean }> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0)
    throw new EpEnvelopeError("contract-invalid", "a contract artifact is non-empty raw bytes (SPEC 13.7)");
  if (bytes.length > CONTRACT_ARTIFACT_MAX_BYTES)
    throw new EpEnvelopeError("contract-invalid", `a contract artifact is bounded at ${CONTRACT_ARTIFACT_MAX_BYTES} bytes (got ${bytes.length}); a document above the bound cannot ride one message and is refused, never chunked (SPEC 13.7/13.12)`);
  const digestHex = contractArtifactDigestHex(bytes);
  const subject = epcSubject(space, digestHex);
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    await js.publish(subject, bytes, { headers: h });
    return { digestHex, won: true };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== 10071 && code !== 10164) throw e;
    // The subject is the digest: a prior write with this address holds these bytes (verified
    // on fetch). The loss is idempotent; an unreadable prior write is loud.
    const prior = await fetchContractArtifact(jsm, space, digestHex);
    if (prior === undefined)
      throw new EpEnvelopeError("internal", `the artifact CAS for ${subject} was lost but the recorded artifact is not readable (SPEC 13.4)`);
    return { digestHex, won: false };
  }
}

/** Fetch one artifact by digest (`undefined` = not published). VERIFY-ON-READ is unconditional:
 *  fetched bytes that do not recompute the digest fail loud — content addressing is the tamper
 *  boundary (§13.7). */
export async function fetchContractArtifact(
  jsm: JetStreamManager,
  space: string,
  digestHex: string,
): Promise<Uint8Array | undefined> {
  const subject = epcSubject(space, digestHex); // validates the token
  let stored;
  try {
    stored = await jsm.direct.getMessage(epcStreamName(space), { last_by_subj: subject });
  } catch (e) {
    if ((e as { code?: unknown })?.code === 10037) return undefined; // the ONLY "genuinely absent" result
    throw new EpEnvelopeError("unavailable", `the contract-store read for ${digestHex} failed (a failed observation is never absence, SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
  }
  if (stored === null) return undefined;
  if (contractArtifactDigestHex(stored.data) !== digestHex)
    throw new EpEnvelopeError("internal", `the artifact at ${subject} does not recompute its digest; verify-on-read is the tamper boundary and fails loud (SPEC 13.7)`);
  return stored.data;
}

/** Fetch a BOUNDED closure artifact-by-artifact through digest references (§13.7: never one
 *  blob). `extractRefs` is the resolution seam — given one artifact's verified bytes, it names
 *  the artifact digests that document references (schema by-digest `$ref`s, cluster
 *  `clusterDigests`); the walk validates and follows each, cycle-safe, and FAILS LOUD on a
 *  missing artifact (a closure is all-or-nothing) or on exceeding `maxArtifacts` (bounded
 *  resource use; a truncated closure never verifies as complete). Returns digest → bytes in
 *  first-visit order, root first. */
export async function fetchContractClosure(
  jsm: JetStreamManager,
  space: string,
  rootDigestHex: string,
  extractRefs: (bytes: Uint8Array, digestHex: string) => string[],
  opts: { maxArtifacts?: number } = {},
): Promise<Map<string, Uint8Array>> {
  const max = opts.maxArtifacts ?? CONTRACT_CLOSURE_MAX_ARTIFACTS;
  if (!Number.isSafeInteger(max) || max <= 0)
    throw new EpEnvelopeError("failed-precondition", `maxArtifacts must be a positive integer; got ${JSON.stringify(opts.maxArtifacts)}`);
  if (typeof extractRefs !== "function")
    throw new EpEnvelopeError("failed-precondition", "a closure fetch requires the reference-resolution seam (extractRefs); the store never guesses a document's reference shape (SPEC 13.7)");
  const out = new Map<string, Uint8Array>();
  const queue: string[] = [contractRefToHex(rootDigestHex)];
  while (queue.length > 0) {
    const hex = queue.shift()!;
    if (out.has(hex)) continue; // cycle/diamond-safe
    if (out.size >= max)
      throw new EpEnvelopeError("failed-precondition", `the contract closure exceeds the ${max}-artifact bound; a truncated closure never verifies as complete (SPEC 13.7)`);
    const bytes = await fetchContractArtifact(jsm, space, hex);
    if (bytes === undefined)
      throw new EpEnvelopeError("failed-precondition", `the closure references artifact ${hex} but it is not published; a closure is fetched all-or-nothing (SPEC 13.7)`);
    out.set(hex, bytes);
    const refs = extractRefs(bytes, hex);
    if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string"))
      throw new EpEnvelopeError("internal", `the reference-resolution seam returned a non-string-array for ${hex}; a garbled resolution never extends a closure (SPEC 13.7)`);
    for (const r of refs) queue.push(contractRefToHex(r));
  }
  return out;
}
