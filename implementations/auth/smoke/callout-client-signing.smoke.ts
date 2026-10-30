/** The load harness's native signer emits the stock authenticator's exact JWT, key and signatures. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSpaceAuth, mintCreds, newIdentity } from "@cotal-ai/core";
import { credsAuthenticator } from "@nats-io/transport-node";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { clientSigning, nativeLoadAuthenticator } from "./_callout-load-signing.js";

let checks = 0;
function check(value: unknown, label: string): asserts value {
  assert.ok(value, label);
  checks++;
}
const auth = await createSpaceAuth(`client-signing-${randomUUID().slice(0, 8)}`);
for (let key = 0; key < 4; key++) {
  const creds = await mintCreds(auth, newIdentity(), "observer");
  const stock = credsAuthenticator(new TextEncoder().encode(creds));
  const native = nativeLoadAuthenticator(creds);
  try {
    for (const nonce of [undefined, "", "server-nonce", "nonce-µ-😀"]) {
      const expected = stock(nonce);
      const actual = native.authenticator(nonce);
      check(expected && typeof expected === "object" && "jwt" in expected, "stock returns JWT auth");
      check(actual && typeof actual === "object" && "jwt" in actual, "native returns JWT auth");
      // Compare booleans so a failure never prints credential or signature values.
      check(Object.keys(actual).sort().join(",") === Object.keys(expected).sort().join(","), "auth fields match");
      for (const field of ["jwt", "nkey", "sig"] as const)
        check(actual[field] === expected[field], `${field} matches the stock authenticator`);
    }
  } finally { native.clear(); }
  let cleared = false;
  try { native.authenticator("after-clear"); } catch { cleared = true; }
  check(cleared, "cleared native material cannot authenticate");
}
check(clientSigning("nats") === "nats", "stock mode is explicit");
check(clientSigning("native") === "native", "native mode is explicit");
for (const value of [undefined, "unknown"]) {
  let refused = false;
  try { clientSigning(value); } catch { refused = true; }
  check(refused, "unknown or absent child mode refuses");
}
let invalid = false;
try { nativeLoadAuthenticator("not a credential"); } catch { invalid = true; }
check(invalid, "invalid credential refuses without a fallback");
assert.equal(checks, 105);
console.log(`  ${checks} checks: four keys, four nonce shapes, clear and refusal controls`);
emitSentinel({ passed: checks, failed: 0 });
