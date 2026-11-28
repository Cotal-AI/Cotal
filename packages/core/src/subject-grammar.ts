const ILLEGAL = /[^A-Za-z0-9_-]/g;

/** Make a string safe to use as a single NATS subject token. */
export function token(s: string): string {
  const t = s.trim().replace(ILLEGAL, "_");
  return t.length > 0 ? t : "_";
}

export const ROOT = "cotal";

export function spacePrefix(space: string): string {
  return `${ROOT}.${token(space)}`;
}

/** The key of the data part that marks a delivery daemon's notice that a channel post mentioned an
 *  agent who may not read the channel (SPEC §8). */
export const MENTION_NOTICE_KEY = "cotalMentionNotice";

/** Canonicalize a `mentions` list for the wire: trim, lowercase, drop empties, dedupe.
 *  Returns `undefined` for an empty result so the field is omitted rather than sent as `[]`.
 *  Presence-agnostic (no roster lookup) — validation lives in the connector. */
export function normalizeMentions(mentions?: string[]): string[] | undefined {
  if (!mentions?.length) return undefined;
  const out = [...new Set(mentions.map((m) => m.trim().toLowerCase()).filter((m) => m.length > 0))];
  return out.length ? out : undefined;
}

/** The `@name` mentions inside a message body, as bare names, for a multicast's `mentions` (a
 *  priority/wake hint). Every surface that posts typed text derives them the same way. A trailing
 *  `.` or `-` is punctuation, as in `thanks @ops-lead.`, since a chat name cannot end in one. An `@`
 *  right after an ASCII letter or digit, `_`, `.`, `-` or `/` starts no mention, so an address such
 *  as `ana@example.com` or a path such as `/@rover` names no one, and neither does `Done.@rover`.
 *  Any other character may precede one, so `你好@rover` mentions `rover` in a script written
 *  without spaces. */
export function mentionsIn(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z0-9_.\/-])@([A-Za-z0-9_.-]*[A-Za-z0-9_])/g)].map((m) => m[1]);
}

/**
 * Build the channel portion of a chat subject, preserving NATS hierarchy: split on
 * `.`, sanitize each segment to a safe token, but keep whole-segment wildcards
 * (`*` = one level, `>` = the rest). So `team.backend` → `team.backend` (a
 * sub-channel) and `team.>` → `team.>` (its whole subtree). `>` is only legal as
 * the final segment; empty segments are dropped.
 */
function channelPath(channel: string): string {
  const segs = channel.split(".").map((s) => s.trim()).filter((s) => s.length > 0);
  if (segs.length === 0) return "_";
  return segs
    .map((s, i) => {
      if (s === ">") {
        if (i !== segs.length - 1)
          throw new Error(`channel "${channel}": '>' is only valid as the last segment`);
        return ">";
      }
      return s === "*" ? "*" : token(s);
    })
    .join(".");
}

/** Validate a **role**: the anycast address a holder registers and a sender names. It must be one
 *  NATS-safe token (`[A-Za-z0-9_-]`) and FAILS LOUD rather than sanitizing: a rewrite would route
 *  distinct spellings to one queue while the envelope kept the spelling the sender typed. Returns the
 *  role unchanged when valid so callers can use it inline. */
export function assertValidRole(role: string): string {
  // typeof guard as in assertValidOwnerToken: RegExp.test() coerces, so 123 or ["probe"] would pass.
  if (typeof role !== "string" || !/^[A-Za-z0-9_-]+$/.test(role))
    throw new Error(
      `invalid role "${role}": must be a single NATS-safe token ([A-Za-z0-9_-]) - a role is an ` +
        `address, so it is rejected rather than silently rewritten`,
    );
  return role;
}

/** A route token in a *service/role* slot (`svc.<role>`, `ctl.<service>`, `live.<plane>`): the literal
 *  `*` wildcard passes through for subscribe/allow rules like `svc.*.…`, and every concrete value is
 *  {@link assertValidRole}-validated. A publish must also refuse `*`, so its caller validates the role
 *  itself. */
export function routeToken(s: string): string {
  return s === "*" ? "*" : assertValidRole(s);
}

