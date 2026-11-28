import { inspect } from "node:util";
import { oneLine } from "@cotal-ai/core";

/**
 * The most characters one printed log line carries. A program may log a string of four million
 * units, and the host writes each line to a stream that may be a pipe: node buffers what a pipe has
 * not taken yet in this process's memory, so 400 such lines from a loop were 6 GB here before the
 * cap (measured through `cotal run start --local`). A longer line is cut, with its length named, so
 * the trace still says what was logged and how big it was.
 */
export const MAX_LOG_LINE_CHARS = 16_384;

/** One `log(...)` line as text: strings as written and other values inspected on one line, after the
 *  scope it was written from when that is not the run's root. Control characters are escaped, so a
 *  logged newline cannot start a second line that reads as its own. A line over
 *  {@link MAX_LOG_LINE_CHARS} is cut there, with its full length named. */
export function logLineText(line: { readonly scope: string; readonly values: readonly unknown[] }): string {
  const parts: string[] = [];
  let total = 0;
  for (const value of line.values) {
    const text = typeof value === "string" ? value : inspect(value, { depth: 6, breakLength: Infinity, maxStringLength: MAX_LOG_LINE_CHARS });
    total += text.length + (parts.length > 0 ? 1 : 0);
    if (parts.join(" ").length < MAX_LOG_LINE_CHARS) parts.push(text.length > MAX_LOG_LINE_CHARS ? text.slice(0, MAX_LOG_LINE_CHARS) : text);
  }
  let text = parts.join(" ");
  if (total > MAX_LOG_LINE_CHARS) text = `${text.slice(0, MAX_LOG_LINE_CHARS)}… (${total} characters)`;
  return oneLine(line.scope ? `${line.scope} ${text}` : text);
}

/**
 * Write one line to `stream` and answer when the stream has taken it: at once while the stream has
 * room, after its next `drain` when it is holding more than its high-water mark. A run's thread waits
 * on that answer once its own lines in flight pass their bound, so a program that logs in a loop is
 * paced by whatever reads the stream, not buffered in this process (a pipe nobody reads fast enough
 * held 1.6 GB of lines in node's write queue before this, measured).
 */
export function writeLine(stream: NodeJS.WritableStream & { writableNeedDrain?: boolean }, text: string): Promise<void> | undefined {
  const room = stream.write(`${text}\n`);
  if (room) return undefined;
  return new Promise<void>((resolve) => stream.once("drain", () => resolve()));
}
