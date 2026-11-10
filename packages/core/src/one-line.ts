/** `text` with control, format, default-ignorable and Unicode line separator characters shown as
 *  `\uXXXX` escapes. This keeps operator output on one line without hiding characters in a name or
 *  letting them rewrite the terminal. Astral characters leave as two UTF-16 unit escapes. */
export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu, (c) => {
    let escaped = "";
    for (let i = 0; i < c.length; i++) escaped += `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`;
    return escaped;
  });
}

/** `value` as a message repeats it: whole up to `max` characters, else its first `max` and its length,
 *  as `abc… (100000 characters)`, so an over-long argument does not fill the terminal with one line.
 *  It bounds what is shown only; the caller still checks and uses the value whole. */
export function boundedValue(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max).join("")}… (${chars.length} characters)` : value;
}
