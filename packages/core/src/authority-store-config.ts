import { EpEnvelopeError } from "./endpoint-envelope.js";

/** Native authority-store config fields used by the primary/no-eviction bind check.
 *  This is data, not a connection, a current-row proof or permission to change the store. */
export interface AuthorityStreamCfg {
  allow_direct?: boolean;
  retention?: string;
  max_age?: number;
  max_msgs?: number;
  max_bytes?: number;
  mirror?: unknown;
  sources?: unknown;
  subjects?: unknown;
  storage?: string;
}

export interface AuthorityStreamShapeIssue {
  fields: readonly string[];
  /** Native diagnostic text can contain supplied config values. Schema reports use fields only. */
  message: string;
}

/** Inspect an authority store's native bind invariants (SPEC 13.12): PRIMARY (never a
 *  mirror/sourced copy), LIMITS retention (an Interest/WorkQueue stream deletes a message once
 *  consumers have interest/ack it — an authority row would silently vanish after a barrier's
 *  point-in-time enumeration reads it), and NO silent-eviction limit — no age retention and no
 *  finite global message/byte cap (under DiscardOld a finite global limit evicts a PRIOR
 *  authority key's latest row the moment an unrelated key is written). A store that cannot be
 *  proved never serves. (A per-subject cap is NOT a vector: NATS keeps at least the latest value
 *  per subject for any cap ≥ 1, and 0/-1 mean unlimited, so no setting drops a key's own row.) */
export function authorityStreamShapeIssue(cfg: AuthorityStreamCfg, bucket: string): AuthorityStreamShapeIssue | undefined {
  if (cfg.mirror !== undefined || (Array.isArray(cfg.sources) && cfg.sources.length > 0))
    return { fields: ["mirror", "sources"], message: `the store ${bucket} is a mirror/sourced stream; a follower copy cannot serve authority reads or CAS (SPEC 13.12); bind the primary` };
  // A KV bucket is Limits-retention by construction, but the backing stream config is what
  // actually governs eviction, so prove it (a stream reprovisioned as Interest/WorkQueue under
  // the KV_ name would delete authority rows on consumer interest/ack — the barrier's throwaway
  // enumeration consumer would itself trigger the deletion).
  if (typeof cfg.retention === "string" && cfg.retention !== "limits")
    return { fields: ["retention"], message: `the store ${bucket} has ${cfg.retention} retention, not limits; a non-Limits stream deletes authority rows on consumer interest/ack (SPEC 13.12); reprovision as a KV bucket` };
  if (typeof cfg.max_age === "number" && cfg.max_age > 0)
    return { fields: ["max_age"], message: `the store ${bucket} carries bucket-wide age eviction (max_age ${cfg.max_age}); an age-evicted authority row silently drops a fence (SPEC 13.12); reprovision` };
  if (typeof cfg.max_msgs === "number" && cfg.max_msgs >= 0)
    return { fields: ["max_msgs"], message: `the store ${bucket} carries a finite global message cap (max_msgs ${cfg.max_msgs}); under discard-old it silently evicts never-deleted authority keys (SPEC 13.12); reprovision` };
  if (typeof cfg.max_bytes === "number" && cfg.max_bytes >= 0)
    return { fields: ["max_bytes"], message: `the store ${bucket} carries a finite global byte cap (max_bytes ${cfg.max_bytes}); under discard-old it silently evicts never-deleted authority keys (SPEC 13.12); reprovision` };
  // STORE-BINDING (SPEC 13.12): the stream must BE the claimed KV bucket, not merely wear its
  // name — exactly the one `$KV.<bucket>.>` subject (an extra captured subject would put foreign
  // bodies inside every body-selected MSG.GET grant on this stream, breaking the metadata-only
  // residual claim) and durable file storage (a memory authority store forgets every fence and
  // revocation on broker restart). Both are REQUIRED, not skipped-when-absent: every caller
  // proves a real `streams.info` config, and an absent field here is an unproved store.
  const expectedSubject = `$KV.${bucket}.>`;
  if (!Array.isArray(cfg.subjects) || cfg.subjects.length !== 1 || cfg.subjects[0] !== expectedSubject)
    return { fields: ["subjects"], message: `the store ${bucket} does not carry exactly the subject ${expectedSubject} (got ${JSON.stringify(cfg.subjects)}); a stream that captures anything else is not this KV bucket, and its body-selected reads are not bounded to authority metadata (SPEC 13.12); reprovision` };
  if (cfg.storage !== "file")
    return { fields: ["storage"], message: `the store ${bucket} has storage ${JSON.stringify(cfg.storage)}, not file; a non-durable authority store forgets fences and revocations on restart (SPEC 13.12); reprovision` };
  return undefined;
}

/** Enforce the same ordered native bind checks, retaining the existing error class and text.
 *  Structured field names for schema inspection confer no binding or mutation authority. */
export function assertAuthorityStreamShape(cfg: AuthorityStreamCfg, bucket: string): void {
  const issue = authorityStreamShapeIssue(cfg, bucket);
  if (issue) throw new EpEnvelopeError("failed-precondition", issue.message);
}
