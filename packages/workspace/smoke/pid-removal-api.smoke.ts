/** Public workspace entrypoint regression for the removed unlocked pin remover (#3737). */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workspace from "@cotal-ai/workspace";

assert.equal(Object.hasOwn(workspace, "removeIdentityPin"), false, "the shipped package must not export the unlocked remover");
// @ts-expect-error The shipped declarations must also omit the removed export.
void workspace.removeIdentityPin;
assert.equal(typeof workspace.removePidPair, "function", "the locked replacement remains public");

const root = mkdtempSync(join(tmpdir(), "pid-removal-api-"));
const path = join(root, "fixture.pid");
const pin = workspace.identityPinPath(path);
workspace.writePidPair(path, process.pid);
assert.equal(workspace.verifyIdentityPin(path).kind, "match", "the live fixture starts pinned");
const before = readFileSync(pin, "utf8");

// A stale adjudication must preserve the pair. These are fixture files only; no process is stopped.
workspace.removePidPair(path, String(process.pid + 1));
assert.equal(workspace.readPidfile(path), String(process.pid));
assert.equal(readFileSync(pin, "utf8"), before);
assert.equal(workspace.verifyIdentityPin(path).kind, "match", "a stale removal preserves the pin");

workspace.removePidPair(path, String(process.pid));
assert.equal(existsSync(path), false, "the matching fixture pidfile is removed");
assert.equal(existsSync(pin), false, "the matching fixture pin is removed with it");
workspace.removePidPair(path, String(process.pid));
assert.equal(existsSync(path), false, "removing an absent pair is harmless");
assert.equal(existsSync(pin), false);

// Retain the private fixture directory for failure investigation.
console.log("pid removal API smoke: removed export and locked replacement controls passed");
