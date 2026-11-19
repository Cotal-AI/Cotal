import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function inventory(root: string): string {
  const rows: unknown[] = [];
  const walk = (path: string, name: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) rows.push([name, "link", readlinkSync(path)]);
    else if (info.isDirectory()) for (const entry of readdirSync(path).sort()) walk(join(path, entry), `${name}/${entry}`);
    else rows.push([name, createHash("sha256").update(readFileSync(path)).digest("hex")]);
  };
  walk(root, "");
  return JSON.stringify(rows);
}

const root = mkdtempSync(join(tmpdir(), "execution-preinstall-"));
try {
  for (const name of ["home", "config", "cotal", "runtime"]) mkdirSync(join(root, name), { mode: 0o700 });
  const installedEntry = join(import.meta.dirname, "../dist/cotal.js");
  const request = { v: 1, nonce: randomBytes(16).toString("hex"), installedEntry, daemonArgv: [process.execPath, "--max-semi-space-size=1", installedEntry, "daemon", "serve"], flags: {} };
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: join(root, "home"), COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime") };
  const run = (input = request) => spawnSync(process.execPath, [join(import.meta.dirname, "../dist/execution-preinstall.js"), JSON.stringify(input)], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  const before = inventory(root);
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  const receipt = JSON.parse(accepted.stdout.trim().slice("COTAL_PREINSTALL_RESULT ".length));
  assert.equal(receipt.nonce, request.nonce);
  assert.equal(receipt.occupied, 0);
  assert.equal(receipt.daemon, undefined);
  assert.deepEqual(receipt.admission, { disposition: "restart-empty", occupied: 0, hostedSpaces: [] }, "no daemon runs, so nothing is hosted and activation is not deferred");
  assert.deepEqual(receipt.hostedSpaces, []);
  assert.equal(inventory(root), before);
  mkdirSync(join(root, "cotal/daemon"), { mode: 0o700 });
  writeFileSync(join(root, "cotal/daemon/service-unit.json"), "{", { mode: 0o600 });
  const damaged = inventory(root);
  const deferred = run();
  assert.equal(deferred.status, 0, deferred.stderr);
  const decision = JSON.parse(deferred.stdout.trim().slice("COTAL_PREINSTALL_RESULT ".length));
  assert.equal(decision.admission.disposition, "deferred");
  assert.equal(decision.admission.occupied, null, "unreadable custody is not zero work");
  assert.equal(decision.occupied, 0, "released updaters refuse a receipt whose occupied is not a non-negative integer");
  assert.match(decision.admission.reason, /no installed unit/);
  assert.equal(inventory(root), damaged);
  const invalid = run({ ...request, nonce: "unbound" });
  assert.notEqual(invalid.status, 0);
  assert.equal(inventory(root), damaged);
  writeFileSync(join(root, "cotal/daemon/daemon.lock"), "malformed", { mode: 0o600 });
  const unsafe = inventory(root);
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /identity is unreadable/);
  assert.ok(!refused.stdout.includes("COTAL_PREINSTALL_RESULT"));
  assert.equal(inventory(root), unsafe);
  console.log("execution preinstall: real read-only target admits an absent daemon, defers unknown native custody without inventing zero work, refuses unreadable lifetime/request, and writes nothing");
} finally { rmSync(root, { recursive: true, force: true }); }
