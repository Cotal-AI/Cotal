import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectExecutionProgram } from "../cotal.js";
import { journalExecutionTransaction, publishExecutionTransaction, retainExecutionGeneration } from "../execution-transaction.js";

if (["linux", "darwin"].includes(process.platform)) {
  const scratch = mkdtempSync(join(tmpdir(), "execution-transaction-"));
  const installed = join(scratch, "prefix/lib/node_modules/cotal-ai"), source = join(scratch, "source/cotal-ai");
  try {
    for (const root of [installed, source]) {
      mkdirSync(join(root, "dist"), { recursive: true });
      cpSync(join(import.meta.dirname, "../dist/cotal.js"), join(root, "dist/cotal.js"));
      writeFileSync(join(root, "dist/cotal-program.js"), "export const version = 'old';\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.1.0", bin: { cotal: "./dist/cotal.js" } }));
    }
    const oldManifest = readFileSync(join(installed, "package.json"), "utf8");
    const oldProgram = readFileSync(join(installed, "dist/cotal-program.js"), "utf8");
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.2.0", bin: { cotal: "./dist/cotal.js" } }));
    writeFileSync(join(source, "dist/cotal-program.js"), "export const version = 'new';\n");
    const generation = retainExecutionGeneration(installed, source);
    const journal = journalExecutionTransaction(installed, generation);
    publishExecutionTransaction(installed, journal);
    assert.equal(selectExecutionProgram(installed).root, generation.root);
    assert.equal(readFileSync(join(installed, "package.json"), "utf8"), oldManifest, "npm record is never rewritten by staged publication");
    assert.equal(readFileSync(join(installed, "dist/cotal-program.js"), "utf8"), oldProgram);
    publishExecutionTransaction(installed, journal, true);
    assert.equal(selectExecutionProgram(installed).root, installed);
    assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, "0.1.0");
    assert.equal(readFileSync(join(installed, "dist/cotal-program.js"), "utf8"), oldProgram);
    console.log("execution transaction: publication and rollback preserve canonical product bytes");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
