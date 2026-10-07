import { oneLine } from "./one-line.js";

/**
 * One consistent voice for CLI provenance, on stderr: which on-disk source a command RESOLVED
 * its configuration from, and what it WROTE where. Commands must never silently pick up state
 * from a directory or silently drop files — every read of config (persona file, mesh entry,
 * config.json layer) and every write (creds, seeded files) gets one dim arrow line. stderr so
 * it never pollutes machine-readable stdout; plain text so this layer needs no color dep.
 *
 * One call is one line whatever its arguments hold. A path can carry a newline, and written raw it
 * would let one call announce a second act the command never made, or a carriage return overwrite
 * the act it did make. So every control character and Unicode line separator in the line is shown
 * as a `\uXXXX` escape instead.
 *
 * Failure policy: a line reports an act that already happened, so a fault on stderr must neither
 * fail that act nor drop the line unsaid. When the stderr write throws or fails (EPIPE, ENOSPC,
 * EIO), at once or after waiting in a full pipe, the line is written to stdout instead with the
 * error named. If stdout fails too, no channel is left to carry the line, and a run that would exit
 * 0 exits 1, so the loss is never silent. The deferred `error` event of a stream that failed a line
 * is absorbed, so it cannot crash the command after its write and the command finishes its work,
 * unless the program's own listener ends it, as the CLI's does on any stdout error. A line still
 * waiting in a full pipe when the process exits, as when the CLI exits at once on a closed stdout,
 * is lost the same way and counts the same. Node does not say whose bytes a stream still holds, so
 * a line that had to wait and got through just before the exit also counts while later output
 * still waits behind it: the check cannot tell it from a line still waiting, and counts both. The
 * other bound: a stderr closed before the process starts is reopened by Node on /dev/null, which
 * looks the same as an operator's `2>/dev/null`, so the line is discarded where the operator sent it.
 */
export const provenance = {
  /** `→ using <what>: <source>` — the source that WON resolution (say which layer/path). */
  read(what: string, source: string): void {
    say(`→ using ${what}: ${source}`);
  },
  /** `→ wrote <what>: <dest>` — announce every file the command created or replaced. */
  wrote(what: string, dest: string): void {
    say(`→ wrote ${what}: ${dest}`);
  },
  /** `→ removed <what>: <dest>`: announce every file or directory the command DELETED. A silent
   *  delete is worse than a silent write, because the write at least leaves the thing it made while
   *  the delete leaves nothing to notice. Destructive steps get the one line the additive ones get. */
  removed(what: string, dest: string): void {
    say(`→ removed ${what}: ${dest}`);
  },
};

let unsaid = false;
let watching = false;
/** Writes still waiting in a full pipe: neither finished nor failed. An exit drops them unwritten. */
const waiting = new Set<{ stream: NodeJS.WriteStream }>();
/** Streams whose `error` event is absorbed: without a listener Node exits 1 on it. */
const absorbed = new Set<NodeJS.WriteStream>();

/** Write one provenance line under the failure policy above: on stderr, else on stdout with the
 *  stderr error named, else counted as unsaid. The failure name is escaped with the rest, since a
 *  thrown value's message can carry a newline too. */
function say(line: string): void {
  send(process.stderr, `${oneLine(line)}\n`, (failure) => {
    send(process.stdout, `${oneLine(`${line} (stderr failed: ${nameOf(failure)})`)}\n`, lost);
  });
}

/** A thrown value need not be an Error (`throw null`), and naming one must not throw, since that
 *  would interrupt the command this policy keeps running. */
function nameOf(failure: unknown): string {
  try {
    const e = failure as Partial<NodeJS.ErrnoException> | null | undefined;
    return String(e?.code ?? e?.message ?? failure);
  } catch {
    return `unprintable ${typeof failure}`;
  }
}

/** Write `text` to `stream`, calling `onFail` at most once if the write fails and absorbing the
 *  stream's `error` event from then on, since the policy above reports the failure. A write to a
 *  stream already ended fails before it is made: Node refuses it but says so only on a later tick,
 *  which an exit in the same tick never reaches. A write can fail before it returns: it throws, or
 *  the stream is already `errored` (one that failed earlier in the same tick buffers the text and
 *  then drops it). A write left pending in a full pipe fails later, through its callback, which Node
 *  runs before the stream emits `error`; until it settles it is `waiting`. One that left nothing
 *  buffered was written, though its callback runs on a later tick. */
function send(stream: NodeJS.WriteStream, text: string, onFail: (failure: unknown) => void): void {
  const write = { stream };
  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    waiting.delete(write);
    return true;
  };
  const fail = (failure: unknown): void => {
    if (!settle()) return;
    if (!absorbed.has(stream)) {
      absorbed.add(stream);
      stream.on("error", () => {});
    }
    onFail(failure);
  };
  if (stream.writableEnded) {
    fail("write after end");
    return;
  }
  try {
    stream.write(text, (e) => {
      if (e) fail(e);
      else settle();
    });
  } catch (e) {
    fail(e);
    return;
  }
  if (stream.errored) {
    fail(stream.errored);
  } else if (stream.writableLength > 0) {
    waiting.add(write);
    watchExit();
  }
}

/** Neither channel carried a line. */
function lost(): void {
  unsaid = true;
  watchExit();
}

/** The exit status is the only signal left for a line no channel carried, or one still waiting when
 *  the process exits. A waiting write whose stream holds nothing more was flushed with its callback
 *  still queued, so it does not count. One whose stream still holds later bytes may have been
 *  flushed too, and counts. Set at exit, so it also holds when the command later resets
 *  `exitCode` or the CLI's stdout EPIPE handler exits 0. */
function watchExit(): void {
  if (watching) return;
  watching = true;
  process.on("exit", (code) => {
    for (const w of waiting) if (w.stream.writableLength > 0) unsaid = true;
    if (unsaid && code === 0) process.exitCode = 1;
  });
}
