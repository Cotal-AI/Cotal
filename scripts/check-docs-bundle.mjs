#!/usr/bin/env node
// The docs-bundle half of `pnpm check:docsbundle`.
//
// The bundle is no longer committed, so there is no tracked artifact to diff and no drift to
// detect: the connector's own `build` and `typecheck` regenerate it from the sources every time.
// What a release still needs is the property the old diff enforced by accident — THE GENERATOR
// MUST PRODUCE REAL DOCS FROM THE REAL SOURCES. A generator that throws, or that quietly emits a
// bundle with no pages, would ship a connector whose `cotal_docs` answers nothing.
//
// So this runs the generator into a TEMPORARY path and grades what it wrote:
//   - it exits non-zero if the generator fails (an empty or missing source throws by design),
//   - it exits non-zero if the bundle it produced is hollow.
//
// Writing to a temp path rather than the connector's source keeps the check side-effect free, so
// running it never leaves a half-written artifact behind for a later build to compile.
//
// A pass proves the bundle carries the pages. It does not prove the pages agree with the code: a
// page that quotes a line the binary no longer prints bundles as faithfully as a correct one.
// `check-docs-literals.mjs` binds the quoted operator strings to the source that emits them.
//
// Exit 0 clean, 1 the bundle is hollow, 2 the generator could not run.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every source the generator reads must be represented in what it writes. A bundle that parses
// but carries no pages, no spec, no lang reference or no schema is hollow, and hollow docs are
// the failure this check exists to stop reaching a release.
function graded(bundle) {
  const failures = [];
  if (!Array.isArray(bundle.pages) || bundle.pages.length === 0) failures.push("no pages");
  else {
    const empty = bundle.pages.filter((p) => !p.slug || !p.title || !p.body?.trim());
    if (empty.length > 0) failures.push(`${empty.length} page(s) with no slug, title or body`);
  }
  for (const key of ["spec", "lang", "schema"]) {
    if (!bundle[key]?.body?.trim()) failures.push(`${key} has no body`);
  }
  if (!bundle.version) failures.push("no version stamp");
  return failures;
}

// The generator emits TypeScript, not JSON: a banner, an import, `DOCS_VERSION`, then
// `export function loadDocsBundle(): DocsBundle { return { … }; }`. The object literal is
// `JSON.stringify`'d, so slicing it back out and parsing it as JSON reads exactly what was written
// with no TypeScript toolchain in the way.
function bundleObject(source) {
  const open = source.indexOf("return {");
  if (open === -1) throw new Error("generated bundle does not declare loadDocsBundle");
  const close = source.lastIndexOf("};");
  if (close === -1 || close < open) throw new Error("generated bundle is truncated");
  return JSON.parse(source.slice(open + "return ".length, close + 1));
}

const dir = mkdtempSync(join(tmpdir(), "cotal-docsbundle-"));
const out = join(dir, "docs-bundle.generated.ts");
try {
  try {
    execFileSync("node", [join(repoRoot, "scripts", "generate-docs-bundle.mjs"), "--out", out], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    console.error("check:docsbundle: the generator failed; the sources cannot produce a bundle.");
    process.exit(2);
  }

  let bundle;
  try {
    bundle = bundleObject(readFileSync(out, "utf8"));
  } catch (error) {
    console.error(`check:docsbundle: the generated bundle could not be read: ${error.message}`);
    process.exit(2);
  }

  const failures = graded(bundle);
  if (failures.length > 0) {
    console.error(`check:docsbundle: the generated bundle is hollow: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(
    `check:docsbundle: the generator produces ${bundle.pages.length} pages + spec + lang + schema for Cotal v${bundle.version} from the sources`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
