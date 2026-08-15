/**
 * WHICH TYPESCRIPT FILES DOES THIS REPO ACTUALLY TYPECHECK? — derived, never listed.
 *
 * This exists because of a measured defect, not a hypothetical one. Three AG-UI event constructors
 * were called without their required `timestamp` in
 * `extensions/connector-core/smoke/agui-renderer-precondition.smoke.ts` — **the file whose failures
 * ARE the AG-UI merge gate** — and nothing caught it, because three independent guards each had no
 * jurisdiction over that file:
 *
 *   - `tsx` strips types without checking them;
 *   - the package's tsconfig is `"include": ["src"]`, so `smoke/` is outside its typecheck;
 *   - the suite is deliberately ungated, so no gate run exercises it.
 *
 * **Not one failure of care — an uncovered intersection no single instrument was responsible for.**
 * This file makes that intersection a red cell instead of a silence.
 *
 * ⚠️ **A tsconfig THAT COVERS THE FILE IS NOT COVERAGE. Something must INVOKE it.** The repo root
 * carries a `tsconfig.json` whose `include` is `["bin/**\/*", "implementations/**\/*",
 * "packages/**\/*", "extensions/**\/*", "examples/**\/*"]` — it covers every smoke file in the tree.
 * **Nothing runs it.** Root `typecheck` is `pnpm build && pnpm -r typecheck`; `pnpm -r` excludes the
 * workspace root, and every `tsc -p tsconfig.json` in the tree resolves to the invoking package's
 * OWN config. So the root project is an editor/LSP artifact, and reading it as proof of coverage is
 * how this defect stayed invisible while a config that "covered" the file sat in the repo root.
 *
 * **So the invoked set is derived from the `package.json` scripts** — the strings a person or CI
 * actually runs — and coverage is asked only of those. This is the same instrument class as the
 * `Part`-union census and the `AGUI_EVENT_TYPE` census in the precondition suite, and as the
 * gate-chain writer census: **read the declaration, do not run the thing.** Every one of those
 * replaced a set written by a person with a set produced by the tree.
 *
 * THE FILE LIST COMES FROM `git ls-files`, so it is what the repo TRACKS rather than what happens to
 * be on this disk. An untracked scratch file is not a coverage gap, and a file deleted from the
 * worktree but still tracked is.
 *
 * THE MEMBERSHIP TEST IS THE COMPILER'S OWN. `ts.getParsedCommandLineOfConfigFile` returns the exact
 * `fileNames` `tsc` would read, with `extends`, `include`, `exclude` and `files` all resolved by the
 * compiler rather than by a re-implementation of its globbing here. A hand-rolled glob matcher would
 * be a second implementation that drifts from the first, which is the defect class this file is
 * about.
 *
 * IT IS RED TODAY AND THEREFORE UNGATED (`bin/smoke/gate-inventory.smoke.ts` carries the reason).
 * Every `smoke/` directory in the repo is outside its package's `include`, so this reports a real,
 * repo-wide gap on the day it lands. Making it green means widening those `include` arrays and
 * fixing whatever the compiler then finds across ~13 packages — a change that spans every lane and
 * is not this file's to make. **Asserting today's state instead would invert the suite's polarity:
 * green now, red on the day someone fixes it.**
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};

// ── The workspace's package directories, read from the workspace manifest rather than assumed.
//    A package added under a new top-level directory tomorrow is picked up here or nowhere.
const wsPath = join(ROOT, "pnpm-workspace.yaml");
const wsRaw = existsSync(wsPath) ? readFileSync(wsPath, "utf8") : "";
c("[input] pnpm-workspace.yaml is readable", wsRaw.length > 0, wsPath);

const globs: string[] = [];
let inPackages = false;
for (const line of wsRaw.split("\n")) {
  if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
  if (inPackages && /^\S/.test(line)) break; // a new top-level key ends the list
  const m = inPackages && line.match(/^\s*-\s*"?([^"\s]+)"?\s*$/);
  if (m) globs.push(m[1]);
}
c("[input] the workspace manifest declares package globs", globs.length > 0, JSON.stringify(globs));

/** Expand the manifest's globs. Only `*` appears in them, and an unsupported form is REFUSED. */
function expand(glob: string): string[] {
  const stars = (glob.match(/\*/g) ?? []).length;
  if (glob.includes("**") || stars > 2) throw new Error(`unsupported workspace glob ${glob}`);
  if (stars === 0) return existsSync(join(ROOT, glob)) ? [glob] : [];
  const parts = glob.split("/");
  let dirs = [""];
  for (const part of parts) {
    const next: string[] = [];
    for (const d of dirs) {
      if (part !== "*") { next.push(d ? `${d}/${part}` : part); continue; }
      const abs = join(ROOT, d);
      if (!existsSync(abs)) continue;
      for (const e of ts.sys.getDirectories(abs)) next.push(d ? `${d}/${e}` : e);
    }
    dirs = next;
  }
  return dirs.filter((d) => existsSync(join(ROOT, d, "package.json")));
}

const packages = [...new Set(globs.flatMap(expand))].sort();
console.log(`workspace packages: ${packages.length}`);

