/**
 * Subject naming — the routing half of the wire contract (v0).
 *
 *   cotal.<space>.chat.<channel>      multicast to a channel (dotted + hierarchical: team.backend, subscribe team.>)
 *   cotal.<space>.svc.<service>       anycast to any one instance of a service (queue group)
 *   cotal.<space>.inst.<instance>     unicast to one specific instance
 *   cotal.<space>.ctl.<service>       control request/reply to a service (e.g. manager)
 *   cotal.<space>.trace.<instance>    ambient lifecycle trace (later)
 *   cotal.<space>.control.<instance>  control-plane commands (later)
 *
 * Presence lives in a JetStream KV bucket, not a subject (see presenceBucket()).
 */

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

/** Canonicalize a `mentions` list for the wire: trim, lowercase, drop empties, dedupe.
 *  Returns `undefined` for an empty result so the field is omitted rather than sent as `[]`.
 *  Presence-agnostic (no roster lookup) — validation lives in the connector. */
export function normalizeMentions(mentions?: string[]): string[] | undefined {
  if (!mentions?.length) return undefined;
  const out = [...new Set(mentions.map((m) => m.trim().toLowerCase()).filter((m) => m.length > 0))];
  return out.length ? out : undefined;
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

/** A routing token (target, role, service), preserving the literal `*` wildcard used on the
 *  subscribe/allow side but sanitizing everything else. A no-op on real ids and equal to `token()`
 *  on every concrete value — it only additionally lets `*` through, e.g. for `svc.*.…` allow rules.
 *  Used for the *service/role* slots (`svc.<role>`, `ctl.<tier>`); the owner/actor identity slots go
 *  through {@link ownerToken} (fail-loud, never rewritten). */
function routeToken(s: string): string {
  return s === "*" ? "*" : token(s);
}

/** An owner/actor identity token in a wire subject: the literal `*` wildcard passes through (for
 *  allow/subscribe rules like `chat.*.*.<ch>`), and every concrete value is {@link assertValidOwnerToken}-
 *  validated (fail loud — a `.`/`*`/`>`/`-` in an id is lane breakout, NEVER silently rewritten the way
 *  `token()`/`routeToken()` would). The owner+actor grammar's per-subject enforcement point. */
function ownerToken(s: string): string {
  return s === "*" ? "*" : assertValidOwnerToken(s);
}

/** Multicast: `chat.<owner>.<actor>.<channel…>` — the publishing principal (owner+actor) precedes the
 *  channel (owner+actor grammar, Shape A). Either identity slot may be `*` for subscribe/allow rules
 *  (`chat.*.*.<ch>` = read a channel from any principal). */
export function chatSubject(space: string, owner: string, actor: string, channel: string): string {
  return `${spacePrefix(space)}.chat.${ownerToken(owner)}.${ownerToken(actor)}.${channelPath(channel)}`;
}

/** True if a channel names a concrete sub-channel (no `*`/`>`) — i.e. it can be
 *  *published* to. Subscriptions may be wildcard; publishes must be concrete. */
export function isConcreteChannel(channel: string): boolean {
  return !channel.split(".").some((s) => s.trim() === "*" || s.trim() === ">");
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
  const segs = channel.split(".");
  if (!channel.length || segs.some((s) => s.length === 0))
    throw new Error(`invalid channel "${channel}": empty segment (no leading/trailing/double dots)`);
  segs.forEach((s, i) => {
    if (s === ">") {
      if (i !== segs.length - 1) throw new Error(`invalid channel "${channel}": '>' is only valid as the last segment`);
      return;
    }
    if (s === "*") return;
    if (!/^[A-Za-z0-9_-]+$/.test(s))
      throw new Error(
        `invalid channel "${channel}": segment "${s}" must be a NATS-safe token ([A-Za-z0-9_-]), '*', or '>' — ` +
          `policy channel names can't contain characters the wire layer would rewrite`,
      );
  });
  return channel;
}

/** Validate an **owner or actor token** of the owner+actor grammar (the per-user-auth cutover).
 *  Defined AHEAD of use: today this has no call sites — persisted owner-bearing keys
 *  ({@link memberKey}, {@link aclKey}, {@link dinboxSubject}, {@link dlvSubject}) still ride raw
 *  nkeys through `token()`/`routeToken()` (a no-op on base32) — the cutover wires this in at every
 *  mint/callout boundary and persisted owner/actor-bearing key. STRICTER than
 *  {@link assertValidChannel}: a token is exactly ONE NATS-safe segment — `[A-Za-z0-9_]+`, with NO
 *  dots, NO `*`, NO `>`, and NO `-`. Dots/wildcards in an id are lane breakout or aliasing (they would
 *  let one owner's grant span, or collide with, another's); `-` is excluded because it is reserved as
 *  the sole separator of {@link principalKey}'s JetStream-name form — a `-` *inside* a token would
 *  make `<owner>-<actor>` ambiguous. The ASCII-only alphabet also makes NFC-normalization trivially
 *  hold (any non-ASCII input fails). FAILS LOUD rather than sanitizing — do NOT substitute
 *  {@link token}/`routeToken` here: they silently rewrite illegal characters, and a rewrite hides an
 *  aliasing attempt. Returns the token unchanged when valid so callers can use it inline. */
export function assertValidOwnerToken(owner: string): string {
  // typeof guard is load-bearing at JS/JSON boundaries: RegExp.test() coerces its argument, so
  // without it a number like 123 stringifies, matches, and is returned UN-coerced.
  if (typeof owner !== "string" || !/^[A-Za-z0-9_]+$/.test(owner))
    throw new Error(
      `invalid owner/actor token "${owner}": must be a single NATS-safe token ([A-Za-z0-9_]) — ` +
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

/** Principal key form for subjects and KV keys. Alias for callers/tests that need one form explicitly. */
export function principalSubjectKey(owner: string, actor: string): string {
  return principalKey(owner, actor).key;
}

/** Principal key form for JetStream names. Alias for callers/tests that need one form explicitly. */
export function principalNameKey(owner: string, actor: string): string {
  return principalKey(owner, actor).name;
}

/** Inverse of {@link principalKey}'s dot-form `key`: split a principal `<owner>.<actor>` back into its
 *  two tokens, or `null` if it isn't a valid one. Owner/actor tokens are `[A-Za-z0-9_]+` (dot-free), so a
 *  single `.` separates them unambiguously — exactly two segments, both {@link assertValidOwnerToken}-valid.
 *  Used where a stored principal (a member/from.id dot-form) must be re-split to feed the owner+actor
 *  subject builders (e.g. fan-out → `dinboxSubject`). */
/** Resolve a deprovision target: a full principal dot-form (`u_….<actor>`, user-mode agents) or a
 *  bare static/dev actor id (an nkey pub — never contains a dot), keyed under {@link DEV_OWNER}.
 *  Shared by the deprovisioner permission pin and the teardown helper so they can't diverge. */
export function deprovisionTargetPrincipal(target: string): { owner: string; actor: string } {
  return parsePrincipalKey(target) ?? { owner: DEV_OWNER, actor: target };
}

export function parsePrincipalKey(key: string): { owner: string; actor: string } | null {
  if (typeof key !== "string") return null;
  const dot = key.indexOf(".");
  if (dot <= 0 || dot >= key.length - 1) return null;
  const owner = key.slice(0, dot);
  const actor = key.slice(dot + 1);
  if (!/^[A-Za-z0-9_]+$/.test(owner) || !/^[A-Za-z0-9_]+$/.test(actor)) return null;
  return { owner, actor };
}

/** Validate a connection's **connId** — the single token that fills `_INBOX_<connId>.>`, the private
 *  reply-inbox grant. In dev/static mode connId is the agent's own nkey (56 uppercase base32 chars); in
 *  user mode it is a client-CHOSEN random inbox nonce (the auth callout can't know the NATS-minted
 *  per-connection nkey pre-connect, and the client can't either, so the client picks its own nonce and
 *  passes it via the connection `name`). Because that nonce is untrusted client input, the grant builder
 *  MUST reject any subject metacharacter here: a connId of `>` would mint `_INBOX_>.>` (every inbox) and a
 *  `*`/`.` would widen it too. `[A-Za-z0-9_-]{8,120}` admits nkeys and high-entropy nonces while barring
 *  `* > . space` — so `_INBOX_<connId>.>` can never escalate past one connection's own inbox. Fail-loud. */
export function assertInboxConnId(connId: string): string {
  if (typeof connId !== "string" || !/^[A-Za-z0-9_-]{8,120}$/.test(connId))
    throw new Error(
      `invalid connId/inbox nonce ${JSON.stringify(connId)} — must match [A-Za-z0-9_-]{8,120} ` +
        `(no subject metacharacters; guards the _INBOX_<connId>.> grant against wildcard escalation)`,
    );
  return connId;
}

/** The `tags` prefix carrying a connection's principal dot-form in its minted user JWT. Chosen because
 *  `tags` are the ONE identity field a NATS `$SYS` CONNZ record surfaces for a JWT-authed connection —
 *  empirically: `authorized_user` is the per-connect ephemeral nkey (NOT the principal, which the client
 *  never knows pre-connect under the callout), and the JWT `name` claim is not surfaced as a queryable
 *  field. So the membership feed recovers the live principal from this tag. */
export const PRINCIPAL_TAG_PREFIX = "principal:";

/** The identity `tags` stamped into every minted user JWT (dev mint AND the auth callout, via this one
 *  helper) so a connection's principal is recoverable server-side from its CONNZ record. `owner:`/`actor:`
 *  are human/debug breadcrumbs; `principal:` (the dot-form {@link principalKey} `key`) is the one the
 *  feed keys on. Single source of the tag format — never hand-join these elsewhere. */
export function principalTags(owner: string, actor: string): string[] {
  const { key } = principalKey(owner, actor);
  return [`owner:${owner}`, `actor:${actor}`, `${PRINCIPAL_TAG_PREFIX}${key}`];
}

/** Recover a connection's principal dot-form from its CONNZ `tags`, or `null` if absent/malformed. The
 *  membership feed calls this to key a live connection by its principal and **fails closed** on `null`
 *  (it drops the connection rather than fall back to the ephemeral nkey — a tagless connection is not a
 *  principal we can attribute). Validates via {@link parsePrincipalKey} so a forged/garbled tag can't
 *  smuggle a non-principal string into the feed. */
export function principalFromTags(tags: readonly string[] | undefined): string | null {
  if (!tags) return null;
  const tag = tags.find((t) => t.startsWith(PRINCIPAL_TAG_PREFIX));
  if (!tag) return null;
  const key = tag.slice(PRINCIPAL_TAG_PREFIX.length);
  // Same trust boundary as the message-surfacing guards ({@link isPrincipalOwnerToken}): a recovered
  // principal must have a REAL owner (derived `u_…` or `local`), not just valid dot-form syntax — else a
  // `principal:<nkey>.team` tag would key a live feed entry on an nkey-shaped owner the surfacing path
  // rejects. Fail closed on anything else.
  const p = parsePrincipalKey(key);
  return p && isPrincipalOwnerToken(p.owner) ? key : null;
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
export function assertPrincipalOwnerToken(owner: string, opts: { allowLocal?: boolean } = {}): string {
  if (opts.allowLocal && owner === DEV_OWNER) return owner;
  try {
    return assertDerivedOwnerToken(owner);
  } catch {
    throw new Error(
      `invalid principal owner "${owner}" at a trust boundary: expected a derived owner (u_…)` +
        `${opts.allowLocal ? ` or the reserved dev owner "${DEV_OWNER}"` : ""} — an nkey-shaped or arbitrary ` +
        `token is not a real owner (flip criterion 2: owners are nkey-disjoint).`,
    );
  }
}

/** Non-throwing {@link assertPrincipalOwnerToken} for hot per-message drop guards — true iff `owner` is a
 *  real principal owner (a derived `u_…`, or `local` when `allowLocal`). The message-surfacing paths call
 *  this on `parsed.owner` alongside the `from.id === parsed.sender` check, so a structurally-valid old-shape
 *  alias (`chat.<nkey>.team.backend`, owner = an nkey) is DROPPED at read time — belt to cred death, not a
 *  dependency on it. `allowLocal` defaults true: the dev/static path is a legitimate live sender. */
export function isPrincipalOwnerToken(owner: string, opts: { allowLocal?: boolean } = { allowLocal: true }): boolean {
  try {
    assertPrincipalOwnerToken(owner, { allowLocal: opts.allowLocal ?? true });
    return true;
  } catch {
    return false;
  }
}

/** Is `channel` within a read/post ACL `allow` (a list of channel patterns)? True when some
 *  entry covers it — exact, or a wildcard subtree (`team.>` covers `team.backend`). Channels are
 *  dotted token strings, so this rides {@link subjectMatches}. The single covering rule shared by
 *  the load-time invariant (`subscribe ⊆ allowSubscribe`), the connector subset check, and the
 *  manager's mediated-join validation (`channel ∈ allowSubscribe`) so they can't drift. */
export function channelInAllow(allow: string[], channel: string): boolean {
  return allow.some((a) => subjectMatches(a, channel));
}

/** Drop exact duplicates and any subject subsumed by a more-general one — JetStream
 *  rejects a consumer whose `filter_subjects` overlap, so `[team.>, team.backend]`
 *  must collapse to `[team.>]` before binding the chat consumer. A parent and its subtree
 *  (`[review, review.>]`) are disjoint in NATS (`review.>` never matches bare `review`), so
 *  both are kept — that's how a peer subscribes to a channel *and* everything under it. */
export function collapseFilterSubjects(subjects: string[]): string[] {
  const uniq = [...new Set(subjects)];
  return uniq.filter((x) => !uniq.some((y) => y !== x && subjectMatches(y, x)));
}

/** Unicast: `inst.<recipOwner>.<recipActor>.<sndOwner>.<sndActor>` — the recipient principal, then the
 *  sender principal (owner+actor grammar). The 4-token form is deliberate: it lets a native publish grant
 *  forge-lock the sender suffix (`inst.*.*.<myOwner>.<myActor>`), so the daemon needn't re-verify a
 *  payload sender claim. Any slot may be `*` for allow rules (`inst.*.*.<o>.<a>` to send as me;
 *  {@link unicastRecvFilter} for the receive side). */
export function unicastSubject(
  space: string,
  recipOwner: string,
  recipActor: string,
  sndOwner: string,
  sndActor: string,
): string {
  return `${spacePrefix(space)}.inst.${ownerToken(recipOwner)}.${ownerToken(recipActor)}.${ownerToken(sndOwner)}.${ownerToken(sndActor)}`;
}

/** The receive-side DM filter/grant for a recipient principal: `inst.<owner>.<actor>.>` — every DM
 *  addressed to me, from any sender. (The send side is the 4-token {@link unicastSubject}.) */
export function unicastRecvFilter(space: string, owner: string, actor: string): string {
  return `${spacePrefix(space)}.inst.${ownerToken(owner)}.${ownerToken(actor)}.>`;
}

/** Anycast: `svc.<service>.<owner>.<actor>` — a service (role), tagged with the sender principal.
 *  Subscribers join a queue group so one instance receives. Identity slots accept `*`. */
export function anycastSubject(space: string, service: string, owner: string, actor: string): string {
  return `${spacePrefix(space)}.svc.${routeToken(service)}.${ownerToken(owner)}.${ownerToken(actor)}`;
}

/** The serve-side TASK filter/grant for a role: `svc.<role>.>` — every anycast to the role, from any
 *  sender principal (the sender slot widened from one token to two, so the tail is `.>`). */
export function anycastServeFilter(space: string, service: string): string {
  return `${spacePrefix(space)}.svc.${routeToken(service)}.>`;
}

/** Control request/reply to a service (e.g. the manager): `ctl.<service>.<owner>.<actor>` — tagged with
 *  the caller principal; anycast via queue group. Identity slots accept `*` (serve side: `ctl.<tier>.*.*`). */
export function controlServiceSubject(space: string, service: string, owner: string, actor: string): string {
  return `${spacePrefix(space)}.ctl.${routeToken(service)}.${ownerToken(owner)}.${ownerToken(actor)}`;
}

/** Control-plane service names — the three-tier split (P2a). The manager subscribes to ALL
 *  three; the cred layer grants {@link CONTROL_SELF_SERVICE} to every agent and
 *  {@link CONTROL_PRIVILEGED} only to spawn-capable agents (default-deny otherwise), while
 *  {@link CONTROL_ADMIN} is reached only by the manager's own allow-all profile (no agent ever
 *  gets it). nats-server — not a handler — is the coarse boundary. The handler then routes by
 *  op↔service (fail-closed on mismatch) and refines own-child vs admin among holders of the
 *  privileged subject. `CONTROL_PRIVILEGED` is the existing `manager` service; `CONTROL_SELF_SERVICE`
 *  carries only the no-name self stop/despawn; `CONTROL_ADMIN` carries the operator-only ops
 *  (purge, cross-agent stop/despawn/attach/definePersona). */
export const CONTROL_PRIVILEGED = "manager" as const;
export const CONTROL_SELF_SERVICE = "self" as const;
export const CONTROL_ADMIN = "admin" as const;
/** The delivery service — a control service served by the server-side **delivery daemon** (NOT the
 *  manager), carrying the runtime durable `join` / `leave` / `listMemberships` ops agents call. Agents
 *  publish a request to `ctl.delivery.<agentId>` and receive the reply on `ctl.delivery.<agentId>.…`,
 *  a subtree both sides scope tightly: the agent gets pub on `ctl.delivery.<id>` + sub on
 *  `ctl.delivery.<id>.>`, and the daemon gets sub on `ctl.delivery.*` (queue) + pub on `ctl.delivery.>`
 *  (replies). This keeps the daemon least-privilege — it never needs broad inbox-publish to answer an
 *  agent (only the allow-all manager could reply into the per-id `_INBOX_<id>` prefix). Lifecycle ops
 *  (spawn/stop/despawn) stay on the manager's tiers; durable membership is the daemon's. */
export const CONTROL_DELIVERY = "delivery" as const;
/** The three control-plane tiers the manager serves — values tie to the `CONTROL_*` service
 *  names so handler routing can't drift from the subject names. */
export type ControlTier = typeof CONTROL_PRIVILEGED | typeof CONTROL_SELF_SERVICE | typeof CONTROL_ADMIN;

export function traceSubject(space: string, agentId: string): string {
  return `${spacePrefix(space)}.trace.${token(agentId)}`;
}

export function controlSubject(space: string, agentId: string): string {
  return `${spacePrefix(space)}.control.${token(agentId)}`;
}

/** Wildcard matching every subject within a space. */
export function spaceWildcard(space: string): string {
  return `${spacePrefix(space)}.>`;
}

/** Wildcard matching every chat (multicast) subject in a space — the read surface an
 *  observer is allowed (DM/anycast stay confidential). */
export function chatWildcard(space: string): string {
  return `${spacePrefix(space)}.chat.>`;
}

/** The three peer-message delivery modes (control/trace/presence are not deliveries). */
export type DeliveryMode = "chat" | "anycast" | "unicast";

/** A subject parsed into its routing parts (owner+actor grammar, Shape A). `owner`/`actor` are the
 *  publishing principal's two tokens; `sender` is their canonical dot-form `<owner>.<actor>` (=
 *  {@link principalKey}`.key`), so guards that compare `msg.from.id === parsed.sender` keep working
 *  verbatim once `from.id` carries the principal dot-form. `rest` is the channel (chat) or the routed
 *  target/role/service (inst → recipient principal dot-form; svc → role; ctl → service). */
export interface ParsedSubject {
  kind: "chat" | "inst" | "svc" | "ctl";
  owner: string;
  actor: string;
  /** The sender principal in canonical dot-form `<owner>.<actor>`. */
  sender: string;
  /** chat → channel (possibly hierarchical); inst → recipient principal `<owner>.<actor>`; svc → role; ctl → service. */
  rest: string;
}

/**
 * The single authority on the subject layout — every reader of a wire subject goes through this, so the
 * owner+actor sender positions live in exactly one place (`kind` stays at [2]):
 *   chat.<owner>.<actor>.<channel…>              sender owner[3] actor[4], channel is everything after
 *   inst.<recipOwner>.<recipActor>.<sndOwner>.<sndActor>   sender owner[5] actor[6], recipient = [3].[4]
 *   svc.<role>.<owner>.<actor>                   sender owner[4] actor[5], role = [3]
 *   ctl.<service>.<owner>.<actor>                sender owner[4] actor[5], service = [3]
 * Validates the prefix and per-kind arity first and returns `null` on anything else, so a malformed
 * subject can never be read as if it carried a principal. This SPLITS ONLY (no owner-token validation)
 * — the broker already forge-locked the identity slots via the minted grant; a reader recovers them.
 */
export function parseSubject(subject: string): ParsedSubject | null {
  const parts = subject.split(".");
  if (parts[0] !== ROOT) return null; // cotal.<space>.<kind>.…
  const kind = parts[2];
  const mk = (kind: ParsedSubject["kind"], owner: string, actor: string, rest: string): ParsedSubject =>
    ({ kind, owner, actor, sender: `${owner}.${actor}`, rest });
  if (kind === "chat") {
    if (parts.length < 6) return null; // cotal.<space>.chat.<owner>.<actor>.<channel…>
    return mk(kind, parts[3], parts[4], parts.slice(5).join("."));
  }
  if (kind === "inst") {
    if (parts.length !== 7) return null; // cotal.<space>.inst.<recipOwner>.<recipActor>.<sndOwner>.<sndActor>
    return mk(kind, parts[5], parts[6], `${parts[3]}.${parts[4]}`);
  }
  if (kind === "svc" || kind === "ctl") {
    if (parts.length !== 6) return null; // cotal.<space>.<kind>.<route>.<owner>.<actor>
    return mk(kind, parts[4], parts[5], parts[3]);
  }
  return null;
}

/**
 * Classify a subject's delivery mode, or `null` for control/trace/etc. A thin map over
 * {@link parseSubject}. Observers (e.g. a feed) use this instead of re-parsing the layout.
 */
export function deliveryOf(subject: string): DeliveryMode | null {
  const p = parseSubject(subject);
  if (!p) return null;
  return p.kind === "chat" ? "chat" : p.kind === "svc" ? "anycast" : p.kind === "inst" ? "unicast" : null;
}

/** Name of the KV bucket holding presence for a space. */
export function presenceBucket(space: string): string {
  return `cotal_presence_${token(space)}`;
}

/** Name of the KV bucket holding the channel registry (config) for a space — sibling of
 *  the presence bucket. Key = the concrete channel token (`review`, `team.backend`). */
export function channelBucket(space: string): string {
  return `cotal_channels_${token(space)}`;
}

/** Reserved registry key for the space-wide channel defaults. `=` is a valid KV-key
 *  character (`/^[-/=.\w]+$/`) but one `token()` can never produce (it maps every char
 *  outside `[A-Za-z0-9_-]` to `_`), so this key can never collide with a real channel. */
export const CHANNEL_DEFAULTS_KEY = "=defaults";

/** Name of the KV bucket holding the durable-membership registry (Plane-3) for a space — a
 *  privileged-write sibling of the channels/presence buckets. One record per (concrete channel,
 *  owner) under {@link memberKey}; the source of truth for `channelMembers()` and the fan-out's
 *  member list, moved off JetStream consumer topology (which core-sub joins don't create). */
export function membersBucket(space: string): string {
  return `cotal_members_${token(space)}`;
}

/** KV key for one membership record: `<channel>/<principal>`, where `principal` is the member's
 *  owner+actor dot-form (`<owner>.<actor>` = {@link principalKey}`.key`) — membership is per-agent
 *  (owner+actor), not per-owner-shared. The channel is concrete (no `*`/`>`, validated at the write
 *  path) so it is dotted-but-`/`-free, and a principal dot-form is `[A-Za-z0-9_.]` (also `/`-free), so
 *  the single `/` separates them unambiguously — both halves recover via {@link parseMemberKey}. `/`,
 *  `.`, and `[A-Za-z0-9_]` are all legal KV-key chars (`/^[-/=.\w]+$/`), so no encoding is needed. */
export function memberKey(channel: string, principal: string): string {
  return `${channel}/${principal}`;
}

/** Inverse of {@link memberKey}: split a member key back into `{ channel, principal }`, or `null` if
 *  it isn't one (no `/`). Splits on the single separator — channels and principal dot-forms are both
 *  `/`-free (the `.` inside a principal is not a `/`). */
export function parseMemberKey(key: string): { channel: string; principal: string } | null {
  const i = key.indexOf("/");
  if (i <= 0 || i >= key.length - 1) return null;
  return { channel: key.slice(0, i), principal: key.slice(i + 1) };
}

/** Name of the KV bucket holding the durable read-ACL registry (Plane-3) for a space — a
 *  privileged-write sibling of the members/channels buckets. One record per OWNER (key = owner id),
 *  holding that owner's current read ACL (`allowSubscribe`). The delivery daemon's trusted reader
 *  re-authorizes every durable entry against this — moved off the manager's in-memory ledger so a
 *  stateless, server-side daemon re-reads it on boot (fixes the restart-fragility nak-loop). It is
 *  ALSO what the daemon validates a runtime durable-join against (channel ∈ the owner's ACL). */
export function aclBucket(space: string): string {
  return `cotal_acl_${token(space)}`;
}

/** KV key for one principal's read-ACL record: the member's owner+actor dot-form (`<owner>.<actor>` =
 *  {@link principalKey}`.key`) — the read ACL is per-agent (owner+actor), like membership. The dot-form
 *  is a legal KV key (`/^[-/=.\w]+$/`); pass it through UNCHANGED — do NOT run it through `token()`,
 *  which rewrites `.`→`_` and would alias distinct principals onto one key. */
export function aclKey(principal: string): string {
  return principal;
}

// ---- Authoritative channel membership (broker CONNZ → derived feed) ----
//
// The graph view needs "who is subscribed to each channel" — incl. silent readers and `live` channels
// that keep no enumerable roster. That truth lives in the broker's connection view (CONNZ), a
// system-account service. A privileged daemon reads it on a scoped `$SYS` cred and publishes a derived,
// non-`$SYS` feed in the data account; the web app consumes that. See graph-membership-connz.md.

/** Name of the KV bucket holding the derived channel-membership feed for a space (data-account, derived
 *  from CONNZ ∪ the members registry). One entry per AGENT (key = the agent nkey / `card.id`); value is a
 *  {@link import("./types.js").ChannelMembership}. Per-agent keying (not per-channel) keeps keys dot-free
 *  and each value tiny — cap-safe under `max_payload`. Privileged-write (the `membership-rw` cred), read
 *  by the admin/observer dashboard only (exposing the silent-reader set is a trust shift). */
export function membershipBucket(space: string): string {
  return `cotal_membership_${token(space)}`;
}

/** KV key for one agent's membership-feed record: the agent's owner+actor dot-form (`<owner>.<actor>` =
 *  {@link principalKey}`.key`) — one record per agent (owner+actor), keyed like acl/members. Pass the
 *  dot-form through UNCHANGED — do NOT run it through `token()` (which rewrites `.`→`_` and would alias
 *  distinct principals). Both feed sources (the CONNZ live side and the durable members side) must
 *  resolve to this same dot-form so the union does not double-key one agent. */
export function membershipKey(principal: string): string {
  return principal;
}

/** Reserved membership-bucket key for the feed's freshness heartbeat — the daemon re-stamps it every
 *  successful poll (even when no membership changed), so the dashboard can tell "feed is live" from "feed
 *  is stale/dead" WITHOUT the per-agent diff-before-put suppressing the signal. `=` is a valid KV-key char
 *  that `token()` can never emit, so it can never collide with an agent nkey (same trick as
 *  {@link CHANNEL_DEFAULTS_KEY}). */
export const MEMBERSHIP_FEED_KEY = "=feed";

/** The scoped client inbox prefix the membership observer connects under, so its `$SYS` request/reply
 *  replies land on a subject its (least-privilege) cred is allowed to subscribe (`<prefix>.>`) — never
 *  the global `_INBOX.>`. A constant so the cred's `sub.allow` and the connection's `inboxPrefix` can't
 *  drift. */
export const MEMBERSHIP_INBOX_PREFIX = "_INBOX.cotal-membership";

/** The account-scoped CONNZ request subject (`$SYS.REQ.ACCOUNT.<accountID>.CONNZ`, nats-server
 *  `events.go` `accDirectReqSubj`). `accountID` is the DATA account's public key. The request **fans
 *  out** — every server replies for its local conns — so the caller paginates per-server and unions by
 *  nkey. Account-scoped (over server-wide `$SYS.REQ.SERVER.PING.CONNZ`) keeps the cred to one account. */
export function connzRequestSubject(accountId: string): string {
  return `$SYS.REQ.ACCOUNT.${accountId}.CONNZ`;
}

/** Account connection-lifecycle event subjects (`$SYS.ACCOUNT.<accountID>.CONNECT|DISCONNECT`). The
 *  observer subscribes these as **re-poll triggers** only — there is no SUB/UNSUB event, so the periodic
 *  CONNZ poll is the primary signal (these just shorten join/leave-the-mesh latency). Pinned to the one
 *  account id, never `$SYS.ACCOUNT.*` (every tenant's events the moment two spaces share a broker). */
export function accountConnectSubject(accountId: string): string {
  return `$SYS.ACCOUNT.${accountId}.CONNECT`;
}
export function accountDisconnectSubject(accountId: string): string {
  return `$SYS.ACCOUNT.${accountId}.DISCONNECT`;
}

/** The per-server client-KICK request subject (`$SYS.REQ.SERVER.<serverID>.KICK`, nats-server
 *  `events.go` `clientKickReqSubj`). Payload `{cid}` → the server disconnects that live client by
 *  connection id. PER-SERVER: `serverID` MUST come from the SAME CONNZ reply that yielded the cid
 *  (KICK is not fan-out; a cid is only meaningful on its own server). System-account only. There is
 *  no per-cid success ack — the caller re-scans CONNZ to confirm the connection is gone. This is the
 *  kill-live half of revocation; it is ALWAYS paired with a deny-new (ledger revoke / cred expiry /
 *  signer strip / ACL removal), since a kicked client reconnects with a fresh cid until its cred dies. */
export function serverKickSubject(serverId: string): string {
  return `$SYS.REQ.SERVER.${serverId}.KICK`;
}

/** Extract the channel pattern from a live chat SUBSCRIPTION subject in this space, or `null` if it
 *  isn't one. A subscription's sender slots are `*` (an agent's `sub.allow` is `chat.*.*.<channel>`), so
 *  the channel portion (wildcards preserved, e.g. `team.>`) is everything after the two identity tokens.
 *  This is the ALLOWLIST the membership daemon uses to turn a connection's subscription list into its
 *  channel-subscription set — matched against the chat grammar (not a denylist of known plumbing, which
 *  rots when a new plumbing subject is added). Drops `_INBOX`, JetStream API, other-space, and non-chat
 *  subjects. The whole-chat god-view (`chat.*.*.>` → rest `">"`) IS returned here; the SHORT-wildcard
 *  taps (`chat.>`, `chat.*.>`) fail the ≥6-token arity and return `null` — the caller's god-tap detector
 *  must surface those as reads-all separately (a length-checking parse must not let them vanish).
 *
 *  COUPLING (mitnick): both this extraction AND the membership daemon's god-tap detection ride
 *  {@link parseSubject}'s owner+actor chat layout (channel after [4]). A future grammar reorder would move
 *  where the channel portion begins and silently break both — revisit this + the daemon's exclusion
 *  (and their tests) together. */
export function channelFromChatSubscription(space: string, subject: string): string | null {
  if (!subject.startsWith(`${spacePrefix(space)}.chat.`)) return null;
  const p = parseSubject(subject);
  return p && p.kind === "chat" ? p.rest : null;
}

/** Name of the KV bucket holding the delivery daemon's single-flight lease + readiness signal for a
 *  space. One key per shard ({@link leaseKey}); writable only by the `delivery` cred, world-readable
 *  (an agent reads it for the non-gating delivery-health surface). The bucket holds ONLY lease keys,
 *  so a bucket-level TTL (`max_age`) cleanly expires a crashed holder's lease. (Per-key KV TTL via
 *  `Nats-TTL`/marker TTL is also available on this stack — `@nats-io/kv` 3.4 + server 2.14 — so the
 *  bucket-level TTL is a deliberate simplicity choice for a one-purpose bucket, not a capability gap.) */
export function deliveryBucket(space: string): string {
  return `cotal_delivery_${token(space)}`;
}

/** KV key for one shard's delivery lease/readiness (N=1 → `lease.0`). */
export function leaseKey(shardIndex: number): string {
  return `lease.${shardIndex}`;
}

/** Name of the KV bucket holding the per-space MANAGER singleton lease — one key
 *  ({@link MANAGER_LEASE_KEY}), the live manager for the space. Bucket-level TTL (max_age =
 *  LEASE_TTL_MS) auto-expires a crashed manager's lease so a replacement can acquire. Created by the
 *  manager (allow-all profile); read by `spawn -f` to reuse the running manager not start a duplicate. */
export function managerBucket(space: string): string {
  return `cotal_manager_${token(space)}`;
}
/** The single key in {@link managerBucket} — there is exactly one manager per space. */
export const MANAGER_LEASE_KEY = "lease";

/** Deterministic FNV-1a (32-bit) hash of `key` into `[0, n)` — stable across processes/restarts, so a
 *  shard assignment never moves under a running daemon. The Plane-3 partition seam (sharding):
 *  **N=1 is the only operating mode shipped** (`shards > 1` is hard-rejected at the daemon entrypoint)
 *  because a hash partition is not expressible as a NATS `sub.allow`/durable filter under the flat chat
 *  grammar — see core-sub-fabric.md. Present so the N>1 follow-up (with a channel-prefix grammar) is a
 *  small diff. */
export function partition(n: number, key: string): number {
  if (n <= 1) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % n;
}

// ---- JetStream streams (the durable backing for the three delivery modes) ----

/** Stream capturing `chat.>` — multicast backlog + history. */
export function chatStream(space: string): string {
  return `CHAT_${token(space)}`;
}

/** Stream capturing `inst.>` — per-instance direct-message inboxes. */
export function dmStream(space: string): string {
  return `DM_${token(space)}`;
}

/** Stream capturing `svc.>` — anycast work queue. */
export function taskStream(space: string): string {
  return `TASK_${token(space)}`;
}

// ---- Plane-3 (durable backstop, SPEC §8) — two per-space streams ----
//
// `dinbox.<owner>` is the MIXED pre-auth store (fan-out target): the agent holds NO grant on
// {@link inboxStream} and the trusted reader (the delivery daemon) is its only consumer. `dlv.<owner>` is the
// per-member POST-auth handoff: the reader transfers each re-authorized copy here and the agent binds
// {@link dlvDurable} bind-only and acks it via native JetStream (§8 "an equivalent per-member
// at-least-once mechanism with the same ack semantics"). `dlv` carries channel messages only, so the
// receiver derives `kind=channel` from the delivery path — no payload/header kind (SPEC §4).

/** Stream capturing `dinbox.>` — the per-owner mixed durable inbox (fan-out target; agent unreadable). */
export function inboxStream(space: string): string {
  return `INBOX_${token(space)}`;
}

/** Stream capturing `dlv.>` — the per-member post-auth delivery store (agent binds + acks). */
export function dlvStream(space: string): string {
  return `DLV_${token(space)}`;
}

/** Subject of a principal's mixed durable inbox: `cotal.<space>.dinbox.<owner>.<actor>` (one per agent —
 *  the fan-out delivers a per-member copy, and a member is a principal). Either identity slot accepts `*`
 *  for the daemon's fan-out write grant (`dinbox.*.*`). */
export function dinboxSubject(space: string, owner: string, actor: string): string {
  return `${spacePrefix(space)}.dinbox.${ownerToken(owner)}.${ownerToken(actor)}`;
}

/** Subject of a principal's post-auth delivery: `cotal.<space>.dlv.<owner>.<actor>` (one per agent). */
export function dlvSubject(space: string, owner: string, actor: string): string {
  return `${spacePrefix(space)}.dlv.${ownerToken(owner)}.${ownerToken(actor)}`;
}

/** Parse the principal out of a mixed-inbox subject `cotal.<space>.dinbox.<owner>.<actor>`, or null.
 *  The trusted reader is a SINGLE consumer over `dinbox.>` (all principals), so it recovers the
 *  per-message owner+actor from the subject (split only — the broker forge-locked the slots at write). */
export function parseDinboxPrincipal(subject: string): { owner: string; actor: string } | null {
  const parts = subject.split(".");
  // cotal.<space>.dinbox.<owner>.<actor>
  return parts.length === 5 && parts[0] === ROOT && parts[2] === "dinbox"
    ? { owner: parts[3], actor: parts[4] }
    : null;
}

/** An agent's bind-only per-member consumer on {@link dlvStream} (filter `dlv.<owner>.<actor>`). The
 *  durable NAME is the principal's JetStream-safe dash-form (`dlv_<owner>-<actor>`) — a `.` is illegal
 *  in a durable name, so this uses {@link principalKey}`.name`, never the dot-form. */
export function dlvDurable(owner: string, actor: string): string {
  return `dlv_${principalKey(owner, actor).name}`;
}

/** The single privileged fan-out consumer on the CHAT stream (delivery-daemon-pumped; routing, not
 *  auth). N=1 keeps this exact name (see {@link fanoutDurable}). */
export const FANOUT_DURABLE = "fanout" as const;

/** The single privileged trusted-reader consumer on {@link inboxStream} (filter `dinbox.>`,
 *  delivery-daemon-pumped). It re-authorizes each entry and transfers the authorized copy to
 *  `dlv.<owner>`. N=1 keeps this exact name (see {@link readerDurable}). */
export const INBOX_READER_DURABLE = "reader" as const;

/** Per-shard fan-out durable name (the sharding seam). N=1 (`shards <= 1`) keeps the exact legacy
 *  name `fanout` so a running space's existing durable + ack cursor carry over; N>1 (deferred until
 *  the channel-prefix grammar) → `fanout_<i>`. */
export function fanoutDurable(shard = 0, shards = 1): string {
  return shards <= 1 ? FANOUT_DURABLE : `${FANOUT_DURABLE}_${shard}`;
}

/** Per-shard trusted-reader durable name (the sharding seam). N=1 keeps `reader`; N>1 → `reader_<i>`. */
export function readerDurable(shard = 0, shards = 1): string {
  return shards <= 1 ? INBOX_READER_DURABLE : `${INBOX_READER_DURABLE}_${shard}`;
}

/** Name of the REMOVED per-instance chat live-tail durable. Retained only as the canonical name the
 *  read-ACL conformance test asserts an agent can NOT create — it has no live callers, the live read is
 *  now a native core subscription. Principal name-form (`chat_<owner>-<actor>`) for namespace consistency. */
export function chatDurable(owner: string, actor: string): string {
  return `chat_${principalKey(owner, actor).name}`;
}

/** Consumer name for an agent's short-lived chat **history** reads (join-backfill, focus-recall,
 *  drop-marker). A single per-agent name in the principal's JetStream-safe dash-form
 *  (`chathist_<owner>-<actor>`) so its create/info/fetch/delete grants name-scope to that principal —
 *  a peer can never bind it — while the per-read single `filter_subject` is what the create-time ACL
 *  pins to `allowSubscribe`. */
export function chatHistDurable(owner: string, actor: string): string {
  return `chathist_${principalKey(owner, actor).name}`;
}

/** Durable consumer name for an agent's private DM inbox — the principal's dash-form (`dm_<owner>-<actor>`). */
export function dmDurable(owner: string, actor: string): string {
  return `dm_${principalKey(owner, actor).name}`;
}

/** Durable consumer name (shared across instances of a role) for the task queue. */
export function taskDurable(service: string): string {
  return `svc_${token(service)}`;
}
