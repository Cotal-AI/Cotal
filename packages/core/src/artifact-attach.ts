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

import { parseSubject } from "./subjects.js";
import { AmbiguousAclAlias } from "./acls.js";
import { isArtifactPart } from "./artifact.js";
import type { CotalMessage } from "./types.js";
import type { AttachmentRow } from "./artifact-index.js";

/**
 * The refusal vocabulary, exact and stable.
 *
 * These ship as `ControlReply.error` STRINGS because that rail has no structured code field
 * (`ControlReply` is `{ ok, data?, error? }`). Frozen and exported so the daemon and its suite name
 * the same thing rather than agreeing by convention — a refusal matched by substring, or by a
 * literal retyped in a test, is a mapping nobody is checking.
 *
 * `Object.freeze`, not merely `as const`. `as const` is a TYPE-level claim that vanishes at runtime,
 * so an `as const` refusal table is an ordinary mutable object any imported module can rewrite — and
 * a refusal vocabulary is exactly the kind of live-read security collection that class covers. This
 * shipped unfrozen and `smoke:frozen-exports` caught it; the guard is the enforcement, this is the
 * fix.
 */
export const ATTACH_REFUSAL = Object.freeze({
  /** A3 — the confirm's `channel` disagrees with the entry's SUBJECT channel (never `msg.channel`). */
  channelMismatch: "confirmAttach: the entry was not published to that channel",
  /** A4 — the entry carries no `artifact` part. */
  noArtifactPart: "confirmAttach: that entry carries no artifact reference",
  /** A5 — the part's digest is not the digest being confirmed. */
  digestMismatch: "confirmAttach: that entry references a different artifact",
  /**
   * A1 + A2 + A6, COLLAPSED DELIBERATELY — everything a caller can ask before proving it owns the
   * entry.
   *
   * "no such stream entry", "that entry is not yours" and "you do not possess that digest" are ONE
   * refusal, because a caller who has proven nothing is not entitled to be told which stream
   * entries exist, who wrote them, or which digests are in the store.
   *
   * The rule: **a refusal may distinguish states only when the caller has already proven
   * entitlement to the state being distinguished.** At fetch, the caller has passed the scope's
   * read two-gate, so a distinct `unknown digest` there is a scoped statement to someone entitled
   * to scoped statements. Here it would be a statement about the global store to someone entitled
   * to nothing.
   *
   * `entryNotFound` USED TO BE A DISTINCT NAME AND IS GONE, and the reason is worth keeping. Under
   * the superseded observe-attach design every check ran inside `fanOutMessage`, on a daemon AUDIT
   * surface with no caller — seven distinct names leak nothing to nobody. §4.2.2 moved them onto
   * `ControlReply.error` and gave every one an audience; the names were carried across unchanged.
   * A separate "no such stream entry" let any delivery-ctl principal probe the chat stream's head
   * position with no read ACL on any channel. The table said one thing, the entitlement rule above
   * said another, and only the rule had been reviewed.
   *
   * THE ACCEPTED COST, stated so nobody rediscovers it as a bug: a LEGITIMATE caller whose entry
   * was purged or aged out now gets `notYours` rather than "no such entry", which is misleading.
   * That is priced deliberately — if the entry does not exist you cannot determine ownership, so
   * you cannot safely distinguish, and the collapse is the only answer available rather than a
   * policy preference.
   *
   * Timing must not distinguish these either — see the note at the sender check.
   */
  notYours: "confirmAttach: not authorized for that artifact",
  /**
   * A7 — the alias resolves to two live ACL rows.
   *
   * ALLOWED to be distinct: an ambiguous alias is an infrastructure fault, not a fact about the
   * store, so naming it leaks nothing about what exists.
   */
  ambiguousAlias: "confirmAttach: AmbiguousAclAlias",
} as const);

export type AttachRefusal = (typeof ATTACH_REFUSAL)[keyof typeof ATTACH_REFUSAL];

/** Every refusal this verb may return — the closed set a suite checks against. */
export const ATTACH_REFUSALS: readonly string[] = Object.freeze(Object.values(ATTACH_REFUSAL));

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
export interface ConfirmAttachDeps {
  /** Load the stream entry named by `seq`, or null. `seq` — there is no get-by-msgID. */
  entryBySeq(seq: number): Promise<{ subject: string; msg: CotalMessage } | null>;
  /** The caller's single LIVE lifecycle, or a throw carrying `AmbiguousAclAlias` on two live rows. */
  liveLifecycleFor(caller: string): Promise<string>;
  /** Exact-key possession read. No alias variant exists — see artifact-index.ts. */
  hasPossession(digest: string, principal: string, lifecycleUid: string): Promise<boolean>;
  /**
   * INSERT-IF-ABSENT. Not an upsert, and the distinction is the whole lifetime-neutrality
   * invariant rather than a storage preference.
   *
   * `confirmAttach` hands a fresh `createdAt` on EVERY call, including a repeat confirm of an entry
   * already attached — it has no way to know whether the row exists without a read it deliberately
   * does not perform. So if this implementation upserts, a second confirm REWRITES `createdAt`, and
   * anything in §7 that ages a row from that timestamp has just had its clock refreshed. That is
   * precisely the "any legitimate publisher becomes an unbounded-retention primitive without ever
   * calling `pin`" failure, arriving through the storage layer rather than through the verb.
   *
   * The invariant therefore does not live in `confirmAttach` at all: this verb is lifetime-neutral
   * only if this dependency is insert-if-absent. Stated here because a contract that lives in one
   * function's comment while being enforced in another's implementation is a contract nobody checks.
   * S5 owes the cell: confirm twice, assert `createdAt` is unchanged.
   */
  putAttachment(digest: string, channel: string, row: AttachmentRow): Promise<void>;
  now(): number;
}

