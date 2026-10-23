import { formatAge, presenceAges, presenceText, type PresenceStamps, type PresenceStatus } from "@cotal-ai/core";
import { c, findCotalRoot, localeIsUtf8, plainPunctuation, readMaintenanceJournal, terminalWidth, wrapWords } from "@cotal-ai/workspace";

// The ANSI helpers moved into `@cotal-ai/workspace` (stage 4), shared with @cotal-ai/web.
// Re-exported so the CLI's many importers keep resolving them from here.
export { c, color256 } from "@cotal-ai/workspace";

/** `prefix` then `text` wrapped to `width`, each continuation line indented under the text, each
 *  piece painted on its own. */
export function hang(prefix: string, text: string | readonly string[], width: number, paint: (s: string) => string = (s) => s): string[] {
  return wrapWords(text, width - prefix.length).map((piece, i) => (i === 0 ? prefix : " ".repeat(prefix.length)) + paint(piece));
}

/** A `✗` failure or `↳` hint on stderr, wrapped at spaces to the terminal, each continuation line
 *  under the text. Under a locale that is not UTF-8 it is written as plain writes it: `!` for the
 *  failure mark and the punctuation in ASCII. */
export function stderrLine(prefix: string, text: string, paint: (s: string) => string): void {
  const ascii = !localeIsUtf8();
  const lead = ascii ? plainPunctuation(prefix.replace("✗", "!")) : prefix;
  for (const line of hang(lead, ascii ? plainPunctuation(text) : text, terminalWidth(process.stderr))) console.error(paint(line));
}

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

/** A follow-up hint for failures whose signature is stale on-disk broker state: streams/durable
 *  consumers minted by an older, incompatible Cotal generation survive every down/up cycle, and
 *  JetStream rejects a same-name re-create with a different config. Rendered dim under the red
 *  line by the error surfaces - the error itself stays the broker's own sentence. A root whose
 *  maintenance journal holds a restore or a preserved cut gets no clean recipe: its store is that
 *  data, and the hint never names a command that would delete it. */
export function staleStoreHint(msg: string, root?: string): string | undefined {
  if (!/consumer already exists|stream already exists/i.test(msg)) return undefined;
  let held: string | undefined;
  try { held = readMaintenanceJournal(root ?? findCotalRoot())?.state; } catch { held = "unreadable"; }
  if (held) return `this root's maintenance journal holds a restore or a preserved cut (state ${held}), so its store holds that data and must not be cleaned; check it with cotal status before any recovery`;
  // The recipe must not promise a configuration-preserving restart: a bare `cotal up` would turn
  // a named/open/user-auth mesh into the default authenticated one, and a custom --store-dir is
  // not recorded - so both variable parts are called out instead of implied.
  return "likely stale on-disk mesh state from an older Cotal version - reset: cotal down, cotal clean store --force (repeat any custom --store-dir), then `cotal up` with your usual flags";
}
