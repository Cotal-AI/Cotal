import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { credsAuthenticator, type Authenticator } from "@nats-io/nats-core";
import { createSpaceAuth, mintCreds, newIdentity, standaloneConnectOpts } from "../src/index.js";
import { nativeCredsAuthenticator } from "../src/creds-authenticator.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let checks = 0;
function check(value: unknown, label: string): asserts value {
  assert.ok(value, label);
  checks++;
}
function same(actual: ReturnType<Authenticator>, expected: ReturnType<Authenticator>) {
  check(actual && "jwt" in actual, "native returns JWT authentication");
  check(expected && "jwt" in expected, "NATS returns JWT authentication");
  check(Object.keys(actual).sort().join() === Object.keys(expected).sort().join(), "authentication fields match");
  // Only booleans reach assertion output, never a credential or signature.
  for (const field of ["jwt", "nkey", "sig"] as const)
    check(actual[field] === expected[field], `${field} matches NATS`);
}
function refused(fn: () => unknown) { try { fn(); return false; } catch { return true; } }
const auth = await createSpaceAuth(`native-creds-${randomUUID().slice(0, 8)}`);
const credentials: string[] = [];
for (let key = 0; key < 4; key++) {
  const creds = await mintCreds(auth, newIdentity(), "observer");
  credentials.push(creds);
  for (const text of [creds, `\n${creds}\n`, creds.replaceAll("NATS USER JWT", "DECORATED JWT")]) {
    for (const nonce of [undefined, "", "broker-challenge", "nonce-µ-😀"]) {
      same(nativeCredsAuthenticator(text)(nonce), credsAuthenticator(new TextEncoder().encode(text))(nonce));
    }
  }
  const options = standaloneConnectOpts({ creds, tls: false });
  same((options.authenticator as Authenticator)("standalone"), credsAuthenticator(new TextEncoder().encode(creds))("standalone"));
  const user = standaloneConnectOpts({ bearer: "test-bearer", sentinelCreds: creds, tls: true });
  const callbacks = user.authenticator as Authenticator[];
  same(callbacks[0]!("user"), credsAuthenticator(new TextEncoder().encode(creds))("user"));
  check("auth_token" in callbacks[1]!()! && (callbacks[1]!() as { auth_token: string }).auth_token === "test-bearer", "bearer remains separate");
  check(typeof user.name === "string" && user.inboxPrefix === `_INBOX_${user.name}`, "user inbox uses the connection nonce");
  check(typeof user.tls === "object", "TLS intent survives authentication selection");
}
let current = credentials[0]!;
let reads = 0;
const rotating = nativeCredsAuthenticator(() => { reads++; return current; });
check(reads === 0, "credential supply stays lazy");
for (const next of credentials) {
  current = next;
  same(rotating("reconnect"), credsAuthenticator(new TextEncoder().encode(next))("reconnect"));
}
check(reads === credentials.length, "credential supply is read once per attempt");
current = "not a credential";
check(refused(() => rotating("bad")), "invalid rotated credential refuses rather than reusing the old key");
current = credentials[0]!;
same(rotating("recovered"), credsAuthenticator(new TextEncoder().encode(current))("recovered"));
const failure = new Error("fixture supply refused");
try { nativeCredsAuthenticator(() => { throw failure; })("nonce"); check(false, "supply must throw"); }
catch (error) { check(error === failure, "credential supplier error is preserved"); }
for (const bad of ["", "not a credential", current.replaceAll("\n", "\r\n"), current.replace(/^SU[A-Z2-7]{56}$/m, "invalid-seed"), current.slice(0, current.indexOf("-----BEGIN USER NKEY SEED"))]) {
  for (const nonce of [undefined, "challenge"]) {
    check(refused(() => credsAuthenticator(new TextEncoder().encode(bad))(nonce)), "NATS refuses malformed credentials");
    check(refused(() => nativeCredsAuthenticator(bad)(nonce)), "native refuses the same malformed credentials");
  }
}
console.log(`${checks} checks: credential grammar, nonce signatures, public standalone paths, rotation and refusal`);
emitSentinel({ passed: checks, failed: 0 });
