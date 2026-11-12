/** Native Windows secret-file path and ACL regression, also run by smoke:secret-fs. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, toNamespacedPath } from "node:path";
import { hardenPrivate, mkSecretDir, writeSecretFile, writeSecretFileAtomic, writeSecretFileCreateOnly } from "../src/secret-fs.js";

if (process.platform !== "win32") {
  console.log("Windows long-path ACL proof: skipped on non-Windows host");
} else {
  const root = mkdtempSync(join(tmpdir(), "cotal-acl-path-"));
  const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  let readbacks = 0;
  const acl = (path: string): string => {
    const saved = join(root, `acl-${readbacks++}.txt`);
    // /save records the native DACL as SDDL, independent of localized principal names.
    execFileSync(icacls, [toNamespacedPath(path), "/save", saved], { stdio: "pipe" });
    const lines = readFileSync(saved).toString("utf16le").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    assert.equal(lines.length, 2, "one native path and one saved DACL");
    assert.match(lines[1]!, /^D:P/, "DACL inheritance is disabled");
    assert.doesNotMatch(lines[1]!, /\(A;[^)]*;(?:WD|AU|BU|S-1-1-0|S-1-5-11|S-1-5-32-545)\)/, "no broad grant");
    const dacl = lines[1]!;
    const aces = dacl.match(/\([^)]*\)/g) ?? [];
    assert.equal(aces.length, 3, "only the owner, SYSTEM and Administrators grants");
    assert.ok(aces.every(ace => ace.startsWith("(A;")), "only allow ACEs can be order-normalized");
    // Windows may reorder equally ranked explicit allow ACEs across parent directories.
    return dacl.slice(0, dacl.indexOf("(")) + aces.sort().join("");
  };
  const failures: string[] = [];
  const prove = (label: string, run: () => void): void => {
    try { run(); console.log(`PASS ${label}`); }
    catch (error) { failures.push(label); console.error(`FAIL ${label}`, error); }
  };
  try {
    const short = join(root, "short.secret");
    writeSecretFile(short, "public-test-fixture\n");
    const shortAcl = acl(short);
    let deep = root;
    while (deep.length < 310) deep = join(deep, "nested-path-component");
    // Node creates the same ordinary spelling that production hands to the native hardener.
    mkdirSync(deep, { recursive: true });
    const directoryAcl = join(root, "short-directory");
    mkSecretDir(directoryAcl);
    const shortDirectoryAcl = acl(directoryAcl);
    prove("directory over 300 characters hardens with the short-directory DACL", () => {
      assert.ok(deep.length >= 300);
      hardenPrivate(deep, "dir");
      assert.equal(acl(deep), shortDirectoryAcl);
    });
    const writers = [
      ["write", writeSecretFile],
      ["atomic", writeSecretFileAtomic],
      ["create-only", writeSecretFileCreateOnly],
    ] as const;
    for (const [label, write] of writers) {
      const path = join(deep, `${label}.secret`);
      prove(`${label}: secret over 300 characters has identical native DACL`, () => {
        assert.ok(path.length >= 300);
        console.log(JSON.stringify({ writer: label, pathCharacters: path.length, parentCharacters: dirname(path).length }));
        write(path, "public-test-fixture\n");
        assert.equal(readFileSync(path, "utf8"), "public-test-fixture\n");
        assert.equal(acl(path), shortAcl);
      });
    }
    prove("relative: writer retains identical native DACL", () => {
      const cwd = process.cwd();
      try {
        process.chdir(root);
        const path = relative(root, join(deep, "relative.secret"));
        writeSecretFile(path, "public-test-fixture\n");
        assert.equal(acl(path), shortAcl);
      } finally { process.chdir(cwd); }
    });
    prove("already-namespaced: writer retains identical native DACL", () => {
      const path = toNamespacedPath(join(deep, "namespaced.secret"));
      writeSecretFile(path, "public-test-fixture\n");
      assert.equal(acl(path), shortAcl);
    });
    for (const parent of [root, deep]) prove(`missing path refuses at parent length ${parent.length}`, () => {
      const missing = join(parent, "does-not-exist.secret");
      assert.equal(existsSync(missing), false);
      assert.throws(() => hardenPrivate(missing, "file"), /failed to harden file.*via icacls/s);
      assert.equal(existsSync(missing), false);
    });
    assert.deepEqual(failures, [], "all native long-path and fail-closed checks must pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
