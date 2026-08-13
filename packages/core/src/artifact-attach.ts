/**
 * `confirmAttach` — the publisher names its own already-published message, and the daemon verifies
 * it. This is the incarnation proof, and it is deliberately NOT a token.
 *
 * WHY NOT A TOKEN. Every carried-proof design lost to one constraint: a durable event plane records
 * agent tool calls AND their results, so a minted token is ordinary recorded state that a same-alias
 * successor can read. Prefer a construction whose leaked artifact is USELESS over one that depends
 * on the artifact not leaking. `confirmAttach`'s arguments are a POINTER, not a capability —
 * replaying `{digest, channel, seq}` as a successor fails the possession check, so there is nothing
 * in the system worth stealing.
 *
 * WHY `seq` AND NEVER `msgId`. JetStream offers no get-by-msgID: `MsgRequest` is `{seq}` or
 * `{last_by_subj}`. The dedupe cache is a write-side filter, not a read index. `seq` comes from the
 * publish `PubAck` (see `multicastWithAck`).
 *
 * THE FENCE IS THE POSSESSION CHECK, NOT THE SENDER CHECK. On the control rail `caller` is an
 * ALIAS, so a same-alias successor passes any `sender === caller` comparison trivially. What stops
 * it is that possession is resolved at the caller's LIVE lifecycle, and a successor never put the
 * bytes. Anyone tempted to delete the sender comparison as redundant should know it rejects a
 * DIFFERENT PRINCIPAL and is useless against succession — two different jobs, one line.
 */

/**
 * The refusal vocabulary, exact and stable.
 *
 * These ship as `ControlReply.error` STRINGS because that rail has no structured code field
 * (`ControlReply` is `{ ok, data?, error? }`). Frozen and exported so the daemon and its suite name
 * the same thing rather than agreeing by convention — a refusal matched by substring, or by a
 * literal retyped in a test, is a mapping nobody is checking.
 */
export const ATTACH_REFUSAL = {
  /** A1 — the `seq` names no entry in the chat stream. */
  entryNotFound: "confirmAttach: no such stream entry",
  /** A3 — the confirm's `channel` disagrees with the entry's SUBJECT channel (never `msg.channel`). */
  channelMismatch: "confirmAttach: the entry was not published to that channel",
  /** A4 — the entry carries no `artifact` part. */
  noArtifactPart: "confirmAttach: that entry carries no artifact reference",
  /** A5 — the part's digest is not the digest being confirmed. */
  digestMismatch: "confirmAttach: that entry references a different artifact",
  /**
   * A2 + A6, COLLAPSED DELIBERATELY.
   *
   * "that entry is not yours" and "you do not possess that digest" are ONE refusal, because a
   * caller who has proven nothing is not entitled to be told which stream entries exist, who wrote
   * them, or which digests are in the store. Distinguishing them rebuilds the existence oracle the
   * invisible-dedupe rule exists to close.
   *
   * The rule: **a refusal may distinguish states only when the caller has already proven
   * entitlement to the state being distinguished.** At fetch, the caller has passed the scope's
   * read two-gate, so a distinct `unknown digest` there is a scoped statement to someone entitled
   * to scoped statements. Here it would be a statement about the global store to someone entitled
   * to nothing.
   *
   * Timing must not distinguish them either: both paths perform the possession read.
   */
  notYours: "confirmAttach: not authorized for that artifact",
  /**
   * A7 — the alias resolves to two live ACL rows.
   *
   * ALLOWED to be distinct: an ambiguous alias is an infrastructure fault, not a fact about the
   * store, so naming it leaks nothing about what exists.
   */
  ambiguousAlias: "confirmAttach: AmbiguousAclAlias",
} as const;

export type AttachRefusal = (typeof ATTACH_REFUSAL)[keyof typeof ATTACH_REFUSAL];

/** Every refusal this verb may return — the closed set a suite checks against. */
export const ATTACH_REFUSALS: readonly string[] = Object.values(ATTACH_REFUSAL);

export interface ConfirmAttachArgs {
  digest: string;
  channel: string;
  /** From the publish `PubAck`. Never a message id — there is no get-by-msgID. */
  seq: number;
}

/** `{ ok, data?, error? }` — the shape this rail can express, and all it can express. */
export interface ConfirmAttachReply {
  ok: boolean;
  error?: string;
}

/**
 * Verify a publication and attach it. THE SINGLE ATTACHMENT WRITER.
 *
 * The attachment index must be unreachable except through here: the catch-up copy, both
 * `fanOutMessage` arms, the DLV reader, `readHistory`, an agent's own subscription, `pinArtifact`
 * and `putArtifactCommit` must never write a row. That property is what makes gating the expensive
 * checks on artifact-part presence a throughput win rather than a hole.
 *
 * Attach is idempotent AND lifetime-neutral: it adds the row if absent and does nothing else. It may
 * never extend a TTL, reset an expiry, refresh a refcount clock, or resurrect a swept digest —
 * otherwise any legitimate publisher becomes an unbounded-retention primitive without ever calling
 * `pin`.
 */
export function confirmAttach(_args: ConfirmAttachArgs): Promise<ConfirmAttachReply> {
  throw new Error("confirmAttach: not implemented");
}
