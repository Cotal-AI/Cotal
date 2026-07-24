import type { PresenceStatus } from "@cotal-ai/core";
import { c } from "@cotal-ai/workspace";

// The ANSI helpers moved into `@cotal-ai/workspace` (stage 4), shared with @cotal-ai/web.
// Re-exported so the CLI's many importers keep resolving them from here.
export { c, color256 } from "@cotal-ai/workspace";

export function statusBadge(status: PresenceStatus): string {
  switch (status) {
    case "working":
      return c.green("● working");
    case "waiting":
      return c.yellow("◐ waiting");
    case "idle":
      return c.gray("○ idle");
    case "offline":
      return c.dim("⨯ offline");
  }
}

/** Compact relative time for `last seen` on offline roster rows — presence retains the last
 *  heartbeat `ts` (and activity) on offline by design, so the row must say how dead it is instead
 *  of reading like a live one. Pure (injectable clock) so display stays unit-assertable; a future
 *  `ts` (clock skew) renders as "just now", never negative; a non-finite or non-positive `ts`
 *  (nothing legitimate produces one — every writer stamps Date.now()) reads "unknown", never
 *  "NaNd ago" or an epoch-sized day count. */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "unknown";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The one offline-row qualifier every roster surface shares: how dead (`last seen <relative>`)
 *  plus what it was doing (`was: <activity>`, only when an activity was retained). Callers add
 *  their own prefix/dimming; the format lives here so the surfaces can't drift apart. */
export function offlineDetail(p: { ts: number; activity?: string }): string {
  return `last seen ${relativeTime(p.ts)}${p.activity ? ` · was: ${p.activity}` : ""}`;
}

/** A follow-up hint for failures whose signature is stale on-disk broker state: streams/durable
 *  consumers minted by an older, incompatible Cotal generation survive every down/up cycle, and
 *  JetStream rejects a same-name re-create with a different config. Rendered dim under the red
 *  line by the error surfaces - the error itself stays the broker's own sentence. */
export function staleStoreHint(msg: string): string | undefined {
  // The recipe must not promise a configuration-preserving restart: a bare `cotal up` would turn
  // a named/open/user-auth mesh into the default authenticated one, and a custom --store-dir is
  // not recorded - so both variable parts are called out instead of implied.
  return /consumer already exists|stream already exists/i.test(msg)
    ? "likely stale on-disk mesh state from an older Cotal version - reset: cotal down, cotal clean store --force (repeat any custom --store-dir), then `cotal up` with your usual flags"
    : undefined;
}
