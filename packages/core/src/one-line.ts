/** A character shown as an escape: a control, a line or paragraph separator, or a format character
 *  with no glyph of its own. `Bidi_Control` is already inside the default-ignorable set, so it is not
 *  named again. A combining mark is not in this class: it draws on a visible base, and the same
 *  property carries the marks of ordinary written language. A character of this class that belongs to
 *  a grapheme with an emoji, such as the joiner inside an emoji sequence or U+FE0F on U+2764,
 *  stays, because escaping it would split a character the reader can see. One that stands alone, or
 *  that sits on a letter and adds nothing the reader can see, is escaped. */
const HIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{gc=Cf}]/gu;
const EMOJI = /\p{Emoji}/u;
const GRAPHEME = new Intl.Segmenter(undefined, { granularity: "grapheme" });
interface Span { index: number; end: number }

/** The graphemes of `text` that hold an emoji and more than that character. A hidden character
 *  inside one stays, because it belongs to a character the reader can see. A letter does not: a
 *  joiner or a selector on one adds nothing the reader can see. */
function kept(text: string): Span[] {
  return [...GRAPHEME.segment(text)].flatMap((part) =>
    part.segment.length > 1 && EMOJI.test(part.segment) ? [{ index: part.index, end: part.index + part.segment.length }] : []);
}

/** The `\uXXXX` form of one matched character, or the character itself when `kept` covers `at`. */
function escaped(ch: string, at: number, spans: Span[]): string {
  if (spans.some((span) => span.index <= at && at < span.end)) return ch;
  let out = "";
  for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
  return out;
}

/** `text` on one line, with every character of {@link HIDDEN} shown as a `\uXXXX` escape. A value
 *  interpolated into operator output, such as a path, a name or an error message, can carry a newline;
 *  written raw it ends that line early and starts a second one that reads as its own record, a carriage
 *  return or an escape sequence rewrites the terminal, a bidirectional override reorders what is shown,
 *  and a format character such as U+200B prints as nothing, so a refused name reads as a valid one. */
export function oneLine(text: string): string {
  const spans = kept(text);
  return text.replace(HIDDEN, (ch, at: number) => escaped(ch, at, spans));
}

/** ` (it contains U+XXXX)` for the first character {@link oneLine} escapes in `value`, else `""`. */
export function hiddenNote(value: string): string {
  const spans = kept(value);
  for (const match of value.matchAll(HIDDEN)) {
    const ch = match[0], at = match.index ?? 0;
    if (escaped(ch, at, spans) !== ch) return ` (it contains U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`;
  }
  return "";
}

/** `value` as a message repeats it: whole up to `max` characters, else its first `max` and its length,
 *  as `abc… (100000 characters)`, so an over-long argument does not fill the terminal with one line.
 *  It bounds what is shown only; the caller still checks and uses the value whole. */
export function boundedValue(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max).join("")}… (${chars.length} characters)` : value;
}
