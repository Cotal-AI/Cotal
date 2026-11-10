/** Local capacity failures through the built CLI, with Linux RLIMIT_FSIZE and unlimited controls. */
import assertBase from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import { localWriteFailure, type Envelope } from "@cotal-ai/workspace";
import { LEGACY_DEFAULT_AGENT } from "../../implementations/cli/src/lib/default-persona.js";

if (process.platform !== "linux") skipSuite("local-write-failure: Linux prlimit is required");
const counted = countedAssert(assertBase);
const assert: typeof assertBase = counted.assert as typeof assertBase;
const bin = join(import.meta.dirname, "..", "dist", "cotal.js");
assert.ok(existsSync(bin), "build cotal-ai before running this suite");
const root = mkdtempSync(join(tmpdir(), "cotal-write-failure-"));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR"].includes(key)));
function fixture(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  for (const child of ["home", "project", "config", "tmp"]) mkdirSync(join(dir, child), { mode: 0o700 });
  return {
    dir, cwd: join(dir, "project"),
    env: { ...inherited, HOME: join(dir, "home"), USERPROFILE: join(dir, "home"), COTAL_HOME: join(dir, "home", "state"), XDG_CONFIG_HOME: join(dir, "config"), TMPDIR: join(dir, "tmp"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" },
  };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, args: string[], limit?: number) {
  const argv = [bin, ...args];
  const r = spawnSync(limit === undefined ? process.execPath : "prlimit", limit === undefined ? argv : [`--fsize=${limit}:unlimited`, process.execPath, ...argv], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 30_000 });
  assert.ifError(r.error);
  assert.equal(r.signal, null, `command must report its own failure: ${r.stderr}`);
  console.log(JSON.stringify({ args, limit: limit ?? null, status: r.status, stdout: r.stdout, stderr: r.stderr }));
  return r;
}
function ok(f: Fixture, args: string[]) {
  const r = run(f, args);
  assert.equal(r.status, 0, r.stderr);
  return r;
}
function envelope(f: Fixture, args: string[]) { return JSON.parse(ok(f, [...args, "--json"]).stdout) as Envelope<Record<string, unknown>>; }
function refused(f: Fixture, args: string[], limit: number, mode: "text" | "plain" | "json") {
  const r = run(f, [...args, ...(mode === "text" ? [] : [`--${mode}`])], limit);
  assert.equal(r.status, 2, r.stderr || r.stdout);
  const text = mode === "json" ? r.stdout : r.stderr;
  assert.match(text, /EFBIG/);
  assert.match(text, /nothing was written to the destination/);
  assert.match(text, /file-size limit/);
  assert.match(text, /retry/);
  assert.doesNotMatch(text, /SCHEMA_INVALID|OPERATION_UNKNOWN|invalid persona fields/);
  if (mode === "json") {
    assert.equal(r.stderr, "");
    const doc = JSON.parse(r.stdout) as Envelope;
    assert.equal(doc.outcome, "refused");
    assert.equal(doc.error?.code, "TARGET_UNAVAILABLE");
    assert.equal(doc.error?.cause?.code, "EFBIG");
    assert.ok(doc.error?.remedy);
    assert.ok((doc.target as { path?: string }).path);
    return doc;
  }
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /Next/);
  assert.match(r.stderr, /TARGET_UNAVAILABLE/);
  return undefined;
}
function copiedJournal(f: Fixture) {
  const path = join(f.cwd, ".cotal", "stack-controller.json");
  mkdirSync(join(f.cwd, ".cotal"), { mode: 0o700 });
  const now = new Date().toISOString();
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, kind: "cotal-stack-controller", root: join(f.dir, "old-project"),
    space: "adopt-space", server: "nats://127.0.0.1:4222", mode: "open",
    members: ["broker", "auth", "delivery", "manager"].map(role => ({ role, definition: `stack-${role}`, instanceId: null, state: "not-attempted" })),
    operation: { id: "60460000-0000-4000-8000-000000000001", kind: "up", phase: "refused", recordedAt: now, withAgents: false }, updatedAt: now,
  }, null, 2) + "\n", { mode: 0o600 });
  return path;
}
const prompt = "x".repeat(760);
for (const mode of ["text", "plain", "json"] as const) {
  const s = fixture(`space-${mode}`);
  const doc = refused(s, ["space", "create", "s"], 64, mode);
  const record = join(s.dir, "home", "state", "prepared", "space.73.json");
  if (doc) assert.equal((doc.target as { path: string }).path, record);
  assert.equal(existsSync(record), false);
  assert.deepEqual(readdirSync(join(s.dir, "home", "state", "prepared")), []);
  assert.deepEqual(envelope(s, ["space"]).result?.prepared, []);
  assert.equal(existsSync(join(s.cwd, ".cotal")), false);
  ok(s, ["space", "create", "s"]);

  const c = fixture(`config-${mode}`);
  ok(c, ["space", "create", "s"]);
  const file = join(c.dir, "config", "cotal", "preferences.json");
  refused(c, ["config", "set", "persona", "planner", "--space", "s"], 40, mode);
  assert.equal(existsSync(file), false);
  assert.deepEqual(readdirSync(join(c.dir, "config", "cotal")), []);
  assert.equal((envelope(c, ["config", "get", "persona", "--space", "s"]).result?.setting as { value: string }).value, "default");
  ok(c, ["config", "set", "persona", "original", "--space", "s"]);
  const before = readFileSync(file);
  refused(c, ["config", "set", "persona", "y".repeat(128), "--space", "s"], 200, mode);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(join(c.dir, "config", "cotal")), ["preferences.json"]);
  ok(c, ["config", "set", "persona", "planner", "--space", "s"]);
  assert.equal((envelope(c, ["config", "get", "persona", "--space", "s"]).result?.setting as { value: string }).value, "planner");

  const p = fixture(`persona-${mode}`);
  ok(p, ["space", "create", "s"]);
  const args = ["persona", "create", "big", "--prompt", prompt, "--subscribe", ""];
  refused(p, args, 100, mode);
  assert.deepEqual(readdirSync(join(p.cwd, ".cotal", "agents")), ["default.md"]);
  assert.deepEqual(readdirSync(join(p.dir, "tmp")), []);
  const source = join(p.dir, "big.md");
  writeFileSync(source, `---\nname: big\nsubscribe: []\n---\n\n${prompt}\n`);
  refused(p, ["persona", "create", "big", "--file", source], 100, mode);
  assert.deepEqual(readdirSync(join(p.cwd, ".cotal", "agents")), ["default.md"]);
  ok(p, args);
  assert.deepEqual((envelope(p, ["persona"]).result?.items as { name: string }[]).map(item => item.name), ["big", "default"]);
}
for (const mode of ["text", "plain", "json"] as const) {
  for (const limit of [40, 200]) {
    const f = fixture(`adopt-${mode}-${limit}`);
    const path = copiedJournal(f);
    const before = readFileSync(path);
    const doc = refused(f, ["space", "create", "adopt-space", "--adopt"], limit, mode);
    if (doc) assert.equal((doc.target as { path: string }).path, path);
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readdirSync(join(f.cwd, ".cotal")), ["stack-controller.json"]);
    assert.deepEqual(envelope(f, ["space"]).result?.prepared, []);
    ok(f, ["space", "create", "adopt-space", "--adopt"]);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).root, f.cwd);
    assert.equal((envelope(f, ["space"]).result?.prepared as unknown[]).length, 1);
  }
  // A non-writable parent survives Cotal's permission hardening of its own home.
  if (process.getuid?.() !== 0) {
    const f = fixture(`adopt-preparation-${mode}`);
    const path = copiedJournal(f);
    const parent = join(f.dir, "home", "sealed");
    mkdirSync(parent, { mode: 0o700 });
    f.env.COTAL_HOME = join(parent, "state");
    chmodSync(parent, 0o500);
    let r: ReturnType<typeof run>;
    try { r = run(f, ["space", "create", "adopt-space", "--adopt", ...(mode === "text" ? [] : [`--${mode}`])]); }
    finally { chmodSync(parent, 0o700); }
    assert.equal(r.status, 4, r.stdout || r.stderr);
    const text = mode === "json" ? r.stdout : r.stderr;
    assert.match(text, /OPERATION_PARTIAL/);
    assert.match(text, /earlier changes remain/);
    assert.match(text, /without --adopt/);
    assert.doesNotMatch(text, /nothing was written/);
    if (mode === "json") {
      const receipt = JSON.parse(r.stdout) as Envelope;
      assert.deepEqual(receipt.changed, [{ what: `stack journal, adopted from ${join(f.dir, "old-project")}`, path }]);
    }
    assert.equal(JSON.parse(readFileSync(path, "utf8")).root, f.cwd);
    assert.deepEqual(envelope(f, ["space"]).result?.prepared, []);
    ok(f, ["space", "create", "adopt-space"]);
  }
}
const legacy = fixture("legacy-default-partial");
const legacyPath = join(legacy.cwd, ".cotal", "agents", "default.md");
mkdirSync(join(legacy.cwd, ".cotal", "agents"), { recursive: true, mode: 0o700 });
writeFileSync(legacyPath, LEGACY_DEFAULT_AGENT, { mode: 0o600 });
const migration = run(legacy, ["space", "create", "legacy-space", "--json"], 350);
assert.equal(migration.status, 4, migration.stdout || migration.stderr);
const migrationReceipt = JSON.parse(migration.stdout) as Envelope;
assert.equal(migrationReceipt.error?.code, "OPERATION_PARTIAL");
assert.match(migrationReceipt.error?.message ?? "", /this file may be incomplete/);
assert.equal((migrationReceipt.target as { path: string }).path, legacyPath);
assert.equal(migrationReceipt.changed?.length, 1);
assert.equal(readFileSync(legacyPath).length, 350);

