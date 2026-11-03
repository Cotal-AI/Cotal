/** Why `text`, a file read as UTF-8, cannot be read, when the file was saved as UTF-16, as Windows
 *  PowerShell 5.1 writes files by default; undefined otherwise. Read as UTF-8, its byte-order mark is
 *  two replacement characters and each ASCII letter is followed by a NUL, so a reader that parsed it
 *  would report whatever that text happens to fail instead of its encoding. */
export function utf16Problem(text: string): string | undefined {
  return text.startsWith("��") || text.includes("\u0000") ? "it is saved as UTF-16, and Cotal reads only UTF-8" : undefined;
}