export async function confirmAttach(
  args: ConfirmAttachArgs,
  caller: string,
  deps: ConfirmAttachDeps,
): Promise<ConfirmAttachReply> {
  const entry = await deps.entryBySeq(args.seq);
  const parsed = entry === null ? null : parseSubject(entry.subject);

  // ---------------------------------------------------------------------------------------------
  // THE COLLAPSE, AND IT IS FIRST FOR A REASON. Every distinction a caller could draw BEFORE
  // proving it published this entry is one name.
  //
  // These checks used to run separately and each returned its own name, which was correct while
  // they were daemon audit events with no caller. On `ControlReply.error` they have an audience,
  // and a foreign caller could walk seqs to find which exist, enumerate channels, learn whether an
  // entry carried an artifact, and confirm a digest it merely suspected — all on ANOTHER
  // principal's entries, with no read ACL on the channel involved.
  //
  // `parsed.sender !== caller` rejects a DIFFERENT PRINCIPAL. It is useless against SUCCESSION —
  // the subject carries an alias with no lifecycle, so a same-alias successor passes it trivially —
  // and it is not the fence. The fence is the possession read below. Two different jobs, and if you
  // are here to delete one as redundant, they are not.
  // ---------------------------------------------------------------------------------------------
  if (entry === null || parsed === null || parsed.kind !== "chat" || parsed.sender !== caller)
    return { ok: false, error: ATTACH_REFUSAL.notYours };

  // PAST THIS LINE the caller has proven it published this entry, so it is entitled to precise
  // statements ABOUT ITS OWN ENTRY — which is what makes the fine-grained names below legitimate
  // rather than an oracle. They exist so that deleting any one check reddens its own cell.

  // THE SUBJECT's channel, never `msg.channel`. The broker forge-locked the subject; the payload is
  // whatever the publisher wrote. Comparing the argument against the payload would let the CALLER
  // decide the scope, which is the caller-declared scope §4.1 refuses.
  //
  // THIS COMMENT WAS TRUE AND UNTESTED. Every fixture set the subject channel and `msg.channel` to
  // the same value, so swapping `parsed.rest` for `entry.msg.channel` survived all eleven cells:
  // the distinction the comment explains at length was invisible to the suite documenting it. There
  // is now a fixture where the two DISAGREE.
  if (parsed.rest !== args.channel)
    return { ok: false, error: ATTACH_REFUSAL.channelMismatch };

  const part = entry.msg.parts?.find(isArtifactPart);
  if (part === undefined) return { ok: false, error: ATTACH_REFUSAL.noArtifactPart };
  if (part.digest !== args.digest) return { ok: false, error: ATTACH_REFUSAL.digestMismatch };

  let lifecycleUid: string;
  try {
    lifecycleUid = await deps.liveLifecycleFor(caller);
  } catch (e) {
    // NARROW, and it used to be bare. A bare `catch` here mapped EVERY throw to `AmbiguousAclAlias`:
    // a dropped connection, a missing bucket, a malformed key all came back as "your alias resolves
    // to two live rows". Fail-closed, so not a privilege defect — but an operator reading it would
    // chase an ACL problem while the broker was down, and mapping every failure to one meaning is
    // the same defect as swallowing every `create` error as "already exists".
    //
    // The suite could not see it either: A7 threw `new Error("AmbiguousAclAlias")`, whose `name` is
    // "Error", so a cell asserting the refusal passed against a mapping that was wrong for every
    // other input. The cell now throws the real class, which is what makes this line testable.
    if (e instanceof AmbiguousAclAlias) return { ok: false, error: ATTACH_REFUSAL.ambiguousAlias };
    // Anything else is an infrastructure fault this verb cannot name honestly. Rethrow rather than
    // inventing a refusal: a caller seeing a transport error knows to retry, and a caller told
    // "AmbiguousAclAlias" does not.
    throw e;
  }

  // ---------------------------------------------------------------------------------------------
  // THE FENCE. Not the sender comparison above — this line.
  //
  // `parsed.sender` is an ALIAS — `<owner>.<actor>`, with no lifecycle anywhere in the CHAT subject
  // grammar — so a same-alias successor passes it TRIVIALLY. What stops a successor attaching bytes
  // its predecessor put is that possession is resolved at the caller's LIVE lifecycle, and the
  // successor never put them.
  //
  // ON TIMING. A previous comment here claimed both refusal paths perform the possession read, and
  // that was false: the foreign path short-circuits at the sender check and performs ZERO. With the
  // collapse moved to the front that is now the DESIGN rather than a defect — a foreign caller is
  // refused before any possession lookup, so there is no possession-read count to compare. The only
  // callers reaching this line are owners of the entry, and they all do exactly one read.
  // ---------------------------------------------------------------------------------------------
  if (!(await deps.hasPossession(args.digest, caller, lifecycleUid)))
    return { ok: false, error: ATTACH_REFUSAL.notYours };

  // Idempotent and lifetime-neutral: adds the row if absent and does nothing else. It may never
  // extend a TTL, reset an expiry, refresh a refcount clock or resurrect a swept digest — otherwise
  // any legitimate publisher becomes an unbounded-retention primitive without ever calling `pin`.
  // The row records the LIFECYCLE that confirmed it, never the alias, so `pin` cannot later be
  // satisfied by a successor.
  await deps.putAttachment(args.digest, args.channel, {
    attacherLifecycleUid: lifecycleUid,
    createdAt: deps.now(),
  });
  return { ok: true };
}
