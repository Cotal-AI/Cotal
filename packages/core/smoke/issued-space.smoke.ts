import assert from "node:assert/strict";
import {
  issuedEvidenceKey, issuedSourcePrefix, issuedSourceIndexKey, actorLedgerSource,
  openIssuedStore, type IssuedAuthorityRef, type IssuedSourceRef,
} from "../src/issued-authority.js";
import { endpointToken } from "../src/endpoint-subjects.js";
import { token } from "../src/subjects.js";
import type { KV } from "@nats-io/kv";
import type { JetStreamManager } from "@nats-io/jetstream";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let passed = 0, failed = 0;
function check(name: string, run: () => void): void {
  try { assert.doesNotThrow(run, name); passed++; console.log(`  ✓ ${name}`); }
  catch (error) {
    failed++;
    console.error(`  ✗ FAIL: ${name}`, error);
    console.error("COTAL_ISSUED_SPACE_FAILURE " + JSON.stringify({ name, errorName: (error as Error).name, message: (error as Error).message }));
  }
}
const space = "u_example-member";
const ref: IssuedAuthorityRef = { space, owner: "local", actor: "caller", uid: "a".repeat(26), generation: "b".repeat(32) };
const source: IssuedSourceRef = { space, bucket: `cotal_auth_${space}`, key: `cred.${ref.uid}` };
// Opening the real store constructs its methods without accessing either handle. Any unexpected
// I/O here throws, so these assertions cannot silently become synthetic store operations.
const untouched = new Proxy({}, { get() { throw new Error("unexpected broker I/O before a store operation"); } });
const open = (name: string) => openIssuedStore(untouched as KV, untouched as JetStreamManager, name);

check("issued reference accepts a canonical underscore space unchanged", () => {
  assert.equal(token(space), space);
  assert.equal(issuedEvidenceKey(ref), `v1.local.caller.${ref.uid}.${ref.generation}`);
});
check("issued source accepts a canonical underscore space unchanged", () => {
  assert.match(issuedSourcePrefix(source), /^bysource\.v1\.[a-f0-9]{64}\.$/);
  assert.equal(issuedSourceIndexKey(source, ref), issuedSourcePrefix(source) + issuedEvidenceKey(ref).slice(3));
  assert.equal(actorLedgerSource(space, ref.owner, ref.actor, ref.uid).space, space);
});
check("issued store accepts a canonical underscore space unchanged", () => {
  assert.equal(typeof open(space).stage, "function");
});
check("issued spaces retain the canonical routing alphabet without DNS length bounds", () => {
  for (const name of ["main", "UPPER_01", "_", "-leading", "trailing-", "a".repeat(65)]) {
    assert.equal(token(name), name);
    assert.doesNotThrow(() => issuedEvidenceKey({ ...ref, space: name }));
    assert.doesNotThrow(() => issuedSourcePrefix({ ...source, space: name }));
    assert.doesNotThrow(() => open(name));
  }
});
check("issued reference rejects wildcard separator whitespace and malformed spaces", () => {
  for (const name of ["", "*", ">", "a.b", "a/b", "a\\b", "a:b", " main", "main ", "a b", "a\n", "a\0", "é", 1, null, ["main"]])
    assert.throws(() => issuedEvidenceKey({ ...ref, space: name as string }));
});
check("issued source rejects wildcard separator whitespace and malformed spaces", () => {
  for (const name of ["", "*", ">", "a.b", "a/b", "a\\b", "a:b", " main", "main ", "a b", "a\n", "a\0", "é", 1, null, ["main"]])
    assert.throws(() => issuedSourcePrefix({ ...source, space: name as string }));
});
check("issued store rejects wildcard separator whitespace and malformed spaces", () => {
  for (const name of ["", "*", ">", "a.b", "a/b", "a\\b", "a:b", " main", "main ", "a b", "a\n", "a\0", "é", 1, null, ["main"]])
    assert.throws(() => open(name as string));
});
check("issued source foreign space and malformed bucket or key still refuse", () => {
  assert.throws(() => issuedSourceIndexKey({ ...source, space: "foreign_space" }, ref), /foreign space/);
  for (const bucket of ["", "*", "a.b", "a/b", "a".repeat(129)])
    assert.throws(() => issuedSourcePrefix({ ...source, bucket }));
  for (const key of ["", "*", ">", "a..b", "a/b", "a ", "a".repeat(1025)])
    assert.throws(() => issuedSourcePrefix({ ...source, key }));
});
check("issued caller principal lifecycle and generation grammars are unchanged", () => {
  assert.throws(() => issuedEvidenceKey({ ...ref, owner: "bad-owner" }));
  assert.throws(() => issuedEvidenceKey({ ...ref, actor: "bad.actor" }));
  assert.throws(() => issuedEvidenceKey({ ...ref, uid: "invalid" }));
  assert.throws(() => issuedEvidenceKey({ ...ref, generation: "B".repeat(32) }));
});
check("endpoint DNS grammar remains distinct from canonical space grammar", () => {
  assert.equal(endpointToken("com.example.endpoint"), "com_example_endpoint");
  for (const name of [space, "UPPER", "_", "-leading", "trailing-", "a".repeat(65), "*", ">", "a/b"])
    assert.throws(() => endpointToken(name));
});
console.log(`ISSUED SPACE SMOKE (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
