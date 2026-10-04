/**
 * One consistent voice for CLI provenance, on stderr: which on-disk source a command RESOLVED
 * its configuration from, and what it WROTE where. Commands must never silently pick up state
 * from a directory or silently drop files — every read of config (persona file, mesh entry,
 * config.json layer) and every write (creds, seeded files) gets one dim arrow line. stderr so
 * it never pollutes machine-readable stdout; plain text so this layer needs no color dep.
 *
 * Failure policy: a line reports an act that already happened, so a fault on stderr must neither
 * fail that act nor drop the line unsaid. When the stderr write throws or fails (EPIPE, ENOSPC,
 * EIO), at once or after waiting in a full pipe, the line is written to stdout instead with the
 * error named, and the stream's deferred `error` event is absorbed so it cannot crash the command
 * after its write. If stdout fails too, no channel is left to carry the line: the command still
 * finishes its work, and a run that would exit 0 exits 1, so the loss is never silent. A line still
 * waiting in a full pipe when the process exits, as when the CLI exits at once on a closed stdout,
 * is lost the same way and counts the same. The bound:
 * a stderr closed before the process starts is reopened by Node on /dev/null, which looks the same
 * as an operator's `2>/dev/null`, so the line is discarded where the operator sent it.
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

let absorbing = false;
let unsaid = false;
let watching = false;
/** Writes still waiting in a full pipe: neither finished nor failed. An exit drops them unwritten. */
const waiting = new Set<{ stream: NodeJS.WriteStream }>();

/** Write one provenance line under the failure policy above: on stderr, else on stdout with the
 *  stderr error named, else counted as unsaid. A thrown value need not be an Error (`throw null`). */
function say(line: string): void {
  send(process.stderr, `${line}\n`, (failure) => {
    if (!absorbing) {
      absorbing = true;
      process.stderr.on("error", () => {}); // reported below; without a listener Node exits 1 on it
    }
    const e = failure as Partial<NodeJS.ErrnoException> | null | undefined;
    send(process.stdout, `${line} (stderr failed: ${e?.code ?? e?.message ?? String(failure)})\n`, lost);
  });
}

/** Write `text` to `stream`, calling `onFail` at most once if the write fails. A write can fail
 *  before it returns: it throws, or the stream is already `errored` (one that failed earlier in the
 *  same tick buffers the text and then drops it). A write left pending in a full pipe fails later,
 *  through its callback, which Node runs before the stream emits `error`; until it settles it is
 *  `waiting`. One that left nothing buffered was written, though its callback runs on a later tick. */
function send(stream: NodeJS.WriteStream, text: string, onFail: (failure: unknown) => void): void {
  const write = { stream };
  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    waiting.delete(write);
    return true;
  };
  try {
    stream.write(text, (e) => {
      if (settle() && e) onFail(e);
    });
  } catch (e) {
    if (settle()) onFail(e);
    return;
  }
  if (stream.errored) {
    if (settle()) onFail(stream.errored);
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
 *  still queued, so it does not count. Set at exit, so it also holds when the command later resets
 *  `exitCode` or the CLI's stdout EPIPE handler exits 0. */
function watchExit(): void {
  if (watching) return;
  watching = true;
  process.on("exit", (code) => {
    for (const w of waiting) if (w.stream.writableLength > 0) unsaid = true;
    if (unsaid && code === 0) process.exitCode = 1;
  });
}