/** An owner/actor identity token in a wire subject: the literal `*` wildcard passes through (for
 *  allow/subscribe rules like `chat.*.*.<ch>`), and every concrete value is {@link assertValidOwnerToken}-
 *  validated (fail loud — a `.`/`*`/`>`/`-` in an id is lane breakout, NEVER silently rewritten the way
 *  `token()` would). The owner+actor grammar's per-subject enforcement point. */
export function ownerToken(s: string): string {
  return s === "*" ? "*" : assertValidOwnerToken(s);
}

/** The chat plane prefix, optionally narrowed to a sender pattern, with a trailing dot. */
export function chatSubjectPrefix(space: string, sender?: { owner: string; actor: string }): string {
  const plane = `${spacePrefix(space)}.chat.`;
  return sender === undefined ? plane : `${plane}${ownerToken(sender.owner)}.${ownerToken(sender.actor)}.`;
}

/** Multicast: `chat.<owner>.<actor>.<channel…>` — the publishing principal (owner+actor) precedes the
 *  channel (owner+actor grammar, Shape A). Either identity slot may be `*` for subscribe/allow rules
 *  (`chat.*.*.<ch>` = read a channel from any principal). */
export function chatSubject(space: string, owner: string, actor: string, channel: string): string {
  return `${chatSubjectPrefix(space, { owner, actor })}${channelPath(channel)}`;
}

/** True if a channel names a concrete sub-channel (no `*`/`>`) — i.e. it can be
 *  *published* to. Subscriptions may be wildcard; publishes must be concrete. */
export function isConcreteChannel(channel: string): boolean {
  return !channel.split(".").some((s) => s.trim() === "*" || s.trim() === ">");
}

/** True if `channel` is a channel FAMILY: one or more NATS-safe segments and then a final `>`
 *  (`review.>`, `team.backend.>`). A family is the one pattern that can hold a durable membership; the
 *  root `>` and any pattern with `*` stay live only. It covers every channel under its segments, not
 *  the bare prefix (`review.>` covers `review.a` and `review.a.b`, not `review`). */
export function isChannelFamily(channel: string): boolean {
  const segs = channel.split(".");
  return channel.length <= MAX_CHANNEL_LENGTH && segs.length >= 2 && segs[segs.length - 1] === ">" &&
    segs.slice(0, -1).every((s) => /^[A-Za-z0-9_-]+$/.test(s));
}

/** The families that cover concrete `channel`, nearest last: `a.>` and `a.b.>` for `a.b.c`. */
export function familiesCovering(channel: string): string[] {
  const segs = channel.split(".");
  return segs.slice(1).map((_, i) => `${segs.slice(0, i + 1).join(".")}.>`);
}

/** Does NATS subject `pattern` (with `*`/`>`) match `subject`? Also reused for channel-level
 *  matching ("is a member on `team.>` a member of `team.backend`?") — channels are dotted
 *  token strings, same rules. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return i < s.length; // '>' matches one-or-more remaining tokens — NATS semantics: 'a.>' does NOT match bare 'a'
    if (i >= s.length) return false;
    if (p[i] === "*") continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/** Validate a channel name/pattern used as **policy** (an agent file's `subscribe`/`allowSubscribe`/
 *  `allowPublish` entry, a CLI flag, or a join target). Each dotted segment must be a NATS-safe
 *  token (exactly what {@link token} leaves unchanged: `[A-Za-z0-9_-]`), or `*` (one level), or `>`
 *  (final segment only). Rejects — fail-loud — anything {@link token} would silently rewrite.
 *
 *  This closes an ACL-aliasing gap: containment is validated against the RAW policy string
 *  (`channelInAllow`), but the minted wire grant is built through `token()` (`chatSubject`). Without
 *  this, `allowSubscribe:[foo/bar]` would validate as the channel `foo/bar` yet mint a read grant for
 *  the wire subject `chat.*.foo_bar` — letting the agent read `#foo_bar`, a channel the operator
 *  never named (and two distinct policy strings could collide on one token). Returns the channel
 *  unchanged when valid so callers can use it inline. */
