/**
 * One consistent voice for CLI provenance, on stderr: which on-disk source a command RESOLVED
 * its configuration from, and what it WROTE where. Commands must never silently pick up state
 * from a directory or silently drop files — every read of config (persona file, mesh entry,
 * config.json layer) and every write (creds, seeded files) gets one dim arrow line. stderr so
 * it never pollutes machine-readable stdout; plain text so this layer needs no color dep.
 *
 * Failure policy: a line reports an act that already happened, so a fault on stderr must neither
 * fail that act nor drop the line unsaid. When the stderr write throws or the stream reports an
 * error (EPIPE, ENOSPC, EIO), the line is written to stdout instead with the error named, and the
 * stream's deferred `error` event is absorbed so it cannot crash the command after its write. If
 * stdout fails too, no channel is left and its own failure surfaces. The bound: a stderr closed
 * before the process starts is reopened by Node on /dev/null, which looks the same as an operator's
 * `2>/dev/null`, so the line is discarded where the operator sent it.
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

/** Write one provenance line under the failure policy above. A stream that failed earlier in the
 *  same tick buffers the line and then drops it, so `errored` after the write covers that case too. */
function say(line: string): void {
  let failure: unknown;
  try {
    process.stderr.write(`${line}\n`);
    failure = process.stderr.errored;
  } catch (e) {
    failure = e;
  }
  if (!failure) return;
  if (!absorbing) {
    absorbing = true;
    process.stderr.on("error", () => {}); // reported below; without a listener Node exits 1 on it
  }
  const why = (failure as NodeJS.ErrnoException).code ?? (failure as Error).message ?? String(failure);
  process.stdout.write(`${line} (stderr failed: ${why})\n`);
}
