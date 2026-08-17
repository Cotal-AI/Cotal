/**
 * Peer name resolution + name validation — the client-side half of addressing.
 *
 * The wire routes on the unforgeable instance id (the nkey carried in the subject); a human
 * **name** is only a convenience this resolves to an id. Resolution is deterministic and
 * fail-loud: it returns exactly one peer or throws {@link AmbiguousPeerError} — it never
 * silently picks among same-named peers. The id is authoritative; the name is best-effort.
 *
 * `owner/name` handles (per-owner namespaces) land with the accounts/auth feature; until then
 * `/` is reserved in a name ({@link assertValidName}) so they slot in without a migration.
 * See .internal/plans/peer-addressing.md.
 */
import type { Presence, PresenceStatus } from "./types.js";

/** A peer that matched an ambiguous name — structural, so each surface renders it itself
 *  (core never formats UI strings). The full `id` is the authoritative, routable address. */
export interface PeerCandidate {
  id: string;
  name: string;
  role?: string;
  status: PresenceStatus;
  /** Epoch ms of the peer's last heartbeat. */
  ts: number;
}

/** Thrown when a name resolves to two or more peers that could each be the target. Carries the
 *  candidates structurally so a caller can show them and re-address by the exact `id`. */
export class AmbiguousPeerError extends Error {
  constructor(
    readonly target: string,
    readonly candidates: PeerCandidate[],
  ) {
    super(
      `"${target}" is ambiguous - ${candidates.length} peers share that name: ` +
        candidates.map((c) => `${c.name} (${c.id}, ${c.status})`).join("; ") +
        `. Re-send to the exact instance id.`,
    );
    this.name = "AmbiguousPeerError";
  }
}

function candidate(p: Presence): PeerCandidate {
  return { id: p.card.id, name: p.card.name, role: p.card.role, status: p.status, ts: p.ts };
}

/**
 * Resolve a `target` (an exact instance id, or a display name) to one peer on `roster`.
 *
 * - an exact instance-id match wins (any status — an id is unambiguous);
 * - otherwise a case-insensitive name match, preferring live peers over stale offline ghosts:
 *   one live match resolves; **2+ live matches throw**; with no live match a unique offline peer
 *   resolves (best-effort), but **2+ offline duplicates throw**;
 * - no match → `undefined` (the caller renders "no such peer").
 *
 * `opts.selfId`, when given, is excluded (you don't DM yourself). Throws
 * {@link AmbiguousPeerError} rather than ever silently picking.
 */
export function resolvePeer(
  roster: Presence[],
  target: string,
  opts: { selfId?: string } = {},
): Presence | undefined {
  const peers = opts.selfId ? roster.filter((p) => p.card.id !== opts.selfId) : roster;

  const byId = peers.find((p) => p.card.id === target);
  if (byId) return byId;

  const want = target.trim().toLowerCase();
  if (!want) return undefined;
  const matches = peers.filter((p) => p.card.name.toLowerCase() === want);
  if (matches.length === 0) return undefined;

  const live = matches.filter((p) => p.status !== "offline");
  const pool = live.length > 0 ? live : matches;
  if (pool.length === 1) return pool[0];
  throw new AmbiguousPeerError(target, pool.map(candidate));
}

/**
 * Is every UTF-16 surrogate in `s` properly paired?
 *
 * `String.prototype.isWellFormed()` does exactly this, but it is ES2024 and this package targets an
 * earlier lib; raising the target repo-wide to gain one predicate would be a build-config change
 * reaching every package, for a check that is eight lines here. A high surrogate must be followed by
 * a low one, and a low surrogate must not appear on its own.
 */
function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return false; // a low surrogate reached without its high
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false; // high surrogate unpaired (or at end: NaN)
      i++; // consume the pair
    }
  }
  return true;
}

/**
 * Validate a display name. A name must be non-empty, single-line, and free of surrounding
 * whitespace; `/` is reserved as the future `owner/name` separator (and already means "a path"
 * to the agent-file loader). Throws — no silent rewrite (per AGENTS.md, no fallbacks). Internal
 * spaces are allowed (human display names like "Ada Lovelace").
 */
export function assertValidName(name: string): void {
  if (name.length === 0 || name !== name.trim())
    throw new Error(`invalid name ${JSON.stringify(name)}: must be non-empty with no surrounding whitespace`);
  if (/[\r\n]/.test(name))
    throw new Error(`invalid name ${JSON.stringify(name)}: must be a single line`);
  if (name.includes("/"))
    throw new Error(`invalid name ${JSON.stringify(name)}: "/" is reserved (the owner/name separator)`);
  if (name.includes("\\"))
    throw new Error(`invalid name ${JSON.stringify(name)}: "\\" is reserved (a Windows path separator)`);
  // A name must be well-formed UTF-16 — no unpaired surrogate. This is an IDENTITY rule, not a
  // tidiness one, and it is here at the shared choke point rather than at one consumer.
  //
  // An unpaired surrogate cannot be encoded as UTF-8: every encoder replaces it with U+FFFD. So the
  // moment a name crosses any UTF-8 boundary, DISTINCT names become the SAME bytes. Two consequences
  // were measured on this repo, and both are silent:
  //   - `createHash().update(name)` hashes the replaced bytes, so "\uD800", "\uD801" and "\uFFFD"
  //     produce one digest — and any identifier derived from that digest merges the three principals.
  //   - the launch environment normalizes the name on the way to a child process, so the child's
  //     idea of its own name can differ from the parent's while both believe they agree.
  // Refusing here is the only fix that covers both; a consumer that hashes injectively still cannot
  // stop the name itself from changing shape as it crosses a process boundary.
  if (!isWellFormedUtf16(name))
    throw new Error(
      `invalid name ${JSON.stringify(name)}: contains an unpaired UTF-16 surrogate. Such a name ` +
        `cannot survive UTF-8 encoding — it is replaced with U+FFFD — so distinct names would ` +
        `silently become one identity.`,
    );
}