export function assertValidChannel(channel: string): string {
  if (channel.length > MAX_CHANNEL_LENGTH)
    throw new Error(
      `invalid channel "${channel.slice(0, 32)}…": ${channel.length} characters exceeds the ` +
        `${MAX_CHANNEL_LENGTH}-character limit (every grant line a channel mints rides the CONNECT line)`,
    );
  const segs = channel.split(".");
  if (!channel.length || segs.some((s) => s.length === 0))
    throw new Error(`invalid channel "${channel}": empty segment (no leading/trailing/double dots)`);
  segs.forEach((s, i) => {
    if (s === ">") {
      if (i !== segs.length - 1) throw new Error(`invalid channel "${channel}": '>' is only valid as the last segment`);
      return;
    }
    if (s === "*") return;
    // The wildcard segments are named only to a segment that holds one, so a refusal never offers
    // `*` or `>` to a name that did not try a wildcard.
    if (!/^[A-Za-z0-9_-]+$/.test(s))
      throw new Error(
        `invalid channel "${channel}": segment "${s}" must be a NATS-safe token ([A-Za-z0-9_-])${/[*>]/.test(s) ? ", '*', or '>'" : ""} - ` +
          `policy channel names can't contain characters the wire layer would rewrite`,
      );
  });
  return channel;
}

/** Maximum length of a policy channel, in UTF-16 code units (whole string, dots included).
 *
 *  Derived from the transport budget, not picked. A channel becomes at least one grant row in
 *  every list it appears on (a `chatSubject`-shaped row per allowSubscribe/allowPublish
 *  entry, plus the per-channel JetStream history-consumer create row on the subscribe side),
 *  and those rows ride the user JWT inside the client's CONNECT line, which the broker caps at
 *  `max_control_line` (`MAX_CONTROL_LINE_BYTES`, provision.ts). Measured on this repo (decoded
 *  JWT, not the encoded credential): a channel on `allowSubscribe` alone contributes 2 grant
 *  rows and ~11.1 KB per 4096 characters; the same channel on BOTH `allowSubscribe` and
 *  `allowPublish` contributes a 3rd row and ~16.6 KB. This bound refuses the absurd single input
 *  early with a message that names it - it is NOT what keeps a real credential under the cap.
 *  The COMPOSITION is bounded at the mint (`MAX_MINTED_JWT_BYTES`, provision.ts): a caller may
 *  legally list many channels each under this bound, and only the mint-time byte check on the
 *  assembled JWT catches that (issue #375's review finding).
 *  The bound is on the whole string; a single segment cannot exceed the whole, so the per-segment
 *  charset rule needs no separate length arm.
 */
export const MAX_CHANNEL_LENGTH = 4096;

/** Validate an **owner or actor token** of the owner+actor grammar. STRICTER than
 *  {@link assertValidChannel}: a token is exactly ONE NATS-safe segment — `[A-Za-z0-9_]+`, with NO
 *  dots, NO `*`, NO `>`, and NO `-`. Dots/wildcards in an id are lane breakout or aliasing (they would
 *  let one owner's grant span, or collide with, another's); `-` is excluded because it is reserved as
 *  the sole separator of {@link principalKey}'s JetStream-name form — a `-` *inside* a token would
 *  make `<owner>-<actor>` ambiguous. The ASCII-only alphabet also makes NFC-normalization trivially
 *  hold (any non-ASCII input fails). FAILS LOUD rather than sanitizing — do NOT substitute
 *  {@link token} here: it silently rewrites illegal characters, and a rewrite hides an
 *  aliasing attempt. Returns the token unchanged when valid so callers can use it inline. */
export function assertValidOwnerToken(owner: string): string {
  // typeof guard is load-bearing at JS/JSON boundaries: RegExp.test() coerces its argument, so
  // without it a number like 123 stringifies, matches, and is returned UN-coerced.
  if (typeof owner !== "string" || !/^[A-Za-z0-9_]+$/.test(owner))
    throw new Error(
      `invalid owner/actor token "${owner}": must be a single NATS-safe token ([A-Za-z0-9_]) - ` +
        `no dots, '*', '>', or '-'. A separator or wildcard in an id is lane breakout or aliasing, ` +
        `and '-' is reserved as the principal name-form separator, so it is rejected rather than ` +
        `silently rewritten.`,
    );
  return owner;
}

