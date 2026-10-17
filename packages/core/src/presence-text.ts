import { oneLine } from "./one-line.js";

/** The most characters a presence row shows of one peer-written text. */
const PRESENCE_TEXT_MAX = 200;

/** A condition code or an activity as a presence row shows it: on one line ({@link oneLine}) and at
 *  most {@link PRESENCE_TEXT_MAX} characters. The peer a row describes writes both and nothing checks
 *  them on ingest, while readers print one peer per line: a line break would start what reads as a
 *  second peer's row, and a 4000-character activity would flood the reader's view. A non-string is
 *  converted as interpolation converts it, so a numeric code still prints. */
export function presenceText(text: string): string {
  // Escaped one character at a time so a cut falls between escapes: a cut inside one would show a
  // bare `\u00` that no longer names the character it replaced.
  const shown = Array.from(String(text), oneLine);
  const width = (s: string) => [...s].length;
  if (shown.reduce((n, s) => n + width(s), 0) <= PRESENCE_TEXT_MAX) return shown.join("");
  let kept = "";
  let n = 0;
  for (const s of shown) {
    n += width(s);
    if (n > PRESENCE_TEXT_MAX - 1) break;
    kept += s;
  }
  return `${kept}…`;
}
