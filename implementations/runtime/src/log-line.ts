import { inspect } from "node:util";
import { oneLine } from "@cotal-ai/core";

/** One `log(...)` line as text: strings as written and other values inspected on one line, after the
 *  scope it was written from when that is not the run's root. Control characters are escaped, so a
 *  logged newline cannot start a second line that reads as its own. */
export function logLineText(line: { readonly scope: string; readonly values: readonly unknown[] }): string {
  const text = line.values.map((value) => typeof value === "string" ? value : inspect(value, { depth: 6, breakLength: Infinity })).join(" ");
  return oneLine(line.scope ? `${line.scope} ${text}` : text);
}
