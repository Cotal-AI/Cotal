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

/** Durable consumer name for an instance's view of the chat stream — its live tail. */
export function chatDurable(instance: string): string {
  return `chat_${token(instance)}`;
}

/** Consumer name for an instance's short-lived chat **history** reads (join-backfill, focus-recall,
 *  drop-marker). A single per-instance name (not the live `chat_<id>`) so its create/info/fetch/
 *  delete grants are name-scoped to the agent's own id — a peer can never bind it — while the
 *  per-read single `filter_subject` is what the create-time ACL pins to `allowSubscribe`. */
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
