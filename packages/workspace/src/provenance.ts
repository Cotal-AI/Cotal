/**
 * One consistent voice for CLI provenance, on stderr: which on-disk source a command RESOLVED
 * its configuration from, and what it WROTE where. Commands must never silently pick up state
 * from a directory or silently drop files — every read of config (persona file, mesh entry,
 * config.json layer) and every write (creds, seeded files) gets one dim arrow line. stderr so
 * it never pollutes machine-readable stdout; plain text so this layer needs no color dep.
 */
export const provenance = {
  /** `→ using <what>: <source>` — the source that WON resolution (say which layer/path). */
  read(what: string, source: string): void {
    process.stderr.write(`→ using ${what}: ${source}\n`);
  },
  /** `→ wrote <what>: <dest>` — announce every file the command created or replaced. */
  wrote(what: string, dest: string): void {
    process.stderr.write(`→ wrote ${what}: ${dest}\n`);
  },
};
