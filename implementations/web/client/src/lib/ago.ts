// How long ago something happened, as the panel and the Agents view write it. Pure: no window, no
// document, no I/O.

/** `ms` as "2s ago", "5m ago", "3h ago" or "2d ago", in the largest whole unit. A negative age (a
 *  clock that runs ahead) reads as now, "0s ago". An age that is not a number reads as undefined, so
 *  the caller says nothing rather than a made-up time. */
export function ago(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
