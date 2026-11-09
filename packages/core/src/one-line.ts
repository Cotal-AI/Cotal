/** A character shown as an escape: a control, a line or paragraph separator, or a format character
 *  with no glyph of its own. `Bidi_Control` is already inside the default-ignorable set, so it is not
 *  named again. A join control is not in this class: U+200D holds an emoji sequence together, and
 *  escaping it would split a character the reader can see. A combining mark is not in it either: it
 *  draws on a visible base, and the same property carries the marks of ordinary written language. */
const HIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{gc=Cf}]/gu;
const JOIN_CONTROL = /^\p{Join_Control}/u;

/** The `\uXXXX` form of one matched character, or the character itself when it is a join control. */
function escaped(ch: string): string {
  if (JOIN_CONTROL.test(ch)) return ch;
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
  return text.replace(HIDDEN, escaped);
}

/** ` (it contains U+XXXX)` for the first character {@link oneLine} escapes in `value`, else `""`. */
export function hiddenNote(value: string): string {
  for (const ch of value.match(HIDDEN) ?? []) {
    const shown = escaped(ch);
    if (shown !== ch) return ` (it contains U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`;
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
