/**
 * A temp root that `findCotalRoot` cannot capture — the one sandbox a smoke cannot get from
 * `COTAL_HOME`.
 *
 * `findCotalRoot` (`packages/workspace/src/auth-paths.ts`) walks to `/` with no boundary, exactly
 * like git finding `.git`. So ANY `.cotal` in an ancestor of `os.tmpdir()` makes every scratch dir
 * a suite mints resolve as that ancestor's project root, and `cotalPath()` writes the mesh's
 * `.cotal/manager.pid`, `manager.log`, `nats/`, and auth material THERE instead of into the
 * fixture. Sandboxing `COTAL_HOME` does not help: that is the machine home, a different root.
 *
 * The damage is not a wrong path, it is a silent disarm. A cell written as
 * `if (existsSync(pidFile)) kill(...)` skips its own body, the fixture never arms, and the suite
 * grades a healthy product against a state it failed to create. That is how a captured root
 * surfaces: not as "file not found", but as a confident, wrong failure somewhere else.
 *
 * WHY THIS PASSES LOCALLY AND REDS IN CI. The exposure is not the same on both. On Linux (and so on
 * CI) `os.tmpdir()` IS `/tmp`, so a `/tmp/.cotal` left behind by any ordinary `cotal` run captures
 * EVERY suite that mints a fixture there. On macOS the default temp root is `/var/folders/<…>/T`,
 * whose ancestry is clean, so a `/private/tmp/.cotal` on the same machine captures only suites that
 * hardcode `/tmp` (or run under a TMPDIR someone pointed there). A suite can therefore be green on
 * a developer's Mac and red on CI with the product working perfectly in both.
 *
 * Call `makeScratch()` FIRST, before importing anything that resolves a root, and tear the returned
 * directory down in `finally`. Pair it with `assertScratchHeld()` after the fixture exists: the
 * sandbox is what makes the suite pass, but the assertion is what keeps it honest if the sandbox
 * ever stops working.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parsePid, probeLiveness } from "../../implementations/cli/src/lib/pid.js";

/** The physical path, symlinks resolved. Falls back to the lexical form for a path that does not
 *  exist yet (a candidate base we are about to reject anyway). */
