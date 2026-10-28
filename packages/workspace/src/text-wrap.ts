import stringWidth from "string-width";

/** The columns `text` occupies on a terminal: grapheme clusters, wide East Asian and emoji
 *  characters as two, combining marks and zero-width characters as none, ANSI sequences as none. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

/** `command` as a sentence names it: between backticks or, when it holds a backtick itself, as a
 *  quoted path can, between a run of backticks one longer than any run it holds, as Markdown writes
 *  such code. A command starts with its program and the CLI quotes any argument that holds a
 *  backtick, so it neither starts nor ends with one. */
export function codeSpan(command: string): string {
  const fence = "`".repeat(Math.max(0, ...(command.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence}${command}${fence}`;
}

/** `text` split at spaces into the words {@link wrapWords} breaks between. A span in backticks, from
 *  its opening run of backticks to the next run of as many, is one word, so no line holds part of it,
 *  whatever it starts with and whatever words it holds. A line that starts with a command outside
 *  backticks, as a usage line or a code line does, wraps at its spaces. */
function wrapUnits(text: string): string[] {
  const parts = text.split(" "), words: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let end = i;
    const open = /^[("']*(`+)[^`]*$/.exec(parts[i]!);
    if (open) {
      const fence = new RegExp(`(?<!\`)\`{${open[1]!.length}}(?!\`)`);
      const close = parts.findIndex((part, j) => j > i && fence.test(part));
      if (close > 0) end = close;
    }
    words.push(parts.slice(i, end + 1).join(" "));
    i = end;
  }
  return words;
}

/** `text` in lines of at most `width` display columns, broken at spaces, or only between the given
 *  words. A word wider than `width` keeps a line of its own, so an identity, path or command is never
 *  split. Below 20 columns, and when the output is not a terminal, nothing is wrapped. */
export function wrapWords(text: string | readonly string[], width: number): string[] {
  const words = typeof text === "string" ? wrapUnits(text) : text;
  if (!(width >= 20) || displayWidth(words.join(" ")) <= width) return [words.join(" ")];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && displayWidth(next) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);
  return lines;
}

/** The columns a stream can show: its terminal's width, or unbounded when it is not a terminal. */
export function terminalWidth(stream: { readonly isTTY?: boolean; readonly columns?: number }): number {
  return stream.isTTY && stream.columns ? stream.columns : Number.POSITIVE_INFINITY;
}
