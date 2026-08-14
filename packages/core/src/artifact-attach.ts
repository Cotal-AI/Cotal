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
import {
  readPossession,
  putAttachmentIfAbsent,
  deleteAttachment,
  type AttachmentKv,
  type AttachmentRow,
} from "./artifact-index.js";

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
  /**
   * THE ONLY REFUSAL THIS VERB HAS, apart from the ambiguous-alias fault below. Every state a
   * caller can reach here collapses into it.
   *
   * IT USED TO BE FOUR NAMES. `channelMismatch`, `noArtifactPart` and `digestMismatch` were kept
   * distinct on the ground that the sender compare had proven the caller published the entry. It
   * had not: that compare reads an ALIAS out of a chat subject that carries no lifecycle, so a
   * same-alias SUCCESSOR passed it and could then read a retired predecessor's channel,
   * artifact-bearing and digest off the refusal names alone. The three names are gone and the
   * reasoning is at the collapse site.
   *
   * So: "no such stream entry", "that entry is not yours", "not published to that channel",
   * "carries no artifact reference", "references a different artifact" and "you do not possess that
   * digest" are ONE refusal, because a caller who has proven nothing is not entitled to be told
   * which stream entries exist, who wrote them, what they carry, or which digests are in the store.
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
   *
   * IT RETURNS WHETHER IT INSERTED, and that boolean is load-bearing rather than informational.
   * The fence below can be overtaken: possession reads true, a sweep then removes the possession
   * and attachment rows, and this write lands afterwards and RECREATES the attachment — resurrecting
   * a swept digest, which the write's own comment promises it may never do. Undoing that requires
   * knowing whether this call created the row or found one already there, because rolling back a row
   * we did not write would delete a live attachment belonging to someone else's confirm.
   */
  putAttachment(digest: string, channel: string, row: AttachmentRow): Promise<boolean>;
  /**
   * Remove an attachment row. Called on ONE path only: rolling back an insert that lost the race
   * against a sweep. It is not a verb and there is deliberately no caller-reachable route to it.
   */
  dropAttachment(digest: string, channel: string): Promise<void>;
  now(): number;
}

/**
 * Bind the two index buckets into the three dependencies that TOUCH them, so no other module has to
 * name a mutator to serve this verb.
 *
 * WHY THIS FUNCTION EXISTS, AND IT IS NOT TIDINESS. The single-writer sweep asserts the attachment
 * index is unreachable except through this file, and it enforces that STRUCTURALLY, by name, over
 * the whole corpus — `endpoint.ts` is the FIRST entry on its `MUST_NOT_WRITE` list, because that is
 * where fan-out, the catch-up copy, the DLV reader and `readHistory` live, and where a real second
 * writer would most plausibly appear.
 *
 * Wiring the control rail put the dependency closure in `endpoint.ts`, which made that file name
 * `putAttachmentIfAbsent` and `deleteAttachment` and turned the sweep red. The write was still only
 * reachable THROUGH `confirmAttach`, so the invariant held semantically — which is exactly what made
 * "widen the sweep to allow `endpoint.ts`" the tempting fix, and exactly why it was refused. That
 * would have blinded the guard on the one file it most needs to watch, to accommodate a caller that
 * could simply be moved instead. THE CODE MOVED; THE GUARD DID NOT.
 *
 * The rail still supplies `entryBySeq` and `liveLifecycleFor` — those are the daemon's own seams (the
 * chat stream and the trusted ACL registry) and belong to it. Only the index touch lives here.
 */