/** The canonical serialization of a **principal** (`owner`+`actor`) — the key every authority that
 *  enforces per-agent grants checks against. It is TWO forms, not one, because the same principal
 *  lands in two namespaces with incompatible rules:
 *    - `key`  — the subject / KV-key dot-form `<owner>.<actor>`, for wire subjects and KV keys,
 *      where `.` is the token boundary;
 *    - `name` — the JetStream-name form `<owner>-<actor>`, for durable / consumer / stream and
 *      chat-history names, where JetStream forbids `.` `*` `>` `/` and whitespace, so the dot-form
 *      is illegal.
 *  Both tokens are {@link assertValidOwnerToken}-validated, and `-` is banned *inside* tokens and
 *  reserved as the sole name separator, so both forms are collision-free — distinct (owner, actor)
 *  pairs can never serialize to the same string. All principal serialization goes through here: no
 *  ad-hoc string joins, and never a `<owner>.<actor>` fed to a JetStream name. Defined ahead of the
 *  owner+actor cutover — call sites (durables, member/acl keys, grants) arrive with the flip. */
export function principalKey(owner: string, actor: string): { key: string; name: string } {
  assertValidOwnerToken(owner);
  assertValidOwnerToken(actor);
  return { key: `${owner}.${actor}`, name: `${owner}-${actor}` };
}

// ---- Lifecycle UID (SPEC §13.1) ----
//
// One grammar bounds both `lifecycleUid` and the endpoint-surface `instanceId` (§13.1/§13.2) —
// deliberately a single definition so the bound cannot drift. Defined HERE (the module with no
// local imports) because the messaging plane needs it for lifecycle-keyed resource names;
// endpoint-subjects re-exports it for the endpoint rails.
export const LIFECYCLE_TOKEN = /^[a-z0-9]{26,32}$/;

export function assertLifecycleToken(v: string, what = "lifecycleUid"): string {
  if (!LIFECYCLE_TOKEN.test(v)) throw new Error(`${what} "${v}" is not a valid lifecycle token ([a-z0-9]{26,32})`);
  return v;
}

/** Mint a fresh lifecycle UID: `[a-z0-9]{26,32}`, >=128 bits of CSPRNG entropy (SPEC §13.1). 20
 *  random bytes (160 bits) render to at most 31 base36 chars; left-padding to 26 keeps the rare
 *  short render in-grammar without losing entropy. The UID is minted ONCE per lifecycle by the
 *  provisioning path and preserved across supervised restarts — never re-minted per process. */
export function mintLifecycleUid(): string {
  return assertLifecycleToken(BigInt(`0x${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("")}`).toString(36).padStart(26, "0"));
}

/** The lifecycle-scoped JetStream-name form `<owner>-<actor>-<lifecycleUid>` (SPEC §13.1 "the UID is
 *  part of the resource NAME"). Injective: owner/actor tokens ban `-` (see {@link principalKey}), the
 *  UID is `[a-z0-9]` (dash-free), and `-` is the sole separator. */
export function lifecycleNameKey(owner: string, actor: string, lifecycleUid: string): string {
  return `${principalKey(owner, actor).name}-${assertLifecycleToken(lifecycleUid)}`;
}

/** The lifecycle-scoped subject/KV dot-form `<owner>.<actor>.<lifecycleUid>` (ACL rows, member-row
 *  principals, dinbox/dlv subject tails). Injective: owner/actor are dot-free tokens and the UID is
 *  `[a-z0-9]`, so exactly three dot-separated tokens. */
export function lifecycleSubjectKey(owner: string, actor: string, lifecycleUid: string): string {
  return `${principalKey(owner, actor).key}.${assertLifecycleToken(lifecycleUid)}`;
}

/** Inverse of {@link lifecycleSubjectKey}: split `<owner>.<actor>.<uid>` back into its three tokens,
 *  or `null` if the string is not exactly that shape. */
export function parseLifecycleSubjectKey(key: string): { owner: string; actor: string; lifecycleUid: string } | null {
  if (typeof key !== "string") return null;
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  const [owner, actor, uid] = parts;
  if (!/^[A-Za-z0-9_]+$/.test(owner) || !/^[A-Za-z0-9_]+$/.test(actor) || !LIFECYCLE_TOKEN.test(uid)) return null;
  return { owner, actor, lifecycleUid: uid };
}

/** Principal key form for subjects and KV keys. Alias for callers/tests that need one form explicitly. */
export function principalSubjectKey(owner: string, actor: string): string {
  return principalKey(owner, actor).key;
}

