/** The CLI and core catalog readers agree on real files, errors and file metadata. No mesh. */
import { strict as assert } from "node:assert";
import { isDeepStrictEqual } from "node:util";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPersonaCatalog, saveAgentFile } from "@cotal-ai/core";
import { listPersonas, readPersonas } from "../src/lib/personas.js";

const scratch = mkdtempSync(join(tmpdir(), "cotal-shared-catalog-"));
let passed = 0, failed = 0;
function check(name: string, condition: boolean) {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}`); }
}
const throwsCode = (read: () => unknown, code: string) => {
  try { read(); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === code; }
};
const root = join(scratch, "files");
const dir = join(root, ".cotal", "agents");
try {
  const missing = join(scratch, "missing");
  check("core missing catalog is empty", listPersonaCatalog(missing).length === 0);
  check("CLI missing catalog is empty", readPersonas(missing).length === 0);

  const notFolder = join(scratch, "not-folder");
  mkdirSync(join(notFolder, ".cotal"), { recursive: true });
  writeFileSync(join(notFolder, ".cotal", "agents"), "not a directory");
  check("core forgiving listing retains empty result for a non-folder", listPersonaCatalog(notFolder).length === 0);
  check("CLI forgiving listing retains empty result for a non-folder", listPersonas(notFolder).length === 0);
  check("CLI strict listing still throws ENOTDIR", throwsCode(() => readPersonas(notFolder), "ENOTDIR"));

  mkdirSync(dir, { recursive: true });
  saveAgentFile(join(dir, "alpha.md"), { name: "alpha", role: "reviewer", subscribe: [], persona: "Private fixture only." });
  writeFileSync(join(dir, "broken.md"), "missing frontmatter");
  writeFileSync(join(dir, "utf16.md"), Buffer.from("﻿---\nname: utf16\n---\nFixture\n", "utf16le"));
  writeFileSync(join(dir, "notes.txt"), "ignored");
  mkdirSync(join(dir, "folder.md"));
  symlinkSync("alpha.md", join(dir, "linked.md"));
  symlinkSync("absent.md", join(dir, "dangling.md"));
  symlinkSync("loop.md", join(dir, "loop.md"));
  const core = listPersonaCatalog(root), cli = readPersonas(root);
  check("both catalogs have the same sorted filename stems", core.map((e) => e.name).join() === "alpha,broken,dangling,folder,linked,loop,utf16" && core.map((e) => e.name).join() === cli.map((e) => e.name).join());
  check("CLI strict and forgiving readers agree for a readable catalog", isDeepStrictEqual(cli, listPersonas(root)));
  for (const entry of cli) check(`${entry.name}: core and CLI rows agree including metadata`, isDeepStrictEqual(core.find((e) => e.name === entry.name), entry));
  check("valid persona remains parsed", core.find((e) => e.name === "alpha")?.def?.role === "reviewer");
  check("malformed persona remains an error row", typeof core.find((e) => e.name === "broken")?.error === "string");

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    for (const mode of [0o000, 0o600]) {
      chmodSync(dir, mode);
      check(`mode ${mode.toString(8)}: core forgiving listing remains empty`, listPersonaCatalog(root).length === 0);
      check(`mode ${mode.toString(8)}: CLI forgiving listing remains empty`, listPersonas(root).length === 0);
      check(`mode ${mode.toString(8)}: CLI strict listing refuses access`, throwsCode(() => readPersonas(root), "EACCES"));
      chmodSync(dir, 0o700);
    }
  } else console.log("SKIP permission-bit cases: requires a non-root POSIX account");
} finally {
  try { chmodSync(dir, 0o700); } catch { /* directory was not created */ }
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`SHARED PERSONA CATALOG: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "core and CLI share catalog behavior");
