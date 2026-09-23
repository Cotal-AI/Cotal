/**
 * Emit `scripts/preflight-npm-publish.d.mts` from `preflight-npm-publish.mjs`.
 *
 * The preflight stays plain `.mjs` because `ci:publish` runs it before any workspace build.
 * The smoke suite is `.ts`, so it needs a declaration beside the module or the import is
 * an implicit `any` (TS7016). The declaration is emitted from the module, not handwritten.
 *
 * Run: pnpm gen:npm-publish-preflight-dts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE = join(ROOT, "scripts/preflight-npm-publish.mjs");
const TARGET = join(ROOT, "scripts/preflight-npm-publish.d.mts");

const HEADER = [
  "// Generated from preflight-npm-publish.mjs by gen-npm-publish-preflight-dts.mts. Do not edit:",
  "// run `pnpm gen:npm-publish-preflight-dts`. The module is the only source of truth for these types;",
  "// `pnpm smoke:npm-publish-preflight` fails if they drift.",
].join("\n");

export function emitDeclaration(): string {
  const out = mkdtempSync(join(tmpdir(), "npm-publish-preflight-dts-"));
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
    const emitted = readFileSync(join(out, "preflight-npm-publish.d.mts"), "utf8");
    return `${HEADER}\n${emitted.replace(/^#!.*\n/, "")}`;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  writeFileSync(TARGET, emitDeclaration());
  process.stdout.write(`wrote ${TARGET}\n`);
}