/** Principal key form for JetStream names. Alias for callers/tests that need one form explicitly. */
export function principalNameKey(owner: string, actor: string): string {
  return principalKey(owner, actor).name;
}

/** A deprovision target is a LIFECYCLE, never an alias (SPEC §13.1 "the teardown credential is
 *  minted target-pinned to `(principal, lifecycleUid)` by exact name"): the principal dot-form
 *  (`u_….<actor>`, user-mode agents) or a bare static/dev actor id (an nkey pub — never contains a
 *  dot, keyed under {@link DEV_OWNER}), PLUS the lifecycle UID of exactly the incarnation being torn
 *  down. A stale/replayed teardown for a retired lifecycle then names only retired resources — it is
 *  broker-denied against a same-alias successor. */
export interface DeprovisionTarget {
  /** `<owner>.<actor>` dot-form, or a bare static actor id. */
  principal: string;
  /** The retired/target incarnation's lifecycle UID — the successor's differs by construction. */
  lifecycleUid: string;
  /** Concrete channels and families whose durable membership rows (`memberKey(channel, principal, uid)`)
   *  this teardown purges. Each becomes one exact-key grant, so the cred still names only this lifecycle. */
  memberChannels?: readonly string[];
}

/** Resolve a deprovision target to its `(owner, actor, lifecycleUid)` triple. Shared by the
 *  deprovisioner permission pin and the teardown helper so they can't diverge. */
export function deprovisionTargetPrincipal(target: DeprovisionTarget): { owner: string; actor: string; lifecycleUid: string; memberChannels: string[] } {
  const pr = parsePrincipalKey(target.principal) ?? { owner: DEV_OWNER, actor: target.principal };
  const memberChannels = [...new Set(target.memberChannels ?? [])].map((ch) => {
    assertValidChannel(ch);
    if (!isConcreteChannel(ch) && !isChannelFamily(ch))
      throw new Error(`deprovision target: member channel "${ch}" must be concrete or a family such as review.> (membership rows are per concrete channel or family)`);
    return ch;
  });
  return { ...pr, lifecycleUid: assertLifecycleToken(target.lifecycleUid), memberChannels };
}

/** Inverse of {@link principalKey}'s dot-form `key`: split a principal `<owner>.<actor>` back into its
 *  two tokens, or `null` if it isn't a valid one. Owner/actor tokens are `[A-Za-z0-9_]+` (dot-free), so a
 *  single `.` separates them unambiguously — exactly two segments, both {@link assertValidOwnerToken}-valid.
 *  Used where a stored principal (a member/from.id dot-form) must be re-split to feed the owner+actor
 *  subject builders (e.g. fan-out → `dinboxSubject`). */
export function parsePrincipalKey(key: string): { owner: string; actor: string } | null {
  if (typeof key !== "string") return null;
  const dot = key.indexOf(".");
  if (dot <= 0 || dot >= key.length - 1) return null;
  const owner = key.slice(0, dot);
  const actor = key.slice(dot + 1);
  if (!/^[A-Za-z0-9_]+$/.test(owner) || !/^[A-Za-z0-9_]+$/.test(actor)) return null;
  return { owner, actor };
}

const USER_INBOX_NONCE = /^[A-Za-z0-9_]{8,128}$/;
const BOUND_USER_INBOX = /^u_[a-z2-7]{26}-[A-Za-z0-9_]+-[A-Za-z0-9_]{8,128}$/;

/** Validate the single literal token in the private reply-inbox grant `_INBOX_<connId>.>`.
 *  The longer form accommodates a user-auth name containing both principal tokens and a nonce. */
export function assertInboxConnId(connId: string): string {
  if (typeof connId !== "string" || (!/^[A-Za-z0-9_-]{8,120}$/.test(connId) &&
      !(connId.length <= 255 && BOUND_USER_INBOX.test(connId))))
    throw new Error(
      `invalid connId/inbox nonce ${JSON.stringify(connId)} - must match [A-Za-z0-9_-]{8,255} ` +
        `with a principal-bound name required above 120 characters (no subject metacharacters)`,
    );
  return connId;
}

/** Build the connection name for user auth. A compact random suffix fits the older callout's
 *  120-character limit with a 64-character actor and a 28-character owner. */
