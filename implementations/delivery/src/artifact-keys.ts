/**
 * The ONE module that builds keys of the three artifact index buckets (artifact plane 4.0; security S13).
 *
 * The request path holds a body-selected `STREAM.MSG.GET` on these buckets beside their value write, so
 * a key built from a raw caller string could read any row of any principal. Every key here is built from
 * validated inputs only: a digest that matches `sha256:<64 hex>`, a concrete channel that passes the
 * channel grammar, and a caller triple of owner, actor and lifecycle tokens. A census cell asserts no
 * other module spells an index key.
 *
 * Key families (plan section 4):
 *  - attachment, channel first: `<channel>.<digestToken>`, so `<channel>.*` lists exactly one channel;
 *  - the attachment digest index: `=d.<digestToken>.<channel>`; `=` cannot start a channel token, so
 *    the two families never collide and the list filter never matches an index row;
 *  - possession and reservation: `<digestToken>.<owner>.<actor>.<lifecycleUid>`.
 *
 * `digestToken` is the 64 lowercase hex digits of the sha256: one subject token, and the digest is
 * `sha256:<digestToken>`.
 */
import { assertLifecycleToken, assertValidChannel, isConcreteChannel, principalKey } from "@cotal-ai/core";

const DIGEST = /^sha256:([0-9a-f]{64})$/;
const TOKEN = /^[0-9a-f]{64}$/;

/** The key token of a validated digest. Throws on anything else. */
export function digestToken(digest: string): string {
  const m = DIGEST.exec(digest);
  if (!m) throw new Error(`"${digest}" is not a sha256 artifact digest`);
  return m[1];
}

/** The digest a key token names. Throws on anything but 64 lowercase hex digits. */
export function digestOfToken(token: string): string {
  if (!TOKEN.test(token)) throw new Error(`"${token}" is not a digest token`);
  return `sha256:${token}`;
}

/** A concrete channel, validated. */
export function concreteChannel(channel: string): string {
  assertValidChannel(channel);
  if (!isConcreteChannel(channel)) throw new Error(`"${channel}" is not a concrete channel`);
  return channel;
}

/** The attachment row of one digest in one channel. */
export function attachmentKey(channel: string, digest: string): string {
  return `${concreteChannel(channel)}.${digestToken(digest)}`;
}

/** The filter that lists exactly one channel's attachment rows: a row has one token more than its
 *  channel, so a deeper channel's rows never match. */
export function channelAttachmentsFilter(channel: string): string {
  return `${concreteChannel(channel)}.*`;
}

/** The digest of an attachment row key found under {@link channelAttachmentsFilter} for `channel`.
 *  Throws on a key that is not exactly one digest token below that channel. */
export function attachmentKeyDigest(channel: string, key: string): string {
  const prefix = `${concreteChannel(channel)}.`;
  if (!key.startsWith(prefix)) throw new Error(`attachment key ${key} is not under channel ${channel}`);
  return digestOfToken(key.slice(prefix.length));
}

/** The digest-index row of one digest in one channel. */
export function attachmentIndexKey(digest: string, channel: string): string {
  return `=d.${digestToken(digest)}.${concreteChannel(channel)}`;
}

/** A caller's possession or reservation row for one digest. */
export function principalDigestKey(digest: string, caller: { owner: string; actor: string; uid: string }): string {
  return `${digestToken(digest)}.${principalKey(caller.owner, caller.actor).key}.${assertLifecycleToken(caller.uid, "lifecycleUid")}`;
}
