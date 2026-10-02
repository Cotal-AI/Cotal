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
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { parsePid, probeLiveness } from "@cotal-ai/workspace";

/**
 * The physical path, symlinks resolved.
 *
 * FAILS CLOSED. `ENOENT` is the one honest fallback: a candidate base that does not exist yet has no
 * physical form, and its lexical form is all there is to check. Every other errno — `EACCES`, `EIO`,
 * `ELOOP` — means we could not PROVE the physical ancestry, and answering with the lexical path
 * there is a silent downgrade that reopens the exact symlink bypass this function exists to close.
 * Measured: an injected `EIO` on an existing symlink whose physical parent held a `.cotal` made
 * {@link cotalRootCaptor} return null, i.e. "clean", for a genuinely captured path.
 *
 * A guard that cannot establish its property must say so rather than substitute a weaker one it can.
 */
function physical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return resolve(p);
    throw new Error(
      `cannot canonicalize ${p} (${code ?? (e as Error).message}) — refusing to fall back to the lexical ` +
        `path, which cannot see a physical .cotal ancestor`,
      { cause: e },
    );
  }
}

/**
 * The physical path of a target that MAY NOT EXIST YET: the ORIGINAL SPELLING walked component by
 * component, each existing prefix canonicalized PHYSICALLY, with the still-missing tail appended.
 *
 * WHY THIS IS NOT {@link physical}. `physical` answers ENOENT with the LEXICAL path, and that is
 * right for the job it was written for — finding a `.cotal` ancestor of a candidate base that does
 * not exist yet, where a missing directory is a perfectly good candidate. It is NOT right for a
 * delete guard, and a delete guard inheriting that resolver is the whole defect: a lexical string
 * cannot see a symlink, so if any PARENT of the missing target points outside the root, the spelling
 * still looks contained. Measured at 87fe6991d: with `root/link -> <outside>`, `root/link/exists`
 * was REFUSED and `root/link/future` was ACCEPTED, and a file under the real `<outside>` was
 * destroyed through the accepted path. Same shape, opposite verdicts, and the accepted one is the
 * dangerous one.
 *
 * WHY THE WALK IS FORWARD, AND WHY NOTHING IS PRE-COLLAPSED. The first fix here walked UP from
 * `resolve(p)` and it had two holes, both of which are the same mistake — trusting a string where
 * the kernel consults an inode:
 *
 *   1. AN ENOENT IS NOT PROOF OF ABSENCE. A symlink whose REFERENT is missing also reports ENOENT
 *      from `realpath`, while the symlink ITSELF exists. An upward walk therefore steps PAST the
 *      dangling symlink, canonicalizes an ancestor ABOVE it, and appends the tail lexically — the
 *      symlink is never resolved. Measured at e6a831e36: with `root/link -> <outside>` and
 *      `<outside>` NOT created, `root/link/future` was ACCEPTED; `mkdir <outside>` and the
 *      IDENTICAL call was REFUSED. The same spelling flipped verdict purely because someone else
 *      created the parent afterwards, and the ACCEPTED half is the dangerous one. So on ENOENT we
 *      `lstat` the component: if `lstat` SUCCEEDS the component exists and is an unresolvable
 *      symlink, and this REFUSES by name; only an `lstat` that is itself ENOENT is a true missing
 *      basename the walk may continue through.
 *   2. A `..` MAY NOT BE COLLAPSED IN THE SPELLING. `resolve()` on entry applied every `..`
 *      textually, BEFORE any symlink was read, so the guard certified a path the kernel would never
 *      take. Measured at e6a831e36: `root2/link/../SIBLING.txt` with `root2/link -> <out2>` was
 *      ACCEPTED as `root2/SIBLING.txt`, while the kernel reads it as `<out2>/../SIBLING.txt`, which
 *      is OUTSIDE `root2`. That case was REFUSED at the pre-fix base 1d389afb and ACCEPTED at
 *      e6a831e36, so the deepest-ancestor commit INTRODUCED it. A `..` is therefore applied to the
 *      PHYSICAL PREFIX built so far, never to the spelling — which is what the kernel does.
 *
 * Note when writing a cell for either rule: build the target as a LITERAL STRING. `path.join()` and
 * `resolve()` normalize `..` away at the CALL SITE, so a probe that uses them never hands the guard
 * the case it means to test. That mismeasurement is how defect 2 was first reported as pre-existing.
 *
 * A `..` popped from the still-missing tail is applied textually, and that is sound rather than
 * inconsistent: a component whose PARENT does not exist cannot itself exist, so there is no inode
 * under it for a symlink to be.
 *
 * FAIL CLOSED. Non-ENOENT errnos from either `realpath` or `lstat` propagate: `physical` refuses to
 * downgrade to a lexical answer and so does this. An unresolvable ancestry is unprovable, not clean.
 *
 * THE COST, STATED: a DANGLING symlink is refused even when it points INWARD. It is unresolvable,
 * and this guard may only certify what it can resolve. An inward symlink to a directory that really
 * exists is unaffected and still accepted, missing child and all — that is the accept control.
 */
