import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { executionBinding, executionDescriptorName, executionStore, selectExecutionProgram } from "../cotal.js";
import { describeExecutionGeneration, retainExecutionGeneration, writeExecutionDescriptor } from "../execution-store.js";

const repo = join(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "execution-generation-"));
const root = join(scratch, "prefix/lib/node_modules/cotal-ai"), source = join(scratch, "source/cotal-ai");
let checks = 0;
const check = (label: string, run: () => void): void => { run(); checks++; console.log(`✓ ${label}`); };
const packageAt = (directory: string, version: string, message: string): void => {
  mkdirSync(join(directory, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "cotal-ai", version, type: "module", bin: { cotal: "./dist/cotal.js" } }));
  cpSync(join(repo, "bin/dist/cotal.js"), join(directory, "dist/cotal.js"));
  writeFileSync(join(directory, "dist/cotal-program.js"), `console.log(${JSON.stringify(message)});`);
};
const run = () => spawnSync(process.execPath, [join(root, "dist/cotal.js"), "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 10_000 });
try {
  packageAt(root, "0.1.0", "initial generation");
  packageAt(source, "0.2.0", "retained generation selected");
  check("bootstrap imports only node built-ins and one selected program", () => {
    for (const file of [join(repo, "bin/cotal.ts"), join(repo, "bin/dist/cotal.js")]) {
      const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      let handoffs = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) assert.ok(ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("node:"));
        if (ts.isExportDeclaration(node)) assert.equal(node.moduleSpecifier, undefined);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          assert.equal(node.arguments.length, 1);
          assert.equal(node.arguments[0]!.getText(tree), "pathToFileURL(selected.entry).href");
          handoffs++;
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
      assert.equal(handoffs, 1);
    }
  });
  check("missing descriptor runs the initial tree and writes no cache or store", () => {
    const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "initial generation");
    assert.equal(existsSync(executionStore(root)), false); assert.equal(existsSync(join(root, executionDescriptorName)), false);
  });
  check("read-only initial package starts without any materialization", () => {
    chmodSync(root, 0o500);
    try { const result = run(); assert.equal(result.status, 0, result.stderr); } finally { chmodSync(root, 0o700); }
    assert.equal(existsSync(executionStore(root)), false);
  });
  if (!["linux", "darwin"].includes(process.platform)) {
    check("retained stores refuse unsupported platforms before mutation", () => {
      assert.throws(() => retainExecutionGeneration(root, source), /unavailable on this platform/);
      assert.equal(existsSync(executionStore(root)), false);
    });
    console.log(`execution generations: ${checks} checks passed; retained selection unavailable on this platform`);
  } else {
  check("generation store refuses a non-writable installation before creating it", () => {
    const parent = join(scratch, "prefix/lib"); chmodSync(parent, 0o500);
    try { assert.throws(() => retainExecutionGeneration(root, source), /not writable; use the owning command/); }
    finally { chmodSync(parent, 0o700); }
    assert.equal(existsSync(executionStore(root)), false);
  });
  const generation = retainExecutionGeneration(root, source);
  check("retention copies a complete graph and creates no active descriptor", () => {
    assert.equal(readFileSync(join(generation.root, "dist/cotal-program.js"), "utf8"), readFileSync(join(source, "dist/cotal-program.js"), "utf8"));
    assert.equal(existsSync(join(root, executionDescriptorName)), false);
    assert.equal(readdirSync(executionStore(root)).length, 1);
  });
  const descriptor = describeExecutionGeneration(root, generation);
  writeExecutionDescriptor(root, descriptor);
  check("real built entry selects and executes the retained program", () => {
    const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "retained generation selected");
    assert.equal(selectExecutionProgram(root).root, generation.root);
  });
  check("a bootstrap bound to a different artifact runs the installed tree without writing", () => {
    const stale = { ...descriptor, binding: { ...descriptor.binding, bootstrapSha256: "0".repeat(64) } };
    writeExecutionDescriptor(root, stale);
    const file = join(root, executionDescriptorName), bytes = readFileSync(file), before = lstatSync(file).mtimeMs;
    const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "initial generation");
    assert.deepEqual(readFileSync(file), bytes); assert.equal(lstatSync(file).mtimeMs, before);
    writeExecutionDescriptor(root, descriptor);
  });
  check("a malformed binding is not proof of a different installed artifact", () => {
    writeFileSync(join(root, executionDescriptorName), JSON.stringify({ ...descriptor, binding: {} }));
    assert.throws(() => selectExecutionProgram(root), /invalid execution artifact binding/);
    writeExecutionDescriptor(root, descriptor);
  });
  check("matching unknown descriptor protocol refuses with reinstall guidance", () => {
    writeFileSync(join(root, executionDescriptorName), JSON.stringify({ ...descriptor, v: 999 }));
    const result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /unsupported execution descriptor version 999.*reinstall with npm install -g/);
    assert.equal(result.stdout, ""); writeExecutionDescriptor(root, descriptor);
  });
  check("a matching descriptor never falls back after a missing target", () => {
    writeExecutionDescriptor(root, { ...descriptor, generation: { ...descriptor.generation, id: "f".repeat(32) } });
    const result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /reinstall with npm install -g/); assert.equal(result.stdout, "");
    writeExecutionDescriptor(root, descriptor);
  });
  check("inventory modification refuses before any product output", () => {
    const entry = join(generation.root, "dist/cotal-program.js"), bytes = readFileSync(entry);
    writeFileSync(entry, "console.log('corrupted program');");
    const result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /inventory differs/); assert.equal(result.stdout, "");
    writeFileSync(entry, bytes);
  });
  check("extra files also invalidate the retained inventory", () => {
    const extra = join(generation.root, "extra"); writeFileSync(extra, "added");
    assert.throws(() => selectExecutionProgram(root), /inventory differs/); rmSync(extra);
  });
  check("malformed descriptor refuses rather than inferring a fresh install", () => {
    writeFileSync(join(root, executionDescriptorName), "{"); const result = run(); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    writeExecutionDescriptor(root, descriptor);
  });
  check("oversized descriptor is refused before parsing", () => {
    writeFileSync(join(root, executionDescriptorName), " ".repeat(4 * 1024 * 1024 + 1));
    assert.throws(() => selectExecutionProgram(root), /unsafe execution record/);
    writeExecutionDescriptor(root, descriptor);
  });
  check("a group-writable descriptor cannot select retained code", () => {
    const file = join(root, executionDescriptorName); chmodSync(file, 0o620);
    try { assert.throws(() => selectExecutionProgram(root), /unprotected execution entry/); }
    finally { chmodSync(file, 0o600); }
  });
  check("descriptor symlink refuses without reading a foreign record", () => {
    const file = join(root, executionDescriptorName); rmSync(file); symlinkSync(join(scratch, "absent"), file);
    assert.throws(() => selectExecutionProgram(root), /unsafe execution record/); rmSync(file); writeExecutionDescriptor(root, descriptor);
  });
  check("retention rejects a dependency link escaping the verified package", () => {
    const link = join(source, "escape"); symlinkSync(root, link);
    assert.throws(() => retainExecutionGeneration(root, source), /link escapes/); rmSync(link);
    assert.equal(readdirSync(executionStore(root)).length, 1);
  });
  check("retained directory symlinks cannot substitute a different store", () => {
    const store = executionStore(root), other = join(scratch, "other"); mkdirSync(other);
    const container = join(store, "e".repeat(32)); symlinkSync(other, container);
    writeExecutionDescriptor(root, { ...descriptor, generation: { ...descriptor.generation, id: "e".repeat(32) } });
    assert.throws(() => selectExecutionProgram(root), /unsafe execution generation/); rmSync(container); writeExecutionDescriptor(root, descriptor);
  });
  check("binding still names the unchanged declared executable", () => {
    assert.deepEqual(descriptor.binding, executionBinding(root));
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).bin.cotal, "./dist/cotal.js");
  });
  console.log(`execution generations: ${checks} checks passed`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