const late = fixture("space-partial");
const partial = run(late, ["space", "create", "s", "--json"], 350);
assert.equal(partial.status, 4, partial.stdout || partial.stderr);
const receipt = JSON.parse(partial.stdout) as Envelope;
assert.equal(receipt.outcome, "partial");
assert.equal(receipt.error?.code, "OPERATION_PARTIAL");
assert.equal(receipt.error?.cause?.code, "EFBIG");
assert.match(receipt.error?.message ?? "", /earlier changes remain/);
assert.doesNotMatch(receipt.error?.message ?? "", /nothing was written/);
assert.equal(receipt.changed?.length, 1);
assert.match((receipt.changed?.[0] as { path: string }).path, /prepared\/space\.73\.json$/);
assert.equal((envelope(late, ["space"]).result?.prepared as unknown[]).length, 1);
assert.equal(readFileSync(join(late.cwd, ".cotal", "agents", "default.md")).length, 350);

// Other capacity errnos share the live EFBIG mapping. Unrelated errors are not recast as capacity failures.
for (const code of ["ENOSPC", "EDQUOT", "EFBIG"]) {
  const failure = localWriteFailure(Object.assign(new Error("sensitive bytes"), { code }), "/record");
  assert.equal(failure?.code, "TARGET_UNAVAILABLE");
  assert.equal(failure?.native?.code, code);
  assert.doesNotMatch(failure?.message ?? "", /sensitive bytes/);
}
assert.equal(localWriteFailure(new Error("validation"), "/record"), undefined);
assert.equal(localWriteFailure(Object.assign(new Error("I/O"), { code: "EIO" }), "/record"), undefined);
console.log(`LOCAL WRITE FAILURE SMOKE OK; retained fixtures: ${root}`);
emitSentinel({ passed: counted.cells(), failed: 0 });
