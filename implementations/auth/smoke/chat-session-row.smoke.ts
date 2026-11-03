import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatSessionAliasPresent, listChatSessionRowNames, readChatSessionRow } from "../src/chat-session-row.js";

const root = mkdtempSync(join(tmpdir(), "cotal-chat-row-"));
const owner = `u_${"a".repeat(26)}`;
const actor = `chat_${"b".repeat(26)}`;
let passed = 0, failed = 0;
function check(name: string, run: () => void): void {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}`, error); }
}

try {
  for (const kind of ["absent", "empty", "dangling-link", "directory-link", "file"] as const) {
    const dir = join(root, kind);
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, "chat-sessions");
    if (kind === "empty") mkdirSync(path, { mode: 0o700 });
    if (kind === "file") writeFileSync(path, "not a row directory", { mode: 0o600 });
    if (kind === "dangling-link" || kind === "directory-link") {
      const target = join(dir, "target");
      if (kind === "directory-link") mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, path, "junction");
      check(`${kind}: fixture is a link, not an absent entry`, () => assert.equal(lstatSync(path).isSymbolicLink(), true));
    }
    const readers = [
      ["read", () => readChatSessionRow(dir, owner, actor), undefined],
      ["alias", () => chatSessionAliasPresent(dir, owner, actor), false],
      ["list", () => listChatSessionRowNames(dir, "", 16), []],
    ] as const;
    for (const [name, read, empty] of readers) {
      check(`${kind}: ${name}`, () => {
        if (kind === "absent" || kind === "empty") assert.deepEqual(read(), empty);
        else assert.throws(read, { code: "failed-precondition" });
      });
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
