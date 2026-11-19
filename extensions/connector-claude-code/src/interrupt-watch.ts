import { constants, statSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { userInterrupt, type ClaudeEntry } from "./agui-map.js";

/** How often the transcript of an open turn is checked for growth. */
const POLL_MS = 1_000;
const READ_BYTES = 64 * 1024;

/** True when one transcript line is Claude Code's record of its user interrupting the turn. */
function interrupted(line: string): boolean {
  if (!line.includes("[Request interrupted by user")) return false;
  try {
    return userInterrupt(JSON.parse(line) as ClaudeEntry) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Watch a Claude Code transcript for an interrupt of the turn that is open now.
 *
 * Claude Code fires no hook when its user interrupts a turn, so a seat that waited for one stayed
 * `working` until its next turn ended. The transcript does record the interrupt, as a `user` entry
 * (see `userInterrupt`). This reads every complete line written after the call and calls
 * `onInterrupt` once, at the first interrupt record. A transcript Claude has not created yet is read
 * from its start once it appears. `watchFile` polls, so it also sees a file that does not exist yet.
 *
 * @returns a function that stops the watch.
 */
export function watchForInterrupt(path: string, onInterrupt: () => void): () => void {
  let offset = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  let partial = Buffer.alloc(0);
  let state: "idle" | "reading" | "again" | "stopped" = "idle";

  const stop = (): void => {
    state = "stopped";
    unwatchFile(path, changed);
  };

  /** Reads from `offset` to the end. A change while a read runs is read after it, never beside it. */
  const scan = async (): Promise<void> => {
    if (state !== "idle") {
      if (state === "reading") state = "again";
      return;
    }
    state = "reading";
    try {
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        for (;;) {
          const chunk = Buffer.allocUnsafe(READ_BYTES);
          const { bytesRead } = await file.read(chunk, 0, READ_BYTES, offset);
          if (bytesRead === 0 || (state as string) === "stopped") break;
          offset += bytesRead;
          const data = Buffer.concat([partial, chunk.subarray(0, bytesRead)]);
          const end = data.lastIndexOf(10);
          partial = end < 0 ? data : data.subarray(end + 1);
          if (end >= 0 && data.subarray(0, end).toString("utf8").split("\n").some(interrupted)) {
            stop();
            onInterrupt();
            return;
          }
        }
      } finally {
        await file.close();
      }
    } catch (e) {
      // A transcript that is not there yet is read once it appears. Anything else ends the watch,
      // and the turn then ends at its next hook as before.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") stop();
    }
    if ((state as string) === "again") {
      state = "idle";
      return scan();
    }
    if ((state as string) === "reading") state = "idle";
  };

  function changed(curr: Stats): void {
    if (curr.size > offset) void scan();
  }

  watchFile(path, { persistent: false, interval: POLL_MS }, changed);
  // A line written between the size read above and the watch's own first stat changes nothing the
  // watch compares against, so one read now covers it.
  void scan();
  return stop;
}
