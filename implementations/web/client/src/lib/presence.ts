// The facts a presence row shows under its status, dated the way the CLI dates them.
import type { RosterRow } from "./roster.js";
import { ageText } from "./age.js";

/** The stamps the facts are dated from. A stamp that is not a finite number is no stamp: a record
 *  read from the bucket is unchecked, and `null` would otherwise date from the epoch. A stamp ahead
 *  of this clock is the peer's skew, not a negative age. */
const ageAt = (now: number, at: number | undefined): number | undefined =>
  typeof at === "number" && Number.isFinite(at) ? Math.max(0, now - at) : undefined;

/** The presence facts a row shows: the reported condition and how long it has held, how long the
 *  status has stood, how long ago the agent was last active, and how long ago its activity was set.
 *  Missing stamps stay undated, and a cleared activity, whose stamp stays, dates nothing. Ages floor
 *  to the largest whole unit, as the CLI's do, so a heartbeat 90 seconds old reads `1m`. Plain text;
 *  React escapes it where it lands. Empty when the row reports none of them. */
export function presenceFacts(row: Pick<RosterRow, "condition" | "statusSince" | "activity" | "activitySince" | "activeAt">, now: number): string {
  const facts: string[] = [];
  const conditionFor = ageAt(now, row.condition?.since);
  if (row.condition) facts.push(`${row.condition.code}${conditionFor === undefined ? "" : ` for ${ageText(conditionFor)}`}`);
  const standing = ageAt(now, row.statusSince);
  if (standing !== undefined) facts.push(`unchanged for ${ageText(standing)}`);
  const active = ageAt(now, row.activeAt);
  if (active !== undefined) facts.push(`active ${ageText(active)} ago`);
  const activity = row.activity ? ageAt(now, row.activitySince) : undefined;
  if (activity !== undefined) facts.push(`activity set ${ageText(activity)} ago`);
  return facts.join(" · ");
}
