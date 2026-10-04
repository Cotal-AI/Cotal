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
 * finishes its work, and a run that would exit 0 exits 1, so the loss is never silent. The bound:
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
 *  through its callback, which Node runs before the stream emits `error`. */
function send(stream: NodeJS.WriteStream, text: string, onFail: (failure: unknown) => void): void {
  let failed = false;
  const fail = (failure: unknown): void => {
    if (failed) return;
    failed = true;
    onFail(failure);
  };
  try {
    stream.write(text, (e) => {
      if (e) fail(e);
    });
  } catch (e) {
    fail(e);
    return;
  }
  if (stream.errored) fail(stream.errored);
}

/** Neither channel carried a line, so the exit status is the only signal left. Set at exit, so it
 *  also holds when the command later resets `exitCode` or the CLI's stdout EPIPE handler exits 0. */
function lost(): void {
  if (unsaid) return;
  unsaid = true;
  process.on("exit", (code) => {
    if (code === 0) process.exitCode = 1;
  });
}