function physicalDeepest(p: string): string {
  // Made absolute WITHOUT normalizing: `resolve()` would apply every `..` here, before a single
  // symlink had been read, which is defect 2 above. Concatenation keeps the caller's spelling.
  const abs = isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`;
  const root = parse(abs).root;
  let prefix: string;
  try {
    prefix = realpathSync.native(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // The filesystem root itself did not resolve, so there is no existing ancestor to stand on and
    // nothing to be canonical about. Fall back to the lexical form rather than walking nowhere.
    return resolve(p);
  }
  const missing: string[] = [];
  for (const part of abs.slice(root.length).split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // THE PHYSICAL PREFIX, NEVER THE SPELLING. Once a symlink has been followed, the parent of
      // where we ARE is not the parent of how we were SPELLED, and the kernel follows the former.
      if (missing.length > 0) missing.pop();
      else prefix = dirname(prefix);
      continue;
    }
    // A missing component cannot have existing children, so once the tail is missing it stays
    // missing and no further syscall can tell us anything new.
    if (missing.length > 0) {
      missing.push(part);
      continue;
    }
    const candidate = join(prefix, part);
    try {
      prefix = realpathSync.native(candidate);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // ENOENT FROM realpath IS AMBIGUOUS, and resolving that ambiguity is the whole point of this
      // walk: either the component is absent, or it EXISTS as a symlink whose referent is absent.
      // `lstat` does not follow the link, so it separates the two.
      try {
        lstatSync(candidate);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== "ENOENT") throw e2;
        missing.push(part);
        continue;
      }
      throw new Error(
        `cannot canonicalize ${candidate}: it EXISTS but its referent does not, so it is a dangling ` +
          `symlink whose physical path is unknowable — refusing to treat an unresolvable component as ` +
          `a missing basename, because appending the tail lexically would certify a path the kernel ` +
          `would not take (walking ${abs})`,
      );
    }
  }
  return missing.length === 0 ? prefix : join(prefix, ...missing);
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
 * Refuse a recursive delete whose target is not a STRICT child of the root it was minted under,
 * and return the canonical path that passed.
 *
 * A cleanup with no containment check deletes whatever it is handed, so any defect UPSTREAM of it —
 * a mutant, an ordinary bug, a caller passing the wrong variable — stops being a failed test and
 * becomes an arbitrary recursive delete. Measured: a mint that returned `candidate + "/.."` made
 * its own teardown delete the PARENT of its mkdtemp, and where `tmpdir()` is `/tmp` that removed an
 * orchestrator relay socket and fourteen seats' control sockets before aborting on a root-owned
 * `EPERM`. The lesson is not "do not write that bug"; it is that the delete must not be willing.
 *
 * CANONICAL, NOT LEXICAL, for the same reason {@link makeScratch} canonicalizes at mint time: a
 * lexical prefix compare is satisfied by a symlink pointing anywhere, and a `..` segment only
 * resolves away physically. STRICT, because deleting the root itself IS the incident, so equal-to
 * is a refusal and not a pass.
 *
 * A MISSING TARGET IS RESOLVED BY WALKING ITS ORIGINAL SPELLING ({@link physicalDeepest}), not by
 * normalizing it first. `rmSync(…, { force: true })` is willing to be handed an already-absent path,
 * so "it does not exist" cannot be assumed away here — and a target that does not exist YET is
 * exactly the one a plain lexical fallback certifies while a symlinked parent carries the delete
 * outside the root. A component that EXISTS but cannot be resolved (a dangling symlink) is refused
 * by name rather than mistaken for a missing basename, and a `..` is applied to the physical prefix
 * rather than to the spelling.
 *
 * WHAT THIS DOES NOT PROMISE — READ THIS BEFORE CALLING IT ATOMIC. Node has no descriptor-relative
 * `rmSync`, so there is no way from here to delete the exact inode that was checked. This guard
 * therefore certifies the state AT CHECK TIME. A component swapped between the check and the delete
 * is OUT OF SCOPE and is named as such rather than quietly implied to be covered; closing it needs
 * an `openat`/`unlinkat` walk this codebase does not have. The one transition that IS now closed is
 * the dangling case: a symlink whose referent appears later used to flip the same spelling from
 * ACCEPTED to REFUSED, and it is refused in both states.
 *
 * ONLY THE RETURN VALUE MAY BE DELETED. The caller must delete the path this RETURNS, never the path
 * it was HANDED: re-walking the caller's spelling after the check resolves it a second time and
 * reopens exactly the gap the check closed. That is why this returns the canonical path instead of
 * returning void, and why {@link removeContained} exists as the only intended way to call it.
 *
 * THROWS rather than declining. A leaked scratch is recoverable and a wrong delete is not, so a
 * cleanup that cannot PROVE containment must fail its suite rather than quietly skip and let the
 * caller believe it tidied up.
 */
export function assertContainedIn(target: string, root: string, what = "delete target"): string {
  const r = physical(root);
  // A target we cannot canonicalize is unprovable, not clean — the same fail-closed rule `physical`
  // states for ancestry. Re-thrown in the language of the delete, because `physical`'s own message
  // is about `.cotal` ancestors and would send the reader to the wrong defect.
  let t: string;
  try {
    t = physicalDeepest(target);
  } catch (e) {
    throw new Error(
      `refusing to recursively delete ${what} ${target}: its physical path could not be established ` +
        `(${(e as Error).message}), so containment under ${r} is unproven`,
      { cause: e },
    );
  }
  if (t === r)
    throw new Error(
      `refusing to recursively delete ${what} ${t}: it IS the root ${r} rather than something inside ` +
        `it — a containment check that accepts the root would permit the very delete it exists to stop`,
    );
  if (!t.startsWith(r.endsWith(sep) ? r : r + sep))
    throw new Error(
      `refusing to recursively delete ${what} ${t}: it resolves OUTSIDE its root ${r}` +
        (resolve(target) === t ? "" : ` (given as ${target})`) +
        ` — a cleanup may only remove what it minted`,
    );
  return t;
}

/**
 * `rmSync(target, { recursive: true, force: true })`, but only after {@link assertContainedIn}
 * proves `target` is a strict child of `root`. Every recursive delete of a minted directory should
 * go through this rather than calling `rmSync` directly.
 *
 * NOTE WHICH PATH IS DELETED: the one `assertContainedIn` RETURNED, not the `target` argument. The
 * shape enforces the rule — the checked value is passed straight into `rmSync` with no name in
 * between for a later edit to swap back to `target`. Re-resolving the caller's spelling here would
 * mean the guard certified one path and the delete walked another, which is the whole class of
 * defect this helper exists to close. Containment is proven at CHECK time; see
 * {@link assertContainedIn} for what that does and does not promise about a concurrent swap.
 */
export function removeContained(target: string, root: string, what = "scratch"): void {
  rmSync(assertContainedIn(target, root, what), { recursive: true, force: true });
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
    // A base whose ancestry cannot be PROVEN is unusable, not clean: `cotalRootCaptor` now throws
    // rather than downgrading to a lexical answer, and "I could not check" must reject the
    // candidate, never accept it.
    let captor: string | null;
    try {
      captor = cotalRootCaptor(base);
    } catch (e) {
      tried.push(`${base} (ancestry unprovable: ${(e as Error).message})`);
      continue;
    }
    if (captor) {
      tried.push(`${base} (captured by ${join(captor, ".cotal")})`);
      continue;
    }
    let scratch: string;
    // Made and canonicalized as two steps, so a canonicalization failure can REMOVE the directory it
    // just created. Collapsing them leaks a scratch on every rejected base — and since the fixture
    // anchors a `.cotal` inside it, a leaked scratch is a capture hazard rather than clutter.
    let made: string;
    try {
      made = mkdtempSync(join(base, prefix));
    } catch (e) {
      tried.push(`${base} (${(e as Error).message})`);
      continue;
    }
    try {
      // Canonical, not lexical. A spawned child's `process.cwd()` is physical on POSIX, so handing
      // out a symlinked path guarantees the suite and the product disagree about where the fixture
      // is. Resolve it once, here, and every later comparison is against the same string.
      scratch = realpathSync.native(made);
    } catch (e) {
      removeContained(made, base, "uncanonicalizable scratch");
      tried.push(`${base} (created but not canonicalizable, removed: ${(e as Error).message})`);
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
  // The manager's record is named per-space (`manager.<spaceKey>.pid`), and a pre-segmentation root
  // still spells it `manager.pid`. This fixture has no space in hand, so it matches the SHAPE and
  // refuses a root holding more than one - which would make "the manager" a guess.
  const records = existsSync(join(root, ".cotal"))
    ? readdirSync(join(root, ".cotal")).filter((n) => /^manager\.([^.]+\.)?pid$/.test(n))
    : [];
  if (records.length > 1)
    throw new Error(`several manager records under ${join(root, ".cotal")} (${records.join(", ")}), so "the manager" is ambiguous and none was killed`);
  const pidFile = join(root, ".cotal", records[0] ?? "manager.pid");
  if (records.length === 0) {
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
