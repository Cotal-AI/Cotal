import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionIdentity, logicalExecutionEntry } from "../src/execution-identity.js";

const root = mkdtempSync(join(tmpdir(), "execution-identity-"));
const key = Symbol.for("cotal.execution.identity");
const installed = join(root, "prefix/lib/node_modules/cotal-ai");
const loaded = join(root, "prefix/lib/.cotal-generations", "a".repeat(32), "cotal-ai");
try {
  assert.equal(executionIdentity(), undefined);
  for (const path of [installed, loaded]) {
    mkdirSync(join(path, "dist"), { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "./dist/cotal.js" } }));
    writeFileSync(join(path, "dist/cotal.js"), "");
  }
  const logicalEntry = join(installed, "dist/cotal.js"), loadedEntry = join(loaded, "dist/cotal.js");
  Reflect.set(globalThis, key, Object.freeze({ logicalEntry, loadedEntry }));
  assert.equal(logicalExecutionEntry(), logicalEntry);
  assert.equal(executionIdentity()?.loadedEntry, loadedEntry);
  Reflect.set(globalThis, key, { logicalEntry, loadedEntry });
  assert.throws(executionIdentity, /invalid execution identity/);
  Reflect.set(globalThis, key, Object.freeze({ logicalEntry, loadedEntry: logicalEntry.replace("cotal.js", "other.js") }));
  assert.throws(executionIdentity);
  Reflect.set(globalThis, key, Object.freeze({ logicalEntry: loadedEntry, loadedEntry: logicalEntry }));
  assert.throws(executionIdentity, /outside the owning generation store/);
  console.log("execution identity: missing, logical/loaded, unfrozen, undeclared and escaping entries checked");
} finally {
  Reflect.deleteProperty(globalThis, key);
  rmSync(root, { recursive: true, force: true });
}
