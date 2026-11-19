import "./update-isolation.js";
import nodeAssert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert } from "@cotal-ai/smoke-kit";
import { CommandFailure } from "@cotal-ai/workspace";
import { update, updateRuntime } from "../src/commands/update.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const reason = "installation is not writable; use the owning command: npm install -g --prefix /fixture cotal-ai@latest";
let preflight = 0, later = 0;
let scratch = "";
const temporaryBefore = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
await assert.rejects(update({ values: { self: true }, positionals: [], raw: ["--self"] }, {
  ...updateRuntime,
  preflightExecution() {
    preflight++;
    scratch = tmpdir();
    assert.equal(process.env.TMP, scratch);
    assert.equal(process.env.TEMP, scratch);
    if (process.platform !== "win32") assert.equal(statSync(scratch).mode & 0o777, 0o700, "update scratch is private");
    throw new Error(reason);
  },
  version() { later++; return "0.164.18"; },
  npm() { later++; throw new Error("must not reach npm after a preflight refusal"); },
}), (error: unknown) => {
  assert.ok(error instanceof CommandFailure, "a side-effect-free preflight refusal is classified, not an unknown outcome");
  assert.equal(error.outcome, "refused");
  assert.equal(error.code, "DEPENDENCY_UNAVAILABLE");
  assert.ok(error.message.includes(reason), "the original refusal and owning command survive");
  assert.ok(error.message.includes("no changes were made"));
  return true;
});
assert.equal(preflight, 1);
assert.equal(later, 0, "no update work follows the refused preflight");
assert.equal(existsSync(scratch), false, "refusal cleans up private update scratch");
assert.deepEqual({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }, temporaryBefore, "refusal restores the caller's temporary-directory environment");
const run = (kind: string, json = false) => spawnSync(process.execPath, [...process.execArgv,
  join(import.meta.dirname, "update-self-refusal.fixture.ts"), "update", "--self", ...(json ? ["--json"] : [])], {
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), UPDATE_REFUSAL_FIXTURE: kind, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", DO_NOT_TRACK: "1" },
  encoding: "utf8", timeout: 15_000,
});
const human = run("unwritable");
assert.equal(human.status, 2, human.stderr);
assert.match(human.stderr, /Request refused/);
assert.match(human.stderr, /installation is not writable/);
assert.match(human.stderr, /npm install -g --prefix \/fixture cotal-ai@latest/);
assert.match(human.stderr, /no changes were made/);
assert.doesNotMatch(human.stderr, /Outcome unconfirmed|OPERATION_UNKNOWN/);
const classified = run("classified");
assert.equal(classified.status, 2, classified.stderr);
assert.match(classified.stderr, /UNSUPPORTED/);
assert.match(classified.stderr, /fixture unsupported installation/);
assert.match(classified.stderr, /use the owning installer/);
console.log(`COTAL_SMOKE_SENTINEL cells=${counted.cells()} passed=${counted.cells()} failed=0`);
