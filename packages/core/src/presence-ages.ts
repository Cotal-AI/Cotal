import type { Presence, PresenceCondition } from "./types.js";

/** The stamps a presence row is dated from. Structural, so a manager row that projects only
 *  `condition` and `activeAt` from presence is dated by the same rule. */
export type PresenceStamps = Pick<Presence, "statusSince" | "activity" | "activitySince" | "activeAt"> & {
  condition?: Pick<PresenceCondition, "since">;
};

/** The ages, in ms, a presence row shows, keyed by the stamp each one measures: how long the
 *  condition has held, how long the status has stood, how long ago the activity was set, and how
 *  long ago the last work event was. */
export interface PresenceAges {
  conditionSince?: number;
  statusSince?: number;
  activitySince?: number;
  activeAt?: number;
}

/** The ages a row dated at `now` must show. Every surface that prints a presence row words these
 *  itself; which facts carry an age, and which stamps count, is decided here so that no surface
 *  re-derives it. */
export function presenceAges(p: PresenceStamps, now: number): PresenceAges {
  return {
    conditionSince: ageAt(now, p.condition?.since),
    statusSince: ageAt(now, p.statusSince),
    // An activity's age dates the activity, so a cleared activity, whose stamp stays, shows none.
    activitySince: p.activity ? ageAt(now, p.activitySince) : undefined,
    activeAt: ageAt(now, p.activeAt),
  };
}

/** Compact age: `12s`, `47m`, `3h`, `2d`, floored to the largest whole unit. */
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** A presence record is parsed from the bucket unchecked, so anything but a finite number is no
 *  stamp: the subtraction would date `null` from the epoch, render a string as `NaNd`, and render
 *  an exponent literal such as `1e400`, which parses to an infinity, as `0s` or `Infinityd`. A
 *  stamp ahead of this clock is the peer's clock skew, not a negative age. */
function ageAt(now: number, at: number | undefined): number | undefined {
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return Math.max(0, now - at);
}
