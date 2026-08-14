/**
 * REFUSE to measure a stale build.
 *
 * Any suite that reaches code through a PACKAGE SPECIFIER runs `dist/`, not `src/`: the CLI resolves
 * `@cotal-ai/cli` through its package `main` (`./dist/index.js`) and there is no `paths` alias to
 * source. `dist/` is gitignored, so it carries no provenance at all — and a suite cannot tell "the
 * source is right" from "the source was never run". It reports the same green for both.
 *
 * That was measured, not theorised: two consecutive runs of a live CLI cell suite reported 10 passed
 * / 0 failed while the rendered output came from a source version that had already been replaced. It
 * surfaced only because the stale value happened to be visible text that disagreed with the file on
 * disk. Had it been behaviour, the suite would have been green about a program nobody had built.
 *
 * A build can ALSO be a shared side effect — but that part is LANE-DEPENDENT and must be measured,
 * not inherited. Where `node_modules/@cotal-ai/*` symlinks into a store outside the worktree, one
 * lane's `pnpm build` changes what another lane's live suite executes without touching a tracked
 * file, invisible to `git status`. Measured with `readlink -e` (NOT `-f`, which happily prints an
 * absolute path for a package that is not installed), this worktree's packages all resolve inside
 * itself, so its `dist` is private and that aggravator does not apply here. The provenance defect
 * above never depended on sharing and stands without it.
 *
 * This refuses rather than warns, and it refuses BEFORE the suite measures anything. A discipline is
 * something a tired person skips; a refusal is not. And it names WHICH condition failed, because a
 * bare "build check failed" is the same defect this directory's suites exist to catch.
 *
 * Deliberately NOT solved by pointing suites at `src/`: the published entry point resolves through
 * `dist/`, so a suite reading source would be green about code no user ever runs — trading a
 * provenance gap for a coverage gap.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The source extensions that COMPILE TO `.js`, and therefore the ones a build must emit for.
 *
 * `.tsx` is here because leaving it out was a real hole, not a hypothetical one: the guarded CLI
 * ships 20 `.tsx` files (`implementations/cli/src/console/app.tsx` among them), `"view.tsx"
 * .endsWith(".ts")` is FALSE, and so a fifth of the package was invisible to both the staleness
 * comparison and the completeness check. A `.tsx` edited after its output, and a `.tsx` whose output
 * was deleted outright, both read as `current`. Found in review with a live two-source `tsc`
 * fixture.
 *
 * Kept as a named list rather than a loose suffix test because that is exactly how the hole got in:
 * one extension was written in three places and nobody was counting. */
const SOURCE_EXTS = [".ts", ".tsx"] as const;

