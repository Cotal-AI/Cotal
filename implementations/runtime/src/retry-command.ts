import { oneLine, shellPath } from "@cotal-ai/workspace";

/** Bash ANSI-C quoting keeps even multiline arguments copyable on one line. */
export function retryWord(value: string): string {
  return oneLine(value) === value ? shellPath(value)
    : `$'${[...value].map((ch) => oneLine(ch) !== ch ? `\\U${ch.codePointAt(0)!.toString(16).padStart(8, "0")}` : ch.replace(/[\\']/g, "\\$&")).join("")}'`;
}
