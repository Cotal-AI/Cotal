import { oneLine } from "./one-line.js";

/** The most characters a presence row shows of one peer-written text. */
const PRESENCE_TEXT_MAX = 200;

/** A condition code or an activity as a presence row shows it: on one line ({@link oneLine}) and at
 *  most {@link PRESENCE_TEXT_MAX} characters. The peer a row describes writes both and nothing checks
 *  them on ingest, while readers print one peer per line: a line break would start what reads as a
 *  second peer's row, and a 4000-character activity would flood the reader's view. A non-string is
 *  converted as interpolation converts it, so one malformed row cannot make a reader throw. */
export function presenceText(text: string): string {
  const chars = [...oneLine(String(text))];
  return chars.length > PRESENCE_TEXT_MAX ? `${chars.slice(0, PRESENCE_TEXT_MAX - 1).join("")}…` : chars.join("");
}
