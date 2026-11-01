import { formatAge, presenceAges, presenceText, type PresenceStamps, type PresenceStatus } from "@cotal-ai/core";
import { c } from "@cotal-ai/workspace";

// The ANSI helpers and the stderr line wrapper moved into `@cotal-ai/workspace`, shared with
// @cotal-ai/web and the manager. Re-exported so the CLI's many importers keep resolving them from here.
export { c, color256, hang, stderrLine } from "@cotal-ai/workspace";

/** A presence status in words, after its mark unless `marks` is false. */
export function statusBadge(status: PresenceStatus, marks = true): string {
  const mark = (glyph: string): string => (marks ? `${glyph} ` : "");
  switch (status) {
    case "working":
      return c.green(`${mark("●")}working · progress unknown`);
    case "waiting":
      return c.yellow(`${mark("◐")}waiting`);
    case "idle":
      return c.gray(`${mark("○")}idle`);
    case "offline":
      return c.dim(`${mark("⨯")}offline`);
  }
}

type DatedRow = PresenceStamps & { condition?: { code: string } };

/** The facts a status word needs beside it (#618): the harness-reported condition and how long it has
 *  held, then how long the status has stood (#578) and the age of the seat's last harness-reported
 *  work event (`activeAt`). A failure 3s old and one 40m old, or a turn that stopped advancing and one
 *  that is advancing, no longer render alike. The seat reports `activeAt` itself, so the status word
 *  keeps its own progress wording. Unstyled, because the console styles them with Ink, where an ANSI
 *  reset inside the text would end a highlighted row's styling. */
export function presenceFacts(p: DatedRow, now = Date.now()): { condition: string; ages: string } {
  const age = presenceAges(p, now);
  const condition = p.condition ? ` (${presenceText(p.condition.code)}${age.conditionSince === undefined ? "" : ` for ${formatAge(age.conditionSince)}`})` : "";
  const unchanged = age.statusSince === undefined ? "" : ` · unchanged for ${formatAge(age.statusSince)}`;
  const active = age.activeAt === undefined ? "" : ` · active ${formatAge(age.activeAt)} ago`;
  return { condition, ages: unchanged + active };
}

/** {@link presenceFacts} for ANSI output, with the ages dimmed. */
export function presenceDetail(p: DatedRow, now = Date.now()): string {
  const { condition, ages } = presenceFacts(p, now);
  return condition + (ages && c.dim(ages));
}

/** The age that follows an activity (#544): a hook flips the status every turn and leaves the
 *  activity alone, so the status age cannot date it. */
export function activityAge(p: PresenceStamps, now = Date.now()): string {
  const age = presenceAges(p, now).activitySince;
  return age === undefined ? "" : ` (set ${formatAge(age)} ago)`;
}

/** The dimmed ` - <activity> (set <age> ago)` an ANSI presence line ends with after
 *  {@link presenceDetail}, or nothing when the seat reports no activity. `cotal endpoints`, `cotal who`
 *  and the console's Ink rows lay the activity out on their own, over the same text and age. */
export function activityDetail(p: PresenceStamps, now = Date.now()): string {
  return p.activity ? c.dim(" - " + presenceText(p.activity) + activityAge(p, now)) : "";
}

