import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the published entry, with no broker or managed process and no inherited mesh state.
const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(bin), "build the binary first: pnpm --filter cotal-ai... build");
const root = mkdtempSync(join(tmpdir(), "cotal-seats-inventory-"));
const home = join(root, "home");
mkdirSync(home);
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const file = join(root, "not-a-directory");
writeFileSync(file, "inventory guard control\n");
const empty = join(root, "empty");
mkdirSync(empty);
let failed = 0;
let passed = 0;
function check(name: string, body: () => void): void {
  try { body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${String(error)}`); }
}
function run(store: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...hostEnv, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", COTAL_NO_PROMPT: "1", COTAL_SEAT_ROOT: store, NO_COLOR: "1", COLUMNS: "240" },
    encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  console.log(JSON.stringify({ store, args, status: result.status, stdout: result.stdout, stderr: result.stderr }));
  return result;
}

if (process.platform === "linux") {
  const badStores: Array<[string, string]> = [[file, "ENOTDIR"], [join(file, "nested"), "ENOTDIR"]];
  const loop = join(root, "loop");
  symlinkSync(loop, loop);
  badStores.push([loop, "ELOOP"]);
  const denied = join(root, "denied");
  mkdirSync(denied);
  chmodSync(denied, 0);
  if (process.getuid?.() !== 0) badStores.push([denied, "EACCES"]);
  for (const [store, code] of badStores) {
    for (const flags of [[], ["--plain"], ["--json"], ["--drain", "--dry-run"], ["--drain", "--yes", "--json"]]) {
      check(`${code} ${store === file ? "file" : store === loop ? "loop" : store === denied ? "denied" : "file parent"} ${flags.join(" ") || "listing"}`, () => {
        const result = run(store, ["manager", "seats", ...flags]);
        assert.equal(result.status, 2);
        if (flags.includes("--json")) {
          const envelope = JSON.parse(result.stdout);
          assert.equal(envelope.outcome, "refused");
          assert.equal(envelope.error.code, "DEPENDENCY_UNAVAILABLE");
          assert.equal(envelope.target.root, store);
          assert.equal(envelope.error.cause.code, code);
          assert.ok(envelope.error.cause.detail.includes(code));
          assert.ok(envelope.error.message.includes(store));
          assert.ok(envelope.error.remedy.includes("COTAL_SEAT_ROOT"));
          assert.equal(envelope.error.message.includes("no drain was submitted"), flags.includes("--drain"));
        } else {
          const text = result.stdout + result.stderr;
          assert.ok(text.includes("DEPENDENCY_UNAVAILABLE"), text);
          assert.ok(text.includes(store), text);
          assert.ok(text.includes(code), text);
          assert.ok(text.includes("Next"), text);
          assert.ok(text.includes("COTAL_SEAT_ROOT"), text);
          assert.equal(text.includes("no drain was submitted"), flags.includes("--drain"));
        }
        assert.equal(readFileSync(file, "utf8"), "inventory guard control\n");
      });
    }
  }
  chmodSync(denied, 0o700);
  for (const store of [empty, join(root, "missing")]) {
    for (const command of [["manager", "seats"], ["seats"]]) {
      for (const flags of [["--json"], ["--drain", "--dry-run", "--json"], ["--drain", "--yes", "--json"]]) {
        check(`empty census ${command.join(" ")} ${flags.join(" ")} ${store === empty ? "existing" : "missing"}`, () => {
          const result = run(store, [...command, ...flags]);
          assert.equal(result.status, 0);
          const envelope = JSON.parse(result.stdout);
          assert.deepEqual(envelope.result.entries, []);
          assert.equal(envelope.target.root, store);
          assert.equal(envelope.result.drainSubmitted, false);
          if (store !== empty) assert.equal(existsSync(store), false);
        });
      }
    }
  }
  check("legacy seats spelling has the same refusal", () => {
    const result = run(file, ["seats", "--json"]);
    const envelope = JSON.parse(result.stdout);
    assert.equal(result.status, 2);
    assert.equal(envelope.error.cause.code, "ENOTDIR");
    assert.ok(envelope.error.message.includes(file));
  });
} else {
  check("unsupported host keeps its native reason and remedy", () => {
    const result = run(file, ["manager", "seats", "--json"]);
    const envelope = JSON.parse(result.stdout);
    assert.equal(result.status, 2);
    assert.equal(envelope.error.code, "UNSUPPORTED");
    assert.ok(envelope.error.cause.detail.includes("unsupported"));
    assert.ok(envelope.error.remedy.includes("Linux"));
  });
}
console.log(`seats-inventory: ${passed} passed, ${failed} failed; retained fixtures: ${root}`);
process.exitCode = failed === 0 ? 0 : 1;
