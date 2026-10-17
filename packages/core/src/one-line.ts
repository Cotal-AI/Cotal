/** `text` with every control character and Unicode line separator shown as a `\uXXXX` escape. A
 *  value interpolated into one line of operator output, such as a path or an error message, can
 *  carry a newline; written raw it ends that line early and starts a second one that reads as its
 *  own record, or a carriage return overwrites the line on a terminal. */
export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
