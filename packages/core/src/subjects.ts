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

/** A routing token (sender, target, role, service), preserving the literal `*` wildcard
 *  used on the subscribe/allow side but sanitizing everything else. A no-op on real ids
 *  (nkey public keys are base32 [A-Z0-9]) and equal to `token()` on every concrete value —
 *  it only additionally lets `*` through, e.g. for `inst.*.<id>` / `svc.*.<id>` allow rules. */
function routeToken(s: string): string {
  return s === "*" ? "*" : token(s);
}

export function chatSubject(space: string, sender: string, channel: string): string {
  return `${spacePrefix(space)}.chat.${routeToken(sender)}.${channelPath(channel)}`;
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

/** Unicast: a specific instance's inbox, tagged with the sender. (Either position may be
 *  `*` for subscribe/allow rules: `inst.<myId>.*` to receive, `inst.*.<myId>` to send as me.) */
export function unicastSubject(space: string, target: string, sender: string): string {
  return `${spacePrefix(space)}.inst.${routeToken(target)}.${routeToken(sender)}`;
}

/** Anycast: a service (role), tagged with the sender. Subscribers join a queue group so one instance receives. */
export function anycastSubject(space: string, service: string, sender: string): string {
  return `${spacePrefix(space)}.svc.${routeToken(service)}.${routeToken(sender)}`;
}

/** Control request/reply to a service (e.g. the manager), tagged with the sender; anycast via queue group. */
export function controlServiceSubject(space: string, service: string, sender: string): string {
  return `${spacePrefix(space)}.ctl.${routeToken(service)}.${routeToken(sender)}`;
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

/** A subject parsed into its routing parts. `sender` is the publishing agent's id;
 *  `rest` is the channel (chat) or the routed target/role/service (inst/svc/ctl). */
export interface ParsedSubject {
  kind: "chat" | "inst" | "svc" | "ctl";
  sender: string;
  /** chat → channel (possibly hierarchical); inst → target; svc → role; ctl → service. */
  rest: string;
}

/**
 * The single authority on the subject layout — every reader of a wire subject goes
 * through this, so the sender-position asymmetry lives in exactly one place:
 *   chat.<sender>.<channel…>   sender at [3], channel is everything after
 *   inst.<target>.<sender>     sender at [4]
 *   svc.<role>.<sender>        sender at [4]
 *   ctl.<service>.<sender>     sender at [4]
 * Validates the prefix and per-kind shape first and returns `null` on anything else,
 * so a malformed subject can never be read as if it carried a sender.
 */
export function parseSubject(subject: string): ParsedSubject | null {
  const parts = subject.split(".");
  if (parts[0] !== ROOT) return null; // cotal.<space>.<kind>.…
  const kind = parts[2];
  if (kind === "chat") {
    if (parts.length < 5) return null; // cotal.<space>.chat.<sender>.<channel…>
    return { kind, sender: parts[3], rest: parts.slice(4).join(".") };
  }
  if (kind === "inst" || kind === "svc" || kind === "ctl") {
    if (parts.length !== 5) return null; // cotal.<space>.<kind>.<route>.<sender>
    return { kind, sender: parts[4], rest: parts[3] };
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

/** KV key for one membership record: `<channel>/<owner>`. The channel is concrete (no `*`/`>`,
 *  validated at the write path) so it is dotted-but-`/`-free, and an owner id is an nkey
 *  (`[A-Z0-9]`, also `/`-free), so the single `/` separates them unambiguously — both halves
 *  recover via {@link parseMemberKey}. `/`, `.`, and `[A-Za-z0-9_-]` are all legal KV-key chars
 *  (`/^[-/=.\w]+$/`), so no encoding is needed. */
export function memberKey(channel: string, owner: string): string {
  return `${channel}/${owner}`;
}

/** Inverse of {@link memberKey}: split a member key back into `{ channel, owner }`, or `null` if
 *  it isn't one (no `/`). Splits on the single separator — channels and owner ids are both `/`-free. */
export function parseMemberKey(key: string): { channel: string; owner: string } | null {
  const i = key.indexOf("/");
  if (i <= 0 || i >= key.length - 1) return null;
  return { channel: key.slice(0, i), owner: key.slice(i + 1) };
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

/** KV key for one owner's read-ACL record: the owner id (an nkey — `[A-Z0-9]`, `/`-free, a `token()`
 *  no-op; keyed like presence, which uses the bare id). */
export function aclKey(owner: string): string {
  return token(owner);
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

/** KV key for one agent's membership record: the agent id (an nkey — `[A-Z0-9]`, dot-free, a `token()`
 *  no-op; keyed like presence/acl, which use the bare id). */
export function membershipKey(id: string): string {
  return token(id);
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

/** Extract the channel pattern from a live chat SUBSCRIPTION subject in this space, or `null` if it
 *  isn't one. A subscription's sender slot is `*` (an agent's `sub.allow` is `chat.*.<channel>`), so the
 *  channel portion (wildcards preserved, e.g. `team.>`) is everything after. This is the ALLOWLIST the
 *  membership daemon uses to turn a connection's subscription list into its channel-subscription set —
 *  matched against the chat grammar (not a denylist of known plumbing, which rots when a new plumbing
 *  subject is added). Drops `_INBOX`, JetStream API, other-space, and non-chat subjects. The whole-chat
 *  god-view (`chat.*.>` → rest `">"`) IS returned here; the caller excludes such taps separately.
 *
 *  COUPLING (mitnick): both this extraction AND the membership daemon's god-tap detection ride
 *  {@link parseSubject}'s sender-at-[3] chat layout. The deferred read-containment grammar reorder
 *  (sender out of the subject) would move where the channel portion begins and silently break both —
 *  revisit this + the daemon's exclusion (and their tests) if that grammar ships. */
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

/** Subject of an owner's mixed durable inbox: `cotal.<space>.dinbox.<owner>` (one per owner). */
export function dinboxSubject(space: string, owner: string): string {
  return `${spacePrefix(space)}.dinbox.${routeToken(owner)}`;
}

/** Subject of an owner's post-auth delivery: `cotal.<space>.dlv.<owner>` (one per owner). */
export function dlvSubject(space: string, owner: string): string {
  return `${spacePrefix(space)}.dlv.${routeToken(owner)}`;
}

/** Parse the owner id out of an owner's mixed-inbox subject `cotal.<space>.dinbox.<owner>`, or null.
 *  The trusted reader is a SINGLE consumer over `dinbox.>` (all owners), so it recovers the per-message
 *  owner from the subject (the routing token is `routeToken(owner)` — an nkey, a `token()` no-op). */
export function parseDinboxOwner(subject: string): string | null {
  const parts = subject.split(".");
  // cotal.<space>.dinbox.<owner>
  return parts.length === 4 && parts[0] === ROOT && parts[2] === "dinbox" ? parts[3] : null;
}

/** An agent's bind-only per-owner consumer on {@link dlvStream} (filter `dlv.<owner>`). */
export function dlvDurable(owner: string): string {
  return `dlv_${token(owner)}`;
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
 *  now a native core subscription. */
export function chatDurable(instance: string): string {
  return `chat_${token(instance)}`;
}

/** Consumer name for an instance's short-lived chat **history** reads (join-backfill, focus-recall,
 *  drop-marker). A single per-instance name, scoped to the agent's own id so its create/info/fetch/
 *  delete grants name-scope to that id — a peer can never bind it — while the per-read single
 *  `filter_subject` is what the create-time ACL pins to `allowSubscribe`. */
export function chatHistDurable(instance: string): string {
  return `chathist_${token(instance)}`;
}

/** Durable consumer name for an instance's private DM inbox. */
export function dmDurable(instance: string): string {
  return `dm_${token(instance)}`;
}

/** Durable consumer name (shared across instances of a role) for the task queue. */
export function taskDurable(service: string): string {
  return `svc_${token(service)}`;
}
