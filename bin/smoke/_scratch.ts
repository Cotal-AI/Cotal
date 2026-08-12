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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The nearest ancestor of `start` (inclusive) holding a `.cotal`, or null if the path is free.
 *  Deliberately mirrors `findCotalRoot`'s walk — if that changes, this must change with it. */
export function cotalRootCaptor(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".cotal"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
      scratch = mkdtempSync(join(base, prefix));
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
 * Witness that nothing ABOVE `dir` captures it — i.e. that `findCotalRoot(dir)` is still `dir`.
 * Call it AFTER the fixture is built, not only at setup: a `.cotal` can appear above the scratch
 * mid-run (a concurrent `cotal` command, or the suite's own child rooting somewhere unexpected),
 * and the failure that causes looks like a product defect.
 *
 * Ancestors ONLY. By this point `dir` normally has a `.cotal` of its own — that is `cotal up`
 * working, and it is what makes `dir` the mesh root. Treating it as a capture would red every
 * correct run, which is what the first version of this function did.
 */
export function assertScratchHeld(dir: string, what = "scratch"): void {
  const self = resolve(dir);
  const captor = cotalRootCaptor(dirname(self));
  if (captor) {
    throw new Error(
      `${what} (${self}) is captured by ${join(captor, ".cotal")}: findCotalRoot resolves anything ` +
        `under it to ${captor}, so this suite's fixture is not where it thinks it is. Remove that ` +
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
    const captor = cotalRootCaptor(dirname(root));
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
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`unparseable manager pid ${JSON.stringify(raw)} at ${pidFile}`);
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`manager pid ${pid} (${pidFile}) was already dead before the kill — the fixture never armed`);
  }
  process.kill(pid, "SIGKILL");
  // Poll rather than sleep a guessed interval: the assertion is "it is gone", not "some time passed".
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error(`manager pid ${pid} survived SIGKILL after 5s`);
}
