/**
 * The chat session's PARENT PIN. A chat session is bound to the exact
 * parent interactive row `actors/<owner>.cli.json` and the exact revision of its lifecycle head
 * `lifecycle.<owner>.cli`, as both stood at admission:
 *
 *   parentPin = { actor: "cli", lifecycleUid, headRevision, rowDigest }
 *
 * - `headRevision` is the head key's STORE revision on a LEADER-SERVED read (`STREAM.MSG.GET`,
 *   never a follower Direct Get). Any head movement (re-grant, revoke, takeover epoch advance)
 *   moves it, so every later check refuses.
 * - `rowDigest` is SHA-256 over the RFC 8785 canonical JSON of the row's authority fields
 *   `{owner, actor, scope, allowSubscribe, allowPublish, role?, lifecycleUid}`. It is defense in
 *   depth against an out-of-band file edit, which only this digest bounds.
 *
 * Every check here is a READ. A read is never a fence: the residual is that the parent head and the
 * child gate are separate keys with no cross-key CAS. Callers re-check after
 * signing and before any byte leaves.
 */
import { createHash } from "node:crypto";
import type { JetStreamManager } from "@nats-io/jetstream";
import {
  EpEnvelopeError,
  canonicalJson,
  lifecycleHeadKey,
  parseLifecycleHead,
  patternInAllow,
  readRecordLeader,
  type LifecycleMapping,
} from "@cotal-ai/core";
import { findInteractiveActor, type ActorRow } from "./ledger.js";
import { parseChatParentPin, type ChatParentPin } from "./chat-session-row.js";

/** The parent interactive actor every chat session hangs off (the signed-in human's own row). */
export const CHAT_PARENT_ACTOR = "cli";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** `rowDigest`: the normative field list and canonicalization. `role` is included only when
 *  present (RFC 8785 cannot carry `undefined`); `label`, `parent` and `grantedAt` are excluded. */
export function chatParentRowDigest(row: Pick<ActorRow, "owner" | "actor" | "scope" | "allowSubscribe" | "allowPublish" | "role" | "lifecycleUid">): string {
  if (typeof row.lifecycleUid !== "string" || row.lifecycleUid === "")
    throw new EpEnvelopeError("permission-denied", `the parent row "${row.owner}.${row.actor}" carries no lifecycleUid; re-grant it before opening a chat session`);
  return sha256Hex(canonicalJson({
    owner: row.owner,
    actor: row.actor,
    scope: row.scope,
    allowSubscribe: row.allowSubscribe,
    allowPublish: row.allowPublish,
    ...(row.role !== undefined ? { role: row.role } : {}),
    lifecycleUid: row.lifecycleUid,
  }));
}

/** The holder index's `parentPinDigest`: SHA-256 over the canonical pin. */
export function chatParentPinDigest(pin: ChatParentPin): string {
  return sha256Hex(canonicalJson(parseChatParentPin(pin, "parentPin")));
}

/** Read the parent row, fail-closed. Absent refuses (there is no session without its parent). */
export function readChatParentRow(dir: string, owner: string): ActorRow {
  const row = findInteractiveActor(dir, owner, CHAT_PARENT_ACTOR);
  if (!row)
    throw new EpEnvelopeError("permission-denied", `no interactive "${CHAT_PARENT_ACTOR}" grant for owner ${owner}; a chat session is admitted only under the signed-in human's own row`);
  return row;
}

/** LEADER-SERVED read of the parent head (`STREAM.MSG.GET last_by_subj`, the connect reader's
 *  discipline). A DEL/PURGE marker refuses inside `readRecordLeader`. */
