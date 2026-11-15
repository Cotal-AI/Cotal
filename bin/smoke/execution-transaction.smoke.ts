import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionDescriptorPath, executionStore, selectExecutionProgram } from "../cotal.js";
import { assertExecutionDestination, executionStagingPrefix, journalExecutionTransaction, publishExecutionTransaction, retainExecutionGeneration, retireSupersededExecutionDescriptor } from "../execution-transaction.js";

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
    writeFileSync(join(installed, "desktop-runtime.json"), "{}");
    assert.throws(() => assertExecutionDestination(installed), /unavailable on the desktop runtime/);
    assert.throws(() => executionStagingPrefix(installed), /unavailable on the desktop runtime/);
    assert.equal(existsSync(executionStore(installed)), false);
    assert.equal(existsSync(executionDescriptorPath(installed)), false);
    rmSync(join(installed, "desktop-runtime.json"));
    const oldManifest = readFileSync(join(installed, "package.json"), "utf8");
    const oldProgram = readFileSync(join(installed, "dist/cotal-program.js"), "utf8");
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.2.0", bin: { cotal: "./dist/cotal.js" } }));
    writeFileSync(join(source, "dist/cotal-program.js"), "export const version = 'new';\n");
    const generation = retainExecutionGeneration(installed, source);
    const journal = journalExecutionTransaction(installed, generation);
    publishExecutionTransaction(installed, journal);
    assert.equal(selectExecutionProgram(installed).root, generation.root);
    assert.equal(retireSupersededExecutionDescriptor(installed), false, "active matching descriptor is never retired");
    assert.equal(readFileSync(join(installed, "package.json"), "utf8"), oldManifest, "npm record is never rewritten by staged publication");
    assert.equal(readFileSync(join(installed, "dist/cotal-program.js"), "utf8"), oldProgram);
    const nextSource = join(scratch, "next/cotal-ai");
    cpSync(source, nextSource, { recursive: true });
    writeFileSync(join(nextSource, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.3.0", bin: { cotal: "./dist/cotal.js" } }));
    const next = retainExecutionGeneration(installed, nextSource);
    const secondJournal = journalExecutionTransaction(installed, next);
    publishExecutionTransaction(installed, secondJournal);
    assert.equal(selectExecutionProgram(installed).root, next.root);
    publishExecutionTransaction(installed, secondJournal, true);
    assert.equal(selectExecutionProgram(installed).root, generation.root, "second rollback restores previous selected generation, not npm original version");
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.4.0", bin: { cotal: "./dist/cotal.js" } }));
    assert.equal(selectExecutionProgram(installed).retained, false, "in-place replacement takes over selection");
    assert.equal(existsSync(executionDescriptorPath(installed)), true);
    assert.equal(retireSupersededExecutionDescriptor(installed), true, "superseded descriptor is retired when in-place install takes over");
    assert.equal(existsSync(executionDescriptorPath(installed)), false);
    writeFileSync(join(installed, "package.json"), oldManifest);
    publishExecutionTransaction(installed, journal);
    assert.equal(selectExecutionProgram(installed).root, generation.root);
    publishExecutionTransaction(installed, journal, true);
    assert.equal(selectExecutionProgram(installed).root, installed);
    assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, "0.1.0");
    assert.equal(readFileSync(join(installed, "dist/cotal-program.js"), "utf8"), oldProgram);
    console.log("execution transaction: publication and rollback preserve canonical product bytes");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
