import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { localRecordAccess, oneLine } from "@cotal-ai/workspace";

export type LogStart = { offset: number; dev: number; ino: number };

/** A log this account may read and append to. Windows protects it with the access list Cotal sets
 *  when it creates the file and has no POSIX owner or mode to check, as for every local record. */
export const privateLog = (info: Stats) => info.isFile() && (localRecordAccess() === "windows-acl" || info.uid === process.getuid!() && (info.mode & 0o077) === 0);

/** The last line an owned private log holds past byte `from`, as one bounded line of operator output,
 *  or undefined when nothing was logged there or the log cannot be read as an owned file. A started
 *  manager also pins the file identity and accepts only an error line, never its console URL. */
export function lastLoggedLine(path: string, from: number, started?: LogStart): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    const info = fstatSync(fd);
    if (!privateLog(info) || info.size <= from) return undefined;
    if (started && (info.dev !== started.dev || info.ino !== started.ino)) return undefined;
    const length = Math.min(info.size - from, 8192), bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const count = readSync(fd, bytes, read, length - read, info.size - length + read); if (!count) break; read += count; }
    const line = bytes.subarray(0, read).toString("utf8").split("\n").map((text) => text.trim()).filter(Boolean).pop();
    if (started && (!line || !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+)?✗\s/.test(stripVTControlCharacters(line)))) return undefined;
    return line ? oneLine(quotedLine(line)) : undefined;
  } catch { return undefined; } finally { closeSync(fd); }
}

/** `line` as a refusal quotes it: whole up to 1000 characters, which holds a failure line with its
 *  causes. A longer one keeps its last `; next:` step, when that step is shorter than that, and as
 *  much of its start as the rest holds, with the line's length where the middle was cut, so the
 *  quote still ends in the step to take. */
function quotedLine(line: string): string {
  const max = 1000, chars = [...line];
  if (chars.length <= max) return line;
  const at = line.lastIndexOf("; next: "), step = at < 0 ? [] : [...line.slice(at)];
  const kept = step.length < max ? step : [];
  return `${chars.slice(0, max - kept.length).join("")}… (${chars.length} characters)${kept.join("")}`;
}
