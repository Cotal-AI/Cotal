/**
 * The artifact index keys: possession rows and attachment rows.
 *
 * TWO PROPERTIES HOLD THE WHOLE `confirmAttach` DESIGN UP, AND NEITHER IS VISIBLE FROM A SUCCESSFUL
 * ATTACH. Both are the "check that cannot fail" shape, so they get adversarial cells rather than
 * happy-path coverage:
 *
 *   1. POSSESSION LOOKUP IS LIFECYCLE-EXACT. On the control rail the caller is an ALIAS, so a
 *      same-alias successor passes any sender comparison trivially. The only thing standing between
 *      a successor and its predecessor's attach is that possession is keyed to the LIFECYCLE and the
 *      successor never put the bytes. An alias-scan lookup — "any row for this principal" — would
 *      satisfy every happy-path test and hand a successor its predecessor's possession.
 *
 *   2. POSSESSION ROWS OUTLIVE RETIREMENT. A delayed message must still attach after its publisher
 *      retires, so these rows are NOT reaped with the lifecycle. They live in their own bucket, so
 *      an ACL/membership teardown cannot take them; they die with the digest at GC. A row reaped at
 *      retirement re-fires the exact branch this design exists to close — a legitimate publication
 *      that silently never attaches — with no adversary involved.
 *
 * The key grammar mirrors `memberKey` (`subjects.ts`) deliberately: a single `/` separating a
 * `/`-free scope from a lifecycle-scoped principal, so both halves recover unambiguously and the
 * shape a reader already knows means the same thing here.
 */
import { assertLifecycleToken, parsePrincipalKey, token } from "./subjects.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * KV-safe form of a `sha256:<hex>` digest.
 *
 * `:` is not a legal KV key character (`/^[-/=.\w]+$/`), so the prefix is rewritten rather than
 * dropped: keeping the algorithm visible means a future digest algorithm cannot silently collide
 * with an existing key that happens to share its hex.
 */
export function digestKeyToken(digest: string): string {
  if (!DIGEST.test(digest))
    throw new Error(`artifact index: expected a "sha256:<64 hex>" digest, got ${JSON.stringify(digest)}`);
  return digest.replace(":", "_");
}

/** Bucket holding possession rows for a space. Its OWN bucket — see property 2 above. */
export function possessionBucket(space: string): string {
  return `cotal_artpossess_${token(space)}`;
}

/** Bucket holding attachment rows for a space. */
export function attachmentBucket(space: string): string {
  return `cotal_artattach_${token(space)}`;
}

/**
 * One possession row: `<digest>/<principal>.<lifecycleUid>`.
 *
 * LIFECYCLE-KEYED, and that is the fence. A same-alias successor produces a DIFFERENT key, so an
 * exact-key read for its lifecycle misses — which is the whole reason a successor cannot attach its
 * predecessor's bytes.
 */
export function possessionKey(digest: string, principal: string, lifecycleUid: string): string {
  return `${digestKeyToken(digest)}/${principal}.${assertLifecycleToken(lifecycleUid)}`;
}

/** Inverse of {@link possessionKey}, or null if the key is not one. */
export function parsePossessionKey(
  key: string,
): { digestToken: string; principal: string; lifecycleUid: string } | null {
  const i = key.indexOf("/");
  if (i <= 0 || i >= key.length - 1) return null;
  const digestToken = key.slice(0, i);
  const tail = key.slice(i + 1);
  const dot = tail.lastIndexOf(".");
  if (dot <= 0 || dot >= tail.length - 1) return null;
  const principal = tail.slice(0, dot);
  const uid = tail.slice(dot + 1);
  if (parsePrincipalKey(principal) === null) return null;
  try { assertLifecycleToken(uid); } catch { return null; }
  return { digestToken, principal, lifecycleUid: uid };
}

/**
 * One attachment row: `<digest>/<channel>`.
 *
 * NOT lifecycle-keyed, and deliberately so — an attachment is a property of the CHANNEL, not of
 * whoever created it. Who created it is recorded IN the row (`attacherLifecycleUid`) so `pin` can
 * check it later without an alias scan, but reach is scoped by the channel.
 */
export function attachmentKey(digest: string, channel: string): string {
  return `${digestKeyToken(digest)}/${channel}`;
}

/** What an attachment row holds. */
export interface AttachmentRow {
  /**
   * The lifecycle that confirmed this attachment — NEVER the bare alias.
   *
   * `pin` authorizes against this. Matching on the alias would let a same-alias successor pin bytes
   * it never possessed, which is unbounded storage granted to a principal with no claim on it,
   * and it is why possession rows outliving retirement must not become a live capability.
   */
  attacherLifecycleUid: string;
  /** When the attachment was created. Never refreshed: attach is lifetime-neutral. */
  createdAt: number;
}

/**
 * Read one possession row, EXACT KEY.
 *
 * There is deliberately no alias-level variant. A caller holding only an alias resolves its LIVE
 * lifecycle first (via `aclForAlias`, inheriting `AmbiguousAclAlias`) and then reads here — so
 * "which lifecycle" is answered by the ACL registry, which refuses ambiguity, rather than by a scan
 * over possession that would silently pick one.
 */
export async function readPossession(
  kv: { get(key: string): Promise<{ operation?: string } | null> },
  digest: string,
  principal: string,
  lifecycleUid: string,
): Promise<boolean> {
  const e = await kv.get(possessionKey(digest, principal, lifecycleUid));
  // `e !== null` IS NOT PRESENCE, and an earlier version of this function got that wrong.
  //
  // MEASURED against nats-server via @nats-io/kv: `get()` on a DELETED key returns an entry with
  // `operation: "DEL"` and `length: 0` — it does NOT return null. So a null-check treats a deleted
  // row as present, and a possession revoked or reaped would keep authorizing attaches forever.
  //
  // The defect survived its own suite because the KV double returned `null` for absent keys and had
  // no concept of a tombstone: the fake was more forgiving than the thing it stood for, so the check
  // looked right against it and was wrong against a broker.
  //
  // Only a PUT is presence. DEL and PURGE are absence wearing an object.
  return e !== null && e.operation === "PUT";
}
