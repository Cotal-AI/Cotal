/** Parser regression only. No broker, credentials or service writer. */
import assert from "node:assert/strict";
import { parseNativeUidCustody } from "../src/native-uid-custody.js";
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const uid = "a".repeat(32), legacy = { owner: "owner", actor: "actor", mintedBy: "legacy", extraAudit: true };
assert.deepEqual(parseNativeUidCustody(enc(legacy), uid), { kind: "ordinary", owner: "owner", actor: "actor" });
for (const kind of ["native-service-uid@2", "service", "ordinary", "", null, 1, false])
  assert.throws(() => parseNativeUidCustody(enc({ ...legacy, kind }), uid), /closed schema|invalid coordinates/);
console.log("native UID custody: unknown own kind refuses, legacy no-kind audit unchanged (8 checks)");
