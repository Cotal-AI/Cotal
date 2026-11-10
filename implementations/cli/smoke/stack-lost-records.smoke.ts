/** Real CLI regression for a controller stack whose launching home records disappear. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { acquireMaintenanceLock, assertRecordIdentity, releaseMaintenanceLock } from "@cotal-ai/workspace";

if (process.platform !== "linux") {
  console.log("missing-home recovery requires Linux");
  process.exit(0);
}
const base = process.env.COTAL_LOST_HOME_TEST_ROOT ?? mkdtempSync(join(tmpdir(), "cotal-lost-home-"));
mkdirSync(base, { recursive: true, mode: 0o700 });
const home = join(base, "home"), root = join(base, "project"), other = join(base, "other-home");
for (const path of [home, root, other]) mkdirSync(path, { mode: 0o700 });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: base, XDG_CONFIG_HOME: join(base, "xdg"), COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
let anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
const binary = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
interface Pin { pid: number; token: string }
interface Journal { members: { role: string; instanceId: string | null; process?: Pin }[]; recovery?: { home: string; host: string }; operation: { kind: string; phase: string } }
function cli(args: string[], cotalHome = home) {
  const options = { cwd: root, env: { ...env, COTAL_HOME: cotalHome }, encoding: "utf8" as const, timeout: 150_000 };
  if (cotalHome === home) assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [binary, ...args, "--json"], options);
  assert.equal(result.error, undefined, result.error?.message);
  const data = JSON.parse(result.stdout) as { outcome?: string; result?: { kind?: string; selected?: { message?: string }; members?: { role: string; process: string }[]; signalled?: boolean }; error?: { code?: string; message?: string; remedy?: string } };
  return { exit: result.status, data };
}
const journalPath = join(root, ".cotal", "stack-controller.json");
const journal = (): Journal => JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
let pins: Pin[] = [], hidden = false, completed = false;
try {
  assert.equal(cli(["space", "create", "losthome"]).exit, 0);
  assert.equal(cli(["up", "--server", `nats://127.0.0.1:${await freePort()}`]).exit, 0);
  const started = journal();
  pins = started.members.flatMap((row) => row.process ? [row.process] : []);
  assert.equal(pins.length, 3, "real up must persist broker, delivery and manager creation pins");
  assert.equal(started.recovery?.home, home);
  assert(pins.every((pin) => assertRecordIdentity(pin).kind === "match"));
  assert.equal(cli(["down", "--yes"], other).exit, 2, "another home must not stop this stack");
  assert(pins.every((pin) => assertRecordIdentity(pin).kind === "match"));
  renameSync(home, `${home}-retained`); hidden = true;
  mkdirSync(home, { mode: 0o700 });
  anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
  const status = cli(["status"]);
  assert.equal(status.exit, 0);
  assert.match(status.data.result?.selected?.message ?? "", /member records are missing/);
  assert.doesNotMatch(status.data.result?.selected?.message ?? "", /runs under another/);
  const before = readFileSync(journalPath, "utf8");
  const preview = cli(["down", "--dry-run"]);
  assert.equal(preview.exit, 0);
  assert.equal(preview.data.result?.kind, "missing-records-stack-stop-preview");
  assert.deepEqual(preview.data.result?.members?.map((row) => row.role), ["manager", "delivery", "broker"]);
  assert.equal(preview.data.result?.signalled, false);
  assert.equal(readFileSync(journalPath, "utf8"), before, "preview must not write journal");
  assert(pins.every((pin) => assertRecordIdentity(pin).kind === "match"), "preview must stop nothing");
  assert.equal(cli(["down"]).exit, 1, "recovery must require explicit confirmation");
  assert.equal(cli(["down", "--with-agents", "--yes"]).exit, 1, "recovery cannot infer native agent impact");
  assert.equal(cli(["down", "--space", "other", "--yes"]).exit, 2);
  // Malformed or incomplete authority is exercised through the shipped command on this real stack.
  for (const unavailable of [
    { ...started, recovery: undefined },
    { ...started, recovery: { ...started.recovery!, host: "0".repeat(64) } },
    { ...started, members: started.members.map((row) => row.role === "broker" ? { ...row, process: undefined } : row) },
  ]) {
    writeFileSync(journalPath, JSON.stringify(unavailable), { mode: 0o600 });
    assert.equal(cli(["down", "--yes"]).exit, 2);
    assert(pins.every((pin) => assertRecordIdentity(pin).kind === "match"));
  }
  writeFileSync(journalPath, before, { mode: 0o600 });
  const lock = acquireMaintenanceLock(root, { operation: "recovery-smoke" });
  try {
    assert.equal(cli(["down", "--yes"]).exit, 2, "a held maintenance lock must block recovery");
    assert(pins.every((pin) => assertRecordIdentity(pin).kind === "match"));
  } finally { releaseMaintenanceLock(lock); }
  assert.equal(cli(["down", "--yes"]).exit, 0);
  assert(pins.every((pin) => ["gone", "mismatch"].includes(assertRecordIdentity(pin).kind)), "every exact member must have exited");
  assert.equal(journal().operation.phase, "completed");
  assert.equal(cli(["down", "--yes"]).exit, 0, "repeated recovery must stop nothing else");
  assert.equal(cli(["space", "create", "losthome"]).exit, 0);
  assert.equal(cli(["up"]).exit, 0, "the recovered space can start again from retained store and trust");
  pins = journal().members.flatMap((row) => row.process ? [row.process] : []);
  assert.equal(cli(["down", "--yes"]).exit, 0, "ordinary stop still works after recreation");
  assert(pins.every((pin) => ["gone", "mismatch"].includes(assertRecordIdentity(pin).kind)), "restarted member must have exited");
  completed = true;
  console.log("PASS: missing-home diagnostics, no-write preview, confirmation, foreign-home, host, missing-pin and lock refusal, exact member exit, repeat, recreation and ordinary stop");
} finally {
  // A failed scenario restores the original home only to stop any remaining original members.
  if (hidden) {
    if (existsSync(home)) renameSync(home, `${home}-recreated`);
    renameSync(`${home}-retained`, home);
    anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
  }
  if (!completed) {
    const cleanup = cli(["down", "--yes"]);
    assert.equal(cleanup.exit, 0, "owned stack cleanup must complete");
  }
  assert(pins.every((pin) => ["gone", "mismatch"].includes(assertRecordIdentity(pin).kind)), "owned member must not remain running");
}
