import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { jcodeCredentialMirrorInventory, mirrorJcodeCredentials } from "../src/private-state.js";

const root = mkdtempSync(join(tmpdir(), "cotal-cursor-credentials-"));
const home = join(root, "seat");
const sources = { jcodeHome: join(root, "jcode"), appConfigDir: join(root, "config"), externalHome: join(root, "external") };
const expected = [
  { key: "cursorAuth/accessToken", value: "synthetic-access" },
  { key: "cursorAuth/refreshToken", value: "synthetic-refresh" },
  { key: "storage.serviceMachineId", value: "synthetic-machine" },
];
const snapshot = (path: string) => {
  const stat = statSync(path);
  return { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mode: stat.mode & 0o777, ino: stat.ino, size: stat.size };
};
const rows = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT key, value FROM ItemTable ORDER BY key").all().map(row => ({ ...row })); }
  finally { db.close(); }
};
let checked = 0;
let failed = 0;
const check = (name: string, actual: unknown, wanted: unknown) => {
  checked++;
  try { assert.deepEqual(actual, wanted); console.log(`ok ${name}`); }
  catch { failed++; console.log(`FAIL ${name}`); }
};
try {
  for (const dir of [home, ...Object.values(sources)]) mkdirSync(dir, { mode: 0o700 });
  const entries = jcodeCredentialMirrorInventory(home, sources).filter(entry => entry.destinationRelative.endsWith("state.vscdb"));
  check("all six Cursor path variants are exercised", entries.length, 6);
  const before = new Map<string, ReturnType<typeof snapshot>>();
  for (const entry of entries) {
    mkdirSync(dirname(entry.source), { recursive: true, mode: 0o700 });
    writeFileSync(entry.source, "", { flag: "wx", mode: 0o600 });
    const db = new DatabaseSync(entry.source);
    try {
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
      const insert = db.prepare("INSERT INTO ItemTable VALUES (?, ?)");
      for (const row of expected) insert.run(row.key, row.value);
      insert.run("unrelated.editor.state", "x".repeat(1024 * 1024));
    } finally { db.close(); }
    before.set(entry.source, snapshot(entry.source));
  }
  mirrorJcodeCredentials(home, sources);
  console.log(`CURSOR MIRROR BYTES: ${JSON.stringify({ files: entries.length,
    source: entries.map(entry => statSync(entry.source).size),
    mirrored: entries.map(entry => statSync(join(home, entry.destinationRelative)).size) })}`);
  for (const [index, entry] of entries.entries()) {
    const destination = join(home, entry.destinationRelative);
    const copied = rows(destination);
    check(`path ${index}: native auth values preserved`, copied.filter(row => expected.some(auth => auth.key === row.key)), expected);
    check(`path ${index}: no unrelated editor state`, copied.length, 3);
    check(`path ${index}: compact database`, statSync(destination).size < 64 * 1024, true);
    check(`path ${index}: source conserved`, snapshot(entry.source), before.get(entry.source));
    check(`path ${index}: private independent file`, (statSync(destination).mode & 0o777) === 0o600 && statSync(destination).ino !== statSync(entry.source).ino, true);
  }
  const entry = entries[0]!;
  const destination = join(home, entry.destinationRelative);
  const writer = new DatabaseSync(entry.source);
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    writer.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run("synthetic-rotated", expected[0]!.key);
    mirrorJcodeCredentials(home, sources);
    check("rotation includes committed WAL values", rows(destination).find(row => row.key === expected[0]!.key)?.value, "synthetic-rotated");
  } finally { writer.close(); }
  const prior = snapshot(destination);
  writeFileSync(entry.source, "not a SQLite database", { mode: 0o600 });
  let refused = false;
  try { mirrorJcodeCredentials(home, sources); } catch { refused = true; }
  check("invalid database refuses rather than copying arbitrary state", refused, true);
  check("failed projection does not publish partial output", snapshot(destination), prior);
  rmSync(entry.source);
  mirrorJcodeCredentials(home, sources);
  check("removed source removes its exact old mirror", existsSync(destination), false);
  check("removal preserves other Cursor mirrors", entries.slice(1).every(other => existsSync(join(home, other.destinationRelative))), true);
} finally { rmSync(root, { recursive: true, force: true }); }
assert.equal(checked, 36);
console.log(`CURSOR CREDENTIALS: ${checked - failed}/${checked} passed`);
process.exitCode = failed ? 1 : 0;
