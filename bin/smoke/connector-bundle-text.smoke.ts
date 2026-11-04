/**
 * Every connector bundle that ships into a long-running process is one-byte text.
 *
 * A seat's bundle is held in V8 as one string for the process's life. V8 stores a string as
 * one byte per character only while every character is Latin-1; a single character above U+00FF
 * makes the whole 5 MB two-byte. The claude connector's bundle had 388 such characters, 325 of them
 * em dashes in comments, and that alone cost 5.7 MiB of V8's large-object space per seat.
 *
 * esbuild escapes non-ASCII in strings and identifiers by default, so comments are the only way one
 * reaches a bundle, and `--minify-whitespace` drops comments while keeping every identifier. This
 * reads the BUILT bundles, produced here by each package's own `bundle` script, and fails on any
 * character above U+00FF. The counts are literals: a new esbuild call in one of these packages
 * fails the count until it is listed here, which is also when someone checks that it carries the
 * flag.
 *
 * Run: pnpm smoke:connector-bundle-text
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Each package whose bundles load into a long-running process, with how many bundles it emits. */
const PACKAGES: ReadonlyArray<readonly [string, number]> = [
  ["extensions/connector-claude-code", 5],
  ["extensions/connector-codex", 2],
  ["extensions/connector-hermes", 3],
  ["extensions/connector-jcode", 3],
  ["extensions/connector-opencode", 4],
  ["extensions/pi", 2],
];
const EXPECTED_BUNDLES = 19;

/** A step that copies one of connector-core's prebuilt docs data files beside the bundles. It emits
 *  no JavaScript, so it is neither a bundle nor a way for another bundler to slip in. */
const DOCS_DATA_COPY = /^node -e "require\('node:fs'\)\.copyFileSync\('\.\.\/connector-core\/src\/docs-(?:index|bundle)\.bin','[^']+\.bin'\)"$/;

/** Every esbuild call in a package's `bundle` script: its `--outfile`, plus what is wrong with it. */
function bundleCalls(pkgDir: string): { outs: string[]; problems: string[] } {
  const pkg = JSON.parse(readFileSync(join(repoRoot, pkgDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.bundle;
  if (script === undefined) return { outs: [], problems: [`${pkgDir} has no bundle script`] };
  const outs: string[] = [];
  const problems: string[] = [];
  for (const call of script.split(" && ")) {
    if (DOCS_DATA_COPY.test(call.trim())) continue;
    if (!call.trimStart().startsWith("esbuild")) problems.push(`${pkgDir}: bundle runs something other than esbuild: ${call}`);
    if (!call.includes(" --minify-whitespace ")) problems.push(`${pkgDir}: esbuild call without --minify-whitespace: ${call}`);
    const out = /--outfile=(\S+)/.exec(call);
    if (out === null) problems.push(`${pkgDir}: esbuild call with no --outfile: ${call}`);
    else outs.push(out[1]!);
  }
  return { outs, problems };
}

let checked = 0;
let scanned = 0;
for (const [pkgDir, count] of PACKAGES) {
  const { outs: declared, problems } = bundleCalls(pkgDir);
  check(`${pkgDir} builds every bundle with --minify-whitespace`, problems.length === 0, problems);
  check(`${pkgDir} declares ${count} bundles`, declared.length === count, declared);
  // Built by the shipped script, so the bytes asserted on are the bytes a release produces.
  execFileSync("pnpm", ["run", "bundle"], { cwd: join(repoRoot, pkgDir), stdio: "pipe" });
  for (const out of declared) {
    const text = readFileSync(join(repoRoot, pkgDir, out), "utf8");
    const above = text.match(/[^\u0000-ÿ]/gu) ?? [];
    check(`${pkgDir}/${out} is one-byte text`, above.length === 0, { above: above.length, sample: [...new Set(above)].slice(0, 8) });
    checked += 1;
    scanned += text.length;
  }
}

check(`every connector bundle was read (${EXPECTED_BUNDLES} expected)`, checked === EXPECTED_BUNDLES, checked);
console.log(`  bundles checked: ${checked}, characters scanned: ${scanned}`);

finish();