/** Every file under `dir` whose name ends in any of `exts`, recursively. Empty for a missing tree. */
function allFiles(dir: string, exts: readonly string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The `.js` a given source is expected to compile to: swap its extension, keep its relative path. */
function outputFor(srcPath: string, srcRoot: string, pkgDir: string): string {
  const rel = srcPath.slice(srcRoot.length + 1);
  const ext = SOURCE_EXTS.find((x) => rel.endsWith(x));
  return join(pkgDir, "dist", `${rel.slice(0, rel.length - (ext?.length ?? 0))}.js`);
}

/** The extreme mtime under `dir` for files matching `ext`, and the file that carried it.
 *  Returns undefined for a missing or empty tree — "no evidence" is a distinct answer from "old",
 *  and the caller must not be able to confuse them. */
function extreme(dir: string, exts: readonly string[], pick: "newest" | "oldest"): { path: string; mtimeMs: number } | undefined {
  let best: { path: string; mtimeMs: number } | undefined;
  for (const p of allFiles(dir, exts)) {
    const { mtimeMs } = statSync(p);
    const better = !best || (pick === "newest" ? mtimeMs > best.mtimeMs : mtimeMs < best.mtimeMs);
    if (better) best = { path: p, mtimeMs };
  }
  return best;
}

export type BuildStaleness =
  | { condition: "current"; pkg: string }
  | { condition: "never-built"; pkg: string; detail: string }
  | { condition: "incomplete-build"; pkg: string; detail: string; srcPath: string; expected: string }
  | { condition: "no-package"; pkg: string; detail: string }
  | { condition: "no-source"; pkg: string; detail: string }
  | { condition: "stale"; pkg: string; detail: string; srcPath: string; distPath: string; behindMs: number };

/** Compare one package's newest `src/**\/*.ts` against its newest `dist/**\/*.js`. */
export function buildStaleness(pkgDir: string): BuildStaleness {
  // A path that does not exist is NOT a fact about a build. Reporting it as `no-source` would hand
  // a typo'd package path a confident build verdict and a `pnpm build` instruction that cannot fix
  // it — while the package the caller MEANT to check goes unexamined and the suite runs anyway.
  if (!existsSync(pkgDir))
    return { condition: "no-package", pkg: pkgDir, detail: `no such directory: ${pkgDir} — the guard cannot examine it, so nothing about its build has been established` };
  const src = extreme(join(pkgDir, "src"), SOURCE_EXTS, "newest");
  // The OLDEST output, not the newest. Comparing newest-to-newest fails OPEN on a PARTIAL build:
  // with `src/a.ts` newer than a stale `dist/a.js`, one unrelated fresh `dist/b.js` makes the
  // package look current — exactly the state an interrupted or errored build leaves behind. Found
  // by review, with a two-file fixture; reproduced here before this was changed.
  // `tsc -p` rewrites every output, so after a complete build the oldest output is still newer than
  // the newest source (measured on implementations/cli). A package that legitimately ships an
  // output it does not rewrite would read as permanently stale — the verdict names the exact file,
  // so that shows up as a diagnosable false positive rather than a silent pass.
  const dist = extreme(join(pkgDir, "dist"), [".js"], "oldest");
  if (!src) return { condition: "no-source", pkg: pkgDir, detail: `no .ts files under ${join(pkgDir, "src")}` };
  if (!dist) return { condition: "never-built", pkg: pkgDir, detail: `no .js files under ${join(pkgDir, "dist")} — this package has never been built, so a suite driving it measures nothing` };

  // PER-OUTPUT: every source must have its OWN output, present and not older than it.
  // The aggregate comparison below catches an output that is present-but-old. It cannot catch an
  // output that is ABSENT — the oldest of the surviving files says nothing about the one that is
  // gone, so a build that emitted `b.js` and never emitted `a.js` read as `current`. Found by
  // review, reproduced with a real two-source package before this was written.
  // `.d.ts` sources are skipped: they are declarations and emit no `.js`, so requiring one would
  // make every package with an ambient declaration permanently incomplete.
  const srcRoot = join(pkgDir, "src");
  const missing = allFiles(srcRoot, SOURCE_EXTS)
    .filter((p) => !p.endsWith(".d.ts"))
    .map((p) => ({ srcPath: p, expected: outputFor(p, srcRoot, pkgDir) }))
    .find(({ expected }) => !existsSync(expected));
  if (missing)
    return {
      condition: "incomplete-build", pkg: pkgDir,
      srcPath: missing.srcPath, expected: missing.expected,
      detail: `${missing.srcPath} has no build output at ${missing.expected} — the build did not emit every source, so the package is only partly built`,
    };

  if (src.mtimeMs > dist.mtimeMs)
    return {
      condition: "stale", pkg: pkgDir,
      srcPath: src.path, distPath: dist.path,
      behindMs: Math.round(src.mtimeMs - dist.mtimeMs),
      detail: `${src.path} is newer than the OLDEST build output ${dist.path} — the build did not complete after that source change`,
    };
  return { condition: "current", pkg: pkgDir };
}

/** REFUSE (throw) unless every named package's build is at least as new as its source.
 *  Call this as the FIRST action of any suite that drives a package-specifier entry point. */
export function assertBuildCurrent(pkgDirs: readonly string[]): void {
  if (pkgDirs.length === 0)
    throw new Error("assertBuildCurrent: REFUSING — called with no packages. A check over an empty set passes vacuously, which is the failure mode this exists to prevent.");
  for (const dir of pkgDirs) {
    const s = buildStaleness(dir);
    if (s.condition === "current") continue;
    // A missing package is a broken CALL, not a stale build. It gets its own prefix so the caller
    // can stop for the right reason: `pnpm build` is the wrong instruction and following it would
    // leave the real package still unchecked.
    if (s.condition === "no-package")
      throw new Error(
        `CANNOT CHECK: ${s.detail}\n` +
        `  This is NOT a verdict about any build. Nothing has been established about the package\n` +
        `  you intended to check — fix the path passed to assertBuildCurrent, then re-run.`,
      );
    throw new Error(
      `REFUSING TO MEASURE: build is not current for ${s.pkg} (${s.condition}).\n` +
      `  ${s.detail}\n` +
      (s.condition === "stale" ? `  source is ${s.behindMs}ms newer than the build\n` : "") +
      `  This suite drives the package entry point, which resolves through dist/, so it would be\n` +
      `  measuring a build of a DIFFERENT source than the one in the tree.\n` +
      `  NEXT: pnpm build, then re-run.`,
    );
  }
}