function physical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** One `findCotalRoot`-shaped walk from `start` up to `/`. */
function walkUp(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".cotal"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The nearest ancestor of `start` (inclusive) holding a `.cotal`, or null if the path is free.
 *
 * Walks BOTH the lexical and the physical form, and reports a captor found by either. A symlinked
 * base makes those two different sets of directories: `/var/tmp/alias` walks `/var/tmp` → `/var` →
 * `/`, while its target walks the real chain, and a `.cotal` on the physical side is invisible to
 * the lexical walk. That matters because we do not get to choose which walk the product does —
 * `process.cwd()` is physical on POSIX, so a spawned `cotal` resolves its root physically, while a
 * path handed to `--root` resolves lexically. Checking one and shipping is how a guard passes while
 * the thing it guards is captured. Fail closed: either walk finding a `.cotal` is a capture.
 */
export function cotalRootCaptor(start: string): string | null {
  const lex = resolve(start);
  const phys = physical(start);
  return walkUp(lex) ?? (phys === lex ? null : walkUp(phys));
}

/**
 * Make a scratch dir under a temp base with NO `.cotal` ancestor and point `TMPDIR`/`TMP`/`TEMP` at
 * it, so every later `os.tmpdir()` (re-read per call on POSIX) and every child process inheriting
 * `process.env` lands inside the sandbox.
 *
 * Bases are tried in order: the CI runner temp (never `/tmp` on GitHub Actions), the current temp,
 * then `/var/tmp`. A captured base is SKIPPED, not used with a warning — using it is the defect.
 * If every candidate is captured this THROWS, naming each base and why: a suite that cannot be
 * hermetic must fail loudly at its first line, not run and grade.
 *
 * KNOWN LIMIT — base DEPTH, not ancestry. Because this repoints `TMPDIR`, anything that later opens
 * a unix domain socket under it inherits the chosen path, and `sun_path` caps a socket path at 104
 * bytes on macOS (108 on Linux). A deeply nested base therefore kills the child launcher rather
 * than the suite: `tsx` dies `listen EINVAL … <base>/tsx-<uid>/<pid>.pipe` before the suite body
 * runs at all. Measured: 129 bytes under a nested per-tool temp fails; the ordinary
 * `/var/folders/<…>/T/cotal-*` (~87) and `/var/tmp/cotal-*` are fine, as is CI's `RUNNER_TEMP`.
 * Selection is deliberately NOT sorted by length — `RUNNER_TEMP` is preferred because CI cleans it
 * between jobs, and trading that for a shorter path would trade a real guarantee for a rare one.
 * If you see `listen EINVAL` from a suite that uses this helper, it is path LENGTH, not capture.
 */
export function makeScratch(prefix = "cotal-smoke-"): string {
  const bases = [process.env.RUNNER_TEMP, process.env.TMPDIR, tmpdir(), "/var/tmp"].filter(
    (b): b is string => typeof b === "string" && b.length > 0,
  );
  const tried: string[] = [];
  for (const base of bases) {
    const captor = cotalRootCaptor(base);
    if (captor) {
      tried.push(`${base} (captured by ${join(captor, ".cotal")})`);
      continue;
    }
    let scratch: string;
    try {
      // Canonical, not lexical. A spawned child's `process.cwd()` is physical on POSIX, so handing
      // out a symlinked path guarantees the suite and the product disagree about where the fixture
      // is. Resolve it once, here, and every later comparison is against the same string.
      scratch = realpathSync.native(mkdtempSync(join(base, prefix)));
    } catch (e) {
      tried.push(`${base} (${(e as Error).message})`);
      continue;
    }
    process.env.TMPDIR = scratch;
    process.env.TMP = scratch;
    process.env.TEMP = scratch;
    return scratch;
  }
  throw new Error(
    `no temp base free of a .cotal ancestor, so this suite cannot be hermetic; tried: ${tried.join("; ")}`,
  );
}

/**
 * The root `findCotalRoot` would actually pick for `dir` when that is NOT `dir` itself — a FOREIGN
 * root capturing the fixture. Null when `dir` roots itself, or when nothing above it roots anything.
 *
 * NEAREST WINS, which is the whole subtlety. `findCotalRoot` walks up and stops at the FIRST
 * `.cotal`, starting at `dir`. So once `cotal up` has created `root/.cotal`, an ancestor `.cotal`
 * cannot capture the fixture any more — the fixture outranks it. A predicate that asks "is there
 * any `.cotal` above me" answers yes and is WRONG after that point: it would call a healthy fixture
 * captured, and a teardown gated on it would skip a legitimate `cotal down` and leak the mesh.
 * Before `up`, with no `root/.cotal` yet, the two questions coincide — which is exactly why asking
 * the wrong one looked correct.
 *
 * The predicate form, for callers that must DECIDE rather than die — teardown above all: `cotal
 * down` re-resolves from cwd, so under a genuinely foreign root it signals pids the fixture never
 * started. A cleanup step is the wrong place to throw and the wrong place to guess.
 */
export function foreignRootFor(dir: string): string | null {
  const lex = resolve(dir);
  const phys = physical(dir);
  for (const start of phys === lex ? [lex] : [lex, phys]) {
    const winner = walkUp(start);
    if (winner !== null && winner !== start) return winner;
  }
  return null;
}

export function assertScratchHeld(dir: string, what = "scratch"): void {
  const self = physical(dir);
  const foreign = foreignRootFor(self);
  if (foreign) {
    throw new Error(
      `${what} (${self}) resolves to ${foreign} via ${join(foreign, ".cotal")}: findCotalRoot picks ` +
        `that root instead, so this suite's fixture is not where it thinks it is. Remove that ` +
        `.cotal or point TMPDIR somewhere with no .cotal above it.`,
    );
  }
}

/**
 * SIGKILL the manager whose pid file sits under `root/.cotal`, and prove every step of it.
 *
 * The companion guard to the sandbox above, and the more important half. A suite that writes
 * `if (existsSync(pidFile)) kill(...)` cannot tell "the manager is dead" from "I never found the
 * manager": a captured root makes the file absent, the body is skipped, and the next assertion
 * grades a still-LIVE manager's honest answer as a product defect. Every precondition here throws
 * with the reason named, so the suite dies at the line that failed to arm rather than at a
 * downstream cell that was never given the state it asserts on.
 *
 * Returns the killed pid. Only ever kills a pid this fixture's own `cotal up` wrote.
 */
export async function killManagerAtRoot(root: string): Promise<number> {
  const pidFile = join(root, ".cotal", "manager.pid");
  if (!existsSync(pidFile)) {
    const captor = foreignRootFor(root);
    throw new Error(
      `no manager pid at ${pidFile}, so the manager was NOT killed and anything asserted after ` +
        `this point grades a live mesh` +
        (captor
          ? `. The fixture root is captured by ${join(captor, ".cotal")} — cotal wrote its state ` +
            `there instead. Build the fixture with makeScratch().`
          : `. The mesh either never started or rooted somewhere unexpected.`),
    );
  }
  const raw = readFileSync(pidFile, "utf8").trim();
  // The CLI's own parser and tri-state probe, imported rather than re-implemented. That module says
  // it is "consumed everywhere", and a second copy here would be free to drift from the contract it
  // is supposed to be enforcing.
  const pid = parsePid(raw);
  if (pid === undefined) throw new Error(`unparseable manager pid ${JSON.stringify(raw)} at ${pidFile}`);

  // Only ESRCH proves death. A bare `catch` collapses EPERM (alive, just not ours to signal) and
  // unknown errnos into "dead" — which would let this helper report a kill it never proved, the
  // exact false-proof this guard exists to prevent.
  const before = probeLiveness(pid);
  if (before === "dead")
    throw new Error(`manager pid ${pid} (${pidFile}) was already dead before the kill — the fixture never armed`);
  if (before === "unknown")
    throw new Error(`manager pid ${pid} (${pidFile}) is UNATTRIBUTABLE before the kill — refusing to claim a kill this helper cannot prove`);

  // The signal itself can fail (EPERM on a process that is not ours). Name that as what it is — a
  // kill this helper could not perform — rather than letting a raw errno escape from a guard whose
  // whole job is to say precisely why the fixture did not arm.
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    throw new Error(
      `SIGKILL of manager pid ${pid} (${pidFile}) failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` +
        ` — the mesh is still alive and nothing below this point is grading what it claims`,
    );
  }
  // Poll rather than sleep a guessed interval: the assertion is "it is gone", not "some time passed".
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const after = probeLiveness(pid);
    if (after === "dead") return pid;
    if (after === "unknown")
      throw new Error(`manager pid ${pid} became UNATTRIBUTABLE after SIGKILL — cannot prove the mesh is dead`);
  }
  throw new Error(`manager pid ${pid} survived SIGKILL after 5s`);
}