// ── The tsconfigs that are actually INVOKED, derived from the scripts a person runs.
//    A config nobody invokes provides no coverage no matter what its `include` says.
const INVOKE = /tsc\s+(?:[^&|]*?\s)?-p\s+(\S+)/g;
const invokedConfigs = new Set<string>();
const invokers: string[] = [];
for (const pkg of packages) {
  const pj = join(ROOT, pkg, "package.json");
  if (!existsSync(pj)) continue;
  const scripts = (JSON.parse(readFileSync(pj, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  for (const [name, body] of Object.entries(scripts))
    for (const m of body.matchAll(INVOKE)) {
      const cfg = resolve(ROOT, pkg, m[1]);
      if (!existsSync(cfg)) continue;
      invokedConfigs.add(cfg);
      invokers.push(`${pkg}:${name}`);
    }
}
console.log(`invoked tsconfigs: ${invokedConfigs.size} (from ${invokers.length} scripts)`);
c("[derivation] at least one tsconfig is invoked by a package script", invokedConfigs.size > 0);

// THE ROOT PROJECT, ASSERTED RATHER THAN DESCRIBED. The prose above claims nothing invokes it; a
// claim in a comment is a test nobody wrote. If a script ever starts invoking it, this cell flips
// and the comment must be rewritten — which is the point of asserting it.
c("[derivation] the repo-root tsconfig.json is invoked by NO package script",
  !invokedConfigs.has(join(ROOT, "tsconfig.json")));

/** The exact file set `tsc` would read for a config — the compiler's own answer, not a glob rewrite. */
function filesOf(configPath: string): string[] {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " "));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (!parsed) throw new Error(`could not parse ${configPath}`);
  return parsed.fileNames;
}

const covered = new Set<string>();
for (const cfg of [...invokedConfigs].sort()) {
  let names: string[];
  try {
    names = filesOf(cfg);
  } catch (e) {
    // A config that cannot be parsed is a FAILED CELL, never a skip: skipping it would shrink the
    // covered set and turn a broken config into a pile of false coverage gaps elsewhere.
    c(`[derivation] ${relative(ROOT, cfg)} parses`, false, (e as Error).message);
    continue;
  }
  for (const n of names) covered.add(resolve(n));
}
console.log(`files covered by an invoked tsconfig: ${covered.size}`);

// ── Every TypeScript file the repo TRACKS.
let tracked: string[] = [];
try {
  tracked = execFileSync("git", ["ls-files", "-z", "*.ts", "*.tsx", "*.mts", "*.cts"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  }).split("\0").filter(Boolean);
} catch (e) {
  console.log(`  git ls-files failed: ${(e as Error).message}`);
}
c("[input] the repo tracks TypeScript files", tracked.length > 0, `${tracked.length} files`);

/**
 * THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL.
 *
 * Every cell below fails when a file is missing from `covered`. A coverage computation that silently
 * produced an EMPTY set — a bad host, a throwing parse, a path-normalisation mismatch between
 * `git ls-files`' relative paths and the compiler's absolute ones — would fail every one of them and
 * read as an enormous finding. **A broken instrument and a real gap are identical from the failing
 * side.** So a file that MUST be covered is asserted first: if this cell fails, nothing below it
 * means anything, and the run says so rather than reporting a repo-wide catastrophe.
 */
const CONTROL = join(ROOT, "extensions", "connector-core", "src", "agui.ts");
c("[CONTROL] a `src` file IS covered by an invoked tsconfig (else every cell below is meaningless)",
  covered.has(CONTROL), relative(ROOT, CONTROL));

// ── One cell per package, with the uncovered files named in full. No sampling and no top-N: a
//    bounded list would read as "these are the gaps" while hiding the rest.
const byPackage = new Map<string, string[]>();
const orphans: string[] = [];
for (const rel of tracked) {
  const abs = join(ROOT, rel);
  if (covered.has(abs)) continue;
  const pkg = packages.find((p) => rel === p || rel.startsWith(`${p}/`));
  if (!pkg) { orphans.push(rel); continue; }
  byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), rel]);
}

for (const pkg of packages) {
  const missing = byPackage.get(pkg) ?? [];
  if (missing.length > 0) console.log(`  ${pkg}: ${missing.length} uncovered\n    ${missing.join("\n    ")}`);
  c(`[coverage] every tracked TypeScript file in ${pkg} is inside an invoked tsconfig`,
    missing.length === 0, `${missing.length} uncovered`);
}

// Files in no workspace package at all (`scripts/`, `remotion/`, loose top-level tooling). They are
// NAMED rather than dropped: a file outside every package is the least-watched file in the repo, and
// silently excluding it is how a category stops being counted.
if (orphans.length > 0) console.log(`  outside every workspace package: ${orphans.length}\n    ${orphans.join("\n    ")}`);
c("[coverage] every tracked TypeScript file belongs to some workspace package",
  orphans.length === 0, `${orphans.length} outside`);

console.log(`\ntsconfig-coverage: ${ok} passed, ${fail} failed`);
if (fail > 0)
  console.log(
    "\nA tsconfig that COVERS a file is not coverage — a script must INVOKE it. Every failure above\n" +
      "is a file the repo ships and no typecheck reads. This suite is expected to be red until the\n" +
      "package `include` arrays are widened; gate it in gate-inventory when it goes green.",
  );
if (fail > 0) process.exit(1);