export function userInboxConnId(owner: string, actor: string, nonce?: string): string {
  const suffix = nonce ?? BigInt(`0x${globalThis.crypto.randomUUID().replaceAll("-", "")}`).toString(36).padStart(25, "0");
  if (!USER_INBOX_NONCE.test(suffix)) throw new Error("Use 8 to 128 letters, digits, or underscores for the user inbox nonce.");
  return assertInboxConnId(`${principalKey(owner, actor).name}-${suffix}`);
}

/** Admit legacy names during rollout, but never treat a syntactically principal-bound name as
 *  legacy. Owner, actor, and nonce are dash-free, so the bound form has an unambiguous boundary. */
export function assertUserInboxConnId(name: string, owner: string, actor: string): string {
  const connId = assertInboxConnId(name);
  const prefix = `${principalKey(owner, actor).name}-`;
  if (BOUND_USER_INBOX.test(connId) && !connId.startsWith(prefix))
    throw new Error(`The connection name belongs to another principal. Set the connection name to \`${prefix}<nonce>\` and the inbox prefix to \`_INBOX_${prefix}<nonce>\` using the same fresh nonce.`);
  return connId;
}

/** The `tags` prefix carrying a connection's principal dot-form in its minted user JWT. CONNZ
 *  surfaces a JWT-authed connection's principal identity DIFFERENTLY by cred shape, proven live on
 *  nats-server 2.10/2.14 (see {@link principalFromConnz}): a STATICALLY-minted user (`mintCreds`)
 *  surfaces this `principal:` tag (`authorized_user` is the ephemeral connection nkey), while a
 *  CALLOUT-minted user surfaces the JWT `name` (the principal NAME-form) as `authorized_user` and NO
 *  tags at all. So this tag is the attribution field for STATIC connections only; callout connections
 *  are attributed via `authorized_user`. NEVER reintroduce a tags-ONLY read — it silently misses every
 *  user-mode connection. Always attribute through {@link principalFromConnz}, which handles both. */
export const PRINCIPAL_TAG_PREFIX = "principal:";

/** The identity `tags` stamped into every minted user JWT (dev mint AND the auth callout, via this one
 *  helper) — recoverable from a STATIC connection's CONNZ record (a callout connection surfaces the
 *  principal via `authorized_user` instead; see {@link PRINCIPAL_TAG_PREFIX}). `owner:`/`actor:` are
 *  human/debug breadcrumbs; `principal:` (the dot-form {@link principalKey} `key`) is the one attribution
 *  reads. Single source of the tag format — never hand-join these elsewhere. */
export function principalTags(owner: string, actor: string): string[] {
  const { key } = principalKey(owner, actor);
  return [`owner:${owner}`, `actor:${actor}`, `${PRINCIPAL_TAG_PREFIX}${key}`];
}

/** Recover a connection's principal dot-form from its CONNZ `tags`, or `null` if absent/malformed. The
 *  membership feed calls this to key a live connection by its principal and **fails closed** on `null`
 *  (it drops the connection rather than fall back to the ephemeral nkey — a tagless connection is not a
 *  principal we can attribute). Validates via {@link parsePrincipalKey} so a forged/garbled tag can't
 *  smuggle a non-principal string into the feed. */
export function principalFromTags(tags: readonly string[] | undefined, opts: { allowPlatform?: boolean } = {}): string | null {
  if (!tags) return null;
  const tag = tags.find((t) => t.startsWith(PRINCIPAL_TAG_PREFIX));
  if (!tag) return null;
  const key = tag.slice(PRINCIPAL_TAG_PREFIX.length);
  // Same trust boundary as the message-surfacing guards ({@link isPrincipalOwnerToken}): a recovered
  // principal must have a REAL owner (derived `u_…` or `local`), not just valid dot-form syntax — else a
  // `principal:<nkey>.team` tag would key a live feed entry on an nkey-shaped owner the surfacing path
  // rejects. Fail closed on anything else.
  const p = parsePrincipalKey(key);
  return p && isPrincipalOwnerToken(p.owner, { allowLocal: true, allowPlatform: opts.allowPlatform ?? false }) ? key : null;
}

