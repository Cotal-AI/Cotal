// `pnpm test` for this package: the declared smoke files, one process each, run in parallel.
// Settings and grading are documented in @cotal-ai/smoke-kit's run-files.ts and the README.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFiles } from "@cotal-ai/smoke-kit";

const FILES = [
  "grammar",
  "keys",
  "journal",
  "fuzz-journal",
  "pins",
  "scopes",
  "sim",
  "interpret",
  "fuel",
  "dryrun",
  "examples",
  "options",
  "notify-fact",
  "migrate",
  "semantics",
  "surface",
  "conformance",
  "transform",
  "differential",
  "engine",
].map((n) => `${n}.smoke.ts`);

const { ok } = await runFiles({
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  dir: "smoke",
  files: FILES,
  excluded: { "wait-until.smoke.ts": "not part of this package's test chain; CI runs it as its own suite" },
});
process.exitCode = ok ? 0 : 1;
