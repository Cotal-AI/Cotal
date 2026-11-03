// How long ago something happened, as the short text the dashboard puts before "ago".

/** An elapsed time in milliseconds as `2s`, `5m`, `3h` or `4d`: the largest whole unit it reaches.
 *  A negative span (a heartbeat stamped by a clock ahead of this page's) reads `0s`, since nothing
 *  happens before it was reported. */
export function ageText(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