/** Inverse of {@link principalKey}'s `name` form (`<owner>-<actor>`): recover the principal dot-form
 *  from a name-form string, or `null` if it isn't one. Owner tokens are `[A-Za-z0-9_]+` and actor
 *  tokens too — `-` is reserved as the name-form separator — so the FIRST `-` splits owner from actor
 *  unambiguously, and both halves must be {@link parsePrincipalKey}-valid with a real principal owner.
 *  An nkey (no `-`) or any other non-name-form returns null. */
export function principalFromName(name: string | undefined, opts: { allowPlatform?: boolean } = {}): string | null {
  if (typeof name !== "string") return null;
  const dash = name.indexOf("-");
  if (dash <= 0 || dash >= name.length - 1) return null;
  const key = `${name.slice(0, dash)}.${name.slice(dash + 1)}`;
  const p = parsePrincipalKey(key);
  return p && isPrincipalOwnerToken(p.owner, { allowLocal: true, allowPlatform: opts.allowPlatform ?? false }) ? key : null;
}

/** Recover a connection's principal dot-form from a `$SYS` CONNZ record, across BOTH credential
 *  shapes — the one place that knows nats-server surfaces principal identity differently for each:
 *   - a STATICALLY-minted user (`mintCreds`) surfaces its `principal:` TAG (`authorized_user` is the
 *     ephemeral connection nkey);
 *   - a CALLOUT-minted user surfaces the JWT `name` (the principal NAME-form) as `authorized_user`,
 *     and does NOT surface `tags` at all (proven live on nats-server 2.10.22 + 2.14.2).
 *  So attribution must try the tag first, then the `authorized_user` name-form; anything else (an
 *  un-tagged nkey, open mode, infra) is `null` — unattributable, dropped fail-closed by callers.
 *  The membership feed and live eviction both key on this, so it lives here as the single source.
 *  `allowPlatform` also attributes a platform `p_…` owner (SPEC 13.1). Only the eviction and liveness
 *  sweeps opt in, so they can fence the platform control family; the membership feed does not. */
export function principalFromConnz(conn: { tags?: readonly string[]; authorized_user?: string }, opts: { allowPlatform?: boolean } = {}): string | null {
  return principalFromTags(conn.tags, opts) ?? principalFromName(conn.authorized_user, opts);
}

/** The reserved owner token for the **no-login local/dev path** — the static-creds default when there
 *  is no user identity (the plan's zero-login local default). A valid {@link assertValidOwnerToken}
 *  token, and — being lowercase-alpha with no `u_` prefix — trivially distinct from both nkeys and
 *  {@link assertDerivedOwnerToken} `u_…` owners, so a dev agent can never collide with a real owner
 *  lane. In dev the actor is the connection id, so `local.<id>` is the agent's principal. */
export const DEV_OWNER = "local";

/** Prefix of every **derived owner token** — see {@link assertDerivedOwnerToken}. */
export const DERIVED_OWNER_PREFIX = "u_";

/** Validate the structural format of a **derived owner token** — the opaque, per-space, non-PII
 *  token the auth callout derives server-side for a human owner: `u_` + 26 lowercase base32
 *  (`[a-z2-7]`) chars (128 keyed-HMAC bits; the derivation lives in `@cotal-ai/auth`, this is the
 *  format contract). The format is **structurally disjoint from nkeys by construction** — the
 *  owner+actor flip's acceptance criterion 2: an nkey public key is 56 chars of UPPERCASE base32
 *  (`[A-Z2-7]`), while a derived token is 28 chars, contains `_`, and its body is lowercase — three
 *  independent properties an nkey can never satisfy. So a pre-flip agent id (an nkey) can NEVER
 *  parse as a valid new owner, which closes the old-shape-aliases-new-read lane
 *  (`chat.<nkey>.team.backend` matching `chat.*.*.backend` cannot yield a plausible owner). Every
 *  derived token also trivially passes {@link assertValidOwnerToken} (subset alphabet, no `-`).
 *  Defined ahead of use: enforced at the callout/mint boundary when the cutover lands. Returns the
 *  token unchanged when valid so callers can use it inline. */
export function assertDerivedOwnerToken(owner: string): string {
  if (typeof owner !== "string" || !/^u_[a-z2-7]{26}$/.test(owner))
    throw new Error(
      `invalid derived owner token "${owner}": expected "${DERIVED_OWNER_PREFIX}" + 26 lowercase ` +
        `base32 chars ([a-z2-7]). Owner tokens are derived server-side at the auth callout and are ` +
        `structurally disjoint from nkeys; anything else at an owner boundary is rejected, not rewritten.`,
    );
  return owner;
}

