/** `text` with every control character, Unicode line separator and bidirectional control shown as a
 *  `\uXXXX` escape. A value interpolated into one line of operator output, such as a path, a name or
 *  an error message, can carry a newline; written raw it ends that line early and starts a second one
 *  that reads as its own record, a carriage return or an escape sequence rewrites the terminal, and a
 *  bidirectional override reorders what is shown. */
export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** `value` as a message repeats it: whole up to `max` characters, else its first `max` and its length,
 *  as `abc… (100000 characters)`, so an over-long argument does not fill the terminal with one line.
 *  It bounds what is shown only; the caller still checks and uses the value whole. */
export function boundedValue(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max).join("")}… (${chars.length} characters)` : value;
}