export async function readChatParentHeadLeader(
  jsm: JetStreamManager,
  space: string,
  owner: string,
): Promise<{ mapping: LifecycleMapping; revision: number } | undefined> {
  const key = lifecycleHeadKey(owner, CHAT_PARENT_ACTOR);
  let entry: { value: unknown; revision: number } | undefined;
  try {
    entry = await readRecordLeader(jsm, space, key);
  } catch (e) {
    if (e instanceof EpEnvelopeError) throw e;
    throw new EpEnvelopeError("unavailable", `the leader-served parent head read for ${key} failed; an authority read fails closed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (entry === undefined) return undefined;
  return { mapping: parseLifecycleHead(new TextEncoder().encode(JSON.stringify(entry.value)), key, owner, CHAT_PARENT_ACTOR), revision: entry.revision };
}

/** Build the pin from a freshly read row and head (admission precondition 3): the head must be
 *  `active` at the row's UID. */
export function buildChatParentPin(row: ActorRow, head: { mapping: LifecycleMapping; revision: number } | undefined): ChatParentPin {
  if (row.actor !== CHAT_PARENT_ACTOR) throw new EpEnvelopeError("internal", `a chat parent is the "${CHAT_PARENT_ACTOR}" row`);
  if (head === undefined)
    throw new EpEnvelopeError("failed-precondition", `the parent lifecycle head for "${row.owner}/${CHAT_PARENT_ACTOR}" is absent; ensure it through the parent's own root-credential path first`);
  if (head.mapping.state !== "active" || head.mapping.lifecycleUid !== row.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", `the parent lifecycle head for "${row.owner}/${CHAT_PARENT_ACTOR}" is ${head.mapping.state} at ${head.mapping.lifecycleUid}, not active at the row's ${String(row.lifecycleUid)}`);
  return { actor: CHAT_PARENT_ACTOR, lifecycleUid: head.mapping.lifecycleUid, headRevision: head.revision, rowDigest: chatParentRowDigest(row) };
}

/** Containment: every requested entry is contained in the parent's CURRENT
 *  list. Nothing is added: no `>` the user did not name, no default. */
export function assertChatListsContained(row: Pick<ActorRow, "allowSubscribe" | "allowPublish">, lists: { read: string[]; post: string[] }): void {
  const overRead = lists.read.filter((ch) => !patternInAllow(row.allowSubscribe, ch));
  const overPost = lists.post.filter((ch) => !patternInAllow(row.allowPublish, ch));
  if (overRead.length || overPost.length)
    throw new EpEnvelopeError("permission-denied", `the chat session would exceed the parent grant: ${[
      overRead.length ? `read [${overRead.join(", ")}]` : "",
      overPost.length ? `post [${overPost.join(", ")}]` : "",
    ].filter(Boolean).join("; ")}`);
}

/**
 * The pin CHECK, used at the admission re-check (a5), exchange pre- and post-sign and the connect check before and after signing. Refuses unless the CURRENT row and the
 * CURRENT leader-read head equal the pin exactly, and the session lists are still contained.
 */
export function assertChatParentPinCurrent(
  pin: ChatParentPin,
  row: ActorRow | undefined,
  head: { mapping: LifecycleMapping; revision: number } | undefined,
  lists: { read: string[]; post: string[] },
): void {
  const deny = (why: string): never => {
    throw new EpEnvelopeError("permission-denied", `the chat session's parent moved (${why}); this session has ended - open a new one`);
  };
  if (row === undefined) deny("the parent row is gone");
  if (row!.lifecycleUid !== pin.lifecycleUid) deny("the parent row was re-granted");
  if (head === undefined) deny("the parent head is absent");
  if (head!.mapping.state !== "active") deny(`the parent head is ${head!.mapping.state}`);
  if (head!.mapping.lifecycleUid !== pin.lifecycleUid) deny("the parent head names another incarnation");
  if (head!.revision !== pin.headRevision) deny(`the parent head revision is ${head!.revision}, pinned ${pin.headRevision}`);
  if (chatParentRowDigest(row!) !== pin.rowDigest) deny("the parent row's authority fields changed");
  assertChatListsContained(row!, lists);
}