/** True when `owner` is a derived user owner (`u_` plus its grammar); the predicate form of
 *  {@link assertDerivedOwnerToken}, which throws on the same input. */
export function isDerivedOwner(owner: string): boolean {
  return typeof owner === "string" && /^u_[a-z2-7]{26}$/.test(owner);
}

/** Prefix of every **platform owner token** — see {@link assertPlatformOwnerToken}. */
export const PLATFORM_OWNER_PREFIX = "p_";

/** Validate the format of a **platform owner token**: `p_` + 26 lowercase base32 chars. The auth
 *  service derives it for the one platform control manager assigned to an account (SPEC 13.1). It is
 *  disjoint from `u_…` derived owners by prefix, from {@link DEV_OWNER} and from nkeys. A trust
 *  boundary admits it only where it opts in with `allowPlatform`. */
export function assertPlatformOwnerToken(owner: string): string {
  if (typeof owner !== "string" || !/^p_[a-z2-7]{26}$/.test(owner))
    throw new Error(`invalid platform owner token "${owner}": expected "${PLATFORM_OWNER_PREFIX}" + 26 lowercase base32 chars ([a-z2-7])`);
  return owner;
}

/** Validate an owner token at a READ / persisted-owner TRUST boundary — STRICTER than
 *  {@link assertValidOwnerToken}, which (by design) still accepts nkey-shaped uppercase tokens and so does
 *  NOT by itself satisfy the flip's acceptance criterion 2. A *real* owner is EITHER a derived owner
 *  ({@link assertDerivedOwnerToken}: `u_` + 26 lowercase base32, minted at the callout) OR — when
 *  `allowLocal` — the reserved no-login dev owner {@link DEV_OWNER} (`"local"`). An nkey (56-char UPPERCASE
 *  base32) satisfies neither, so a stray old-shape frame `chat.<nkey>.team.backend` can never be TRUSTED as
 *  a valid owner even if it structurally parses — the belt to the from.id≠sender guard's braces and cred
 *  death. Use at every boundary that reads an owner from a wire subject / persisted key and then trusts it
 *  for keying, surfacing, or authorization (membership feed re-key, history surfacing). Actors stay on
 *  {@link assertValidOwnerToken} — they are server-derived from the ledger, not disjointness-constrained.
 *  User-mode MINT boundaries (callout/bridge) use {@link assertDerivedOwnerToken} directly (no `local`). */
export function assertPrincipalOwnerToken(owner: string, opts: { allowLocal?: boolean; allowPlatform?: boolean } = {}): string {
  if (opts.allowLocal && owner === DEV_OWNER) return owner;
  if (opts.allowPlatform && /^p_[a-z2-7]{26}$/.test(owner)) return owner;
  try {
    return assertDerivedOwnerToken(owner);
  } catch {
    throw new Error(
      `invalid principal owner "${owner}" at a trust boundary: expected a derived owner (u_…)` +
        `${opts.allowLocal ? ` or the reserved dev owner "${DEV_OWNER}"` : ""}${opts.allowPlatform ? " or a platform owner (p_…)" : ""} - an nkey-shaped or arbitrary ` +
        `token is not a real owner (flip criterion 2: owners are nkey-disjoint).`,
    );
  }
}

/** Non-throwing {@link assertPrincipalOwnerToken} for hot per-message drop guards — true iff `owner` is a
 *  real principal owner (a derived `u_…`, or `local` when `allowLocal`). The message-surfacing paths call
 *  this on `parsed.owner` alongside the `from.id === parsed.sender` check, so a structurally-valid old-shape
 *  alias (`chat.<nkey>.team.backend`, owner = an nkey) is DROPPED at read time — belt to cred death, not a
 *  dependency on it. `allowLocal` defaults true: the dev/static path is a legitimate live sender. */
export function isPrincipalOwnerToken(owner: string, opts: { allowLocal?: boolean; allowPlatform?: boolean } = { allowLocal: true }): boolean {
  try {
    assertPrincipalOwnerToken(owner, { allowLocal: opts.allowLocal ?? true, allowPlatform: opts.allowPlatform ?? false });
    return true;
  } catch {
    return false;
  }
}
