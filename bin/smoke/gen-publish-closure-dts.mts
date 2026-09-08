/**
 * Emit `scripts/verify-publish-closure.d.mts` from `verify-publish-closure.mjs`, so the two cannot
 * disagree.
 *
 * WHY THIS EXISTS. The gate stays plain `.mjs` because the release workflow runs it directly, before
 * any workspace build and without a TypeScript loader. Its smoke suite is `.ts`, so it needs a
 * declaration beside it or the import is an implicit `any` (TS7016).
 *
 * A hand-written declaration would be a SECOND source of truth about a gate that decides whether a
 * release is complete, and a type that lies is worse than no type: the compiler becomes confidently
 * wrong about the thing checking the release. So the declaration is not written, it is emitted by the
 * compiler from the module, and `smoke:verify-publish-closure` asserts the committed file is byte for
 * byte what the compiler emits today. Nothing is being pattern-matched, so there is no shape to miss.
 *
 * Run: pnpm gen:publish-closure-dts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE = join(ROOT, "scripts/verify-publish-closure.mjs");
const TARGET = join(ROOT, "scripts/verify-publish-closure.d.mts");

const HEADER = [
  "// Generated from verify-publish-closure.mjs by gen-publish-closure-dts.mts. Do not edit:",
  "// run `pnpm gen:publish-closure-dts`. The module is the only source of truth for these types;",
  "// `pnpm smoke:verify-publish-closure` fails if they drift.",
].join("\n");

/** The exact emit. Kept in one place so the generator and the drift check cannot disagree either. */
export function emitDeclaration(): string {
  const out = mkdtempSync(join(tmpdir(), "publish-closure-dts-"));
  try {
    execFileSync(
      "npx",
      [
        "tsc", MODULE,
        "--allowJs", "--declaration", "--emitDeclarationOnly",
        "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext",
        "--outDir", out,
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    const emitted = readFileSync(join(out, "verify-publish-closure.d.mts"), "utf8");
    // Drop the shebang the compiler copies across; it is meaningless in a declaration.
    return `${HEADER}\n${emitted.replace(/^#!.*\n/, "")}`;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  writeFileSync(TARGET, emitDeclaration());
  process.stdout.write(`wrote ${TARGET}\n`);
}