export function artifactIndexDeps(
  stores: {
    possession: Parameters<typeof readPossession>[0];
    attachments: AttachmentKv;
  },
  rail: Pick<ConfirmAttachDeps, "entryBySeq" | "liveLifecycleFor"> & { now?: () => number },
): ConfirmAttachDeps {
  return {
    entryBySeq: rail.entryBySeq,
    liveLifecycleFor: rail.liveLifecycleFor,
    hasPossession: (digest, principal, lifecycleUid) =>
      readPossession(stores.possession, digest, principal, lifecycleUid),
    putAttachment: (digest, channel, row) => putAttachmentIfAbsent(stores.attachments, digest, channel, row),
    dropAttachment: (digest, channel) => deleteAttachment(stores.attachments, digest, channel),
    now: rail.now ?? (() => Date.now()),
  };
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

  // WHAT THAT LINE DOES NOT ESTABLISH — and an earlier version of this file claimed it did.
  //
  // It said: "PAST THIS LINE the caller has proven it published this entry, so it is entitled to
  // precise statements ABOUT ITS OWN ENTRY." That is refuted by the comment eight lines above it.
  // The sender compare is an ALIAS compare and a same-alias successor passes it trivially, so it
  // proves nothing about publication. This file wrote down the exact reason the gate does not work
  // and then built an entitlement on that gate. A comment naming a limitation is not a mitigation
  // for it.
  //
  // So the fine-grained names are GONE. Without this collapse a respawned agent learns, about a
  // retired predecessor's entry it holds no read ACL for: which channel it was published to,
  // whether it carried an artifact at all, and whether a suspected digest matches — §5.1's
  // existence oracle arriving through refusal names instead of through a response field.
  //
  // WHY A RE-ORDERED FENCE DOES NOT RESCUE THE NAMES. Running the possession read above these
  // checks was considered and does not work: possession is content-addressed and GLOBAL, so a
  // successor may hold the very digest its predecessor published — having put those bytes itself —
  // and would then still be told the predecessor's channel. Possession proves who holds bytes,
  // never who published an entry. And "I published this entry" is not provable AT ALL from a chat
  // subject that carries no lifecycle. The entitlement §5.1 requires cannot be established here, so
  // these states may not be distinguished. One name.
  //
  // THE SUBJECT's channel, never `msg.channel`: the broker forge-locked the subject, the payload is
  // whatever the publisher wrote, and comparing against the payload would let the CALLER decide the
  // scope — the caller-declared scope §4.1 refuses. The collapse does not weaken that: the fixture
  // where the two DISAGREE still refuses here and its matched pair still succeeds, so swapping
  // `parsed.rest` for `entry.msg.channel` flips both.
  if (parsed.rest !== args.channel) return { ok: false, error: ATTACH_REFUSAL.notYours };

  // ANY artifact part carrying this digest — not the FIRST artifact part. `Part[]` carries no
  // one-artifact restriction, so `find(isArtifactPart)` meant a two-artifact message could never
  // confirm its second attachment: that digest was compared against its sibling's and refused.
  if (!entry.msg.parts?.some((p) => isArtifactPart(p) && p.digest === args.digest))
    return { ok: false, error: ATTACH_REFUSAL.notYours };

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
  // refused before any possession lookup, so there is no possession-read count to compare. Every
  // caller reaching this line is an owner of the entry, and the count differs only between OWNERS —
  // one read when this refuses, two when the write is confirmed below — which distinguishes nothing
  // a successful confirm has not already told the same caller outright.
  // ---------------------------------------------------------------------------------------------
  if (!(await deps.hasPossession(args.digest, caller, lifecycleUid)))
    return { ok: false, error: ATTACH_REFUSAL.notYours };

  // Idempotent and lifetime-neutral: adds the row if absent and does nothing else. It may never
  // extend a TTL, reset an expiry, refresh a refcount clock or resurrect a swept digest — otherwise
  // any legitimate publisher becomes an unbounded-retention primitive without ever calling `pin`.
  // The row records the LIFECYCLE that confirmed it, never the alias, so `pin` cannot later be
  // satisfied by a successor.
  const inserted = await deps.putAttachment(args.digest, args.channel, {
    attacherLifecycleUid: lifecycleUid,
    createdAt: deps.now(),
  });

  // ---------------------------------------------------------------------------------------------
  // THE FENCE CAN BE OVERTAKEN, AND FOR ONE REVISION THE COMMENT ABOVE WAS A PROMISE THE CODE COULD
  // NOT KEEP. Between the possession read and this write, a sweep can remove BOTH the possession row
  // and the attachment row; the write then lands and recreates the attachment — resurrecting exactly
  // the swept digest the line above says it may never resurrect. Reproduced on real KV, no adversary
  // and no unusual timing required, because the two steps are separate round trips to the broker.
  //
  // So the write is confirmed against the state it was authorized by. Re-reading possession AFTER
  // the write is what makes the ordering safe: a sweep that ran at any point before this read is
  // seen here, and one that runs after it removes both rows itself and leaves nothing behind.
  //
  // ONLY AN INSERT IS ROLLED BACK. If the row was already there, this call resurrected nothing —
  // some earlier confirm wrote it and the sweep will collect it on its own terms. Deleting it would
  // turn a lost race into the destruction of a live attachment, which is a worse outcome than the
  // one being fixed.
  //
  // WHAT THIS DOES NOT CLAIM. The row is briefly visible to a concurrent reader before the rollback,
  // and closing that needs a compare-and-delete the KV surface does not offer against a key another
  // writer may have replaced. What is guaranteed is the TERMINAL state: no attachment row survives
  // this call for a digest whose possession was swept before the write was confirmed.
  // ---------------------------------------------------------------------------------------------
  if (inserted && !(await deps.hasPossession(args.digest, caller, lifecycleUid))) {
    await deps.dropAttachment(args.digest, args.channel);
    return { ok: false, error: ATTACH_REFUSAL.notYours };
  }
  return { ok: true };
}
