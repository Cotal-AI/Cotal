/**
 * Provenance lines on stderr (`provenance.ts`): on a terminal a long line wraps at spaces like the
 * CLI's other notices, each continuation line under the text after the arrow, and a path wider than
 * the rest of the line keeps a line of its own, whole even when it holds spaces. To a pipe or a file
 * the line stays whole, and a control character in an argument is still shown as an escape.
 * Broker-free.
 *
 * Run: pnpm smoke:provenance
 */
import { provenance } from "@cotal-ai/workspace";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${extra === undefined ? "" : ` (${JSON.stringify(extra)})`}`);
  }
}

type Stream = { isTTY?: boolean; columns?: number; write: (chunk: string, done?: (e?: Error | null) => void) => boolean };

/** What `run` writes to stderr and stdout when stderr is a terminal of `columns` (80) or a pipe, one
 *  entry per write. `failErr` makes the stderr write throw, as a closed pipe does. */
function capture(run: () => void, { tty = true, failErr = false, columns = 80 } = {}): { err: string[]; out: string[] } {
  const err = process.stderr as unknown as Stream, out = process.stdout as unknown as Stream;
  const saved = [{ isTTY: err.isTTY, columns: err.columns, write: err.write }, { isTTY: out.isTTY, columns: out.columns, write: out.write }];
  const written = { err: [] as string[], out: [] as string[] };
  const into = (to: string[], fail = false) => (chunk: string, done?: (e?: Error | null) => void): boolean => {
    if (fail) throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    to.push(chunk);
    done?.();
    return true;
  };
  Object.assign(err, { isTTY: tty, columns, write: into(written.err, failErr) });
  Object.assign(out, { isTTY: tty, columns, write: into(written.out) });
  try {
    run();
  } finally {
    Object.assign(err, saved[0]);
    Object.assign(out, saved[1]);
  }
  return written;
}

console.log("PROVENANCE SMOKE");
// The tester's path: 68 columns, so `→ using persona: <path>` is 85 and an 80-column terminal used
// to break the path mid-word.
const path = "/run/user/1000/cotal-jrn-a-L320e_p8/proj/ua/.cotal/agents/default.md";

const onTty = capture(() => provenance.read("persona", path));
check("on an 80-column terminal the path goes on its own line, under the text after the arrow",
  JSON.stringify(onTty.err) === JSON.stringify([`→ using persona:\n  ${path}\n`]), onTty.err);
const verbs = capture(() => { provenance.wrote("persona", path); provenance.removed("persona", path); });
check("wrote and removed wrap the same way",
  JSON.stringify(verbs.err) === JSON.stringify([`→ wrote persona:\n  ${path}\n`, `→ removed persona:\n  ${path}\n`]), verbs.err);

// A path with spaces and a backtick, as a project folder can have: 73 columns, so it fits an
// 80-column line on its own but not after `→ using persona:`, and used to be split at its spaces.
const spaced = "/tmp/cotal-jrn-a-L320e/proj/with space `tick` dq/.cotal/agents/default.md";
const spaced80 = capture(() => provenance.read("persona", spaced));
check("on an 80-column terminal a path with spaces goes whole on its own line",
  JSON.stringify(spaced80.err) === JSON.stringify([`→ using persona:\n  ${spaced}\n`]), spaced80.err);
const spaced40 = capture(() => provenance.read("persona", spaced), { columns: 40 });
check("on a 40-column terminal a path with spaces wider than the line is still whole on its own line",
  JSON.stringify(spaced40.err) === JSON.stringify([`→ using persona:\n  ${spaced}\n`]), spaced40.err);
const wide = "/run/user/1000/cotal-jrn-a-L320e_p8/proj/with space `tick` dq/.cotal/agents/default.md";
const wide80 = capture(() => { provenance.wrote("persona", wide); provenance.removed("persona", wide); });
check("a path with spaces wider than an 80-column line is whole after wrote and removed",
  JSON.stringify(wide80.err) === JSON.stringify([`→ wrote persona:\n  ${wide}\n`, `→ removed persona:\n  ${wide}\n`]), wide80.err);
const label40 = capture(() => provenance.wrote("creds for default_agent (auth mode)", spaced), { columns: 40 });
check("the label still wraps at its spaces before a whole path",
  JSON.stringify(label40.err) === JSON.stringify([`→ wrote creds for default_agent (auth\n  mode):\n  ${spaced}\n`]), label40.err);

const onPipe = capture(() => provenance.read("persona", path), { tty: false });
check("to a pipe the line stays whole", JSON.stringify(onPipe.err) === JSON.stringify([`→ using persona: ${path}\n`]), onPipe.err);

const escaped = capture(() => provenance.wrote("creds", "/tmp/a\nb"));
check("a newline in an argument is still shown as \\u000a",
  JSON.stringify(escaped.err) === JSON.stringify(["→ wrote creds: /tmp/a\\u000ab\n"]), escaped.err);

const fits = capture(() => provenance.read("persona", "/srv/p/.cotal/agents/default.md"));
check("a line that fits is unchanged", JSON.stringify(fits.err) === JSON.stringify(["→ using persona: /srv/p/.cotal/agents/default.md\n"]), fits.err);

const failedErr = capture(() => provenance.read("persona", path), { failErr: true });
const fallback = failedErr.out[0] ?? "";
check("when stderr fails, stdout gets the line with the error named, wrapped, in one write",
  failedErr.err.length === 0 && failedErr.out.length === 1 && fallback.replaceAll("\n  ", " ") === `→ using persona: ${path} (stderr failed: EPIPE)\n`
    && fallback.split("\n").length > 2 && fallback.split("\n").every((line) => [...line].length <= 80), failedErr.out);

if (failed) {
  console.log(`PROVENANCE SMOKE: ${failed} failed`);
  process.exit(1);
}
console.log("PROVENANCE SMOKE: all passed");
