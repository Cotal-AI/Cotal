/** Standing-connection option and credential-supply compatibility. The real Manager dial
 * methods run up to their transport boundary; no broker, grant authorization or reconnect is
 * simulated here. Native lifecycle/remint/reconnect coverage is a separate live check. */
import assert from "node:assert/strict";
import { credsAuthenticator, type Authenticator } from "@nats-io/transport-node";
import { createSpaceAuth, mintCreds, newIdentity, type Identity } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";

let checks = 0;
function check(value: unknown, label: string): asserts value {
  assert.ok(value, label);
  checks++;
}
type Method = "dialServeConnection" | "dialGoalWriter" | "dialSessionLedgerConnection";
const methods = Manager.prototype as unknown as Record<Method,
  (this: unknown, state: Record<string, unknown>, identity?: Identity) => Promise<unknown>>;
const auth = await createSpaceAuth("standing-authenticator");
const identity = newIdentity();
const first = await mintCreds(auth, identity, "observer");
await new Promise((resolve) => setTimeout(resolve, 1100));
const next = await mintCreds(auth, identity, "observer");
check(first !== next, "two real credential generations");

for (const method of ["dialServeConnection", "dialGoalWriter", "dialSessionLedgerConnection"] as const) {
  for (const mode of ["static", "remote", "open"] as const) {
    const state = { identity, creds: mode === "open" ? undefined : first };
    const observed: Record<string, unknown>[] = [];
    const boundary = new Error("transport boundary reached");
    const receiver = {
      auth: mode === "static" ? {} : undefined,
      remoteAuthority: mode === "remote" ? {} : undefined,
      dial: async (options: Record<string, unknown>) => { observed.push(options); throw boundary; },
    };
    try {
      if (method === "dialServeConnection") await methods[method].call(receiver, state);
      else await methods[method].call(receiver, state, identity);
      check(false, "dial must stop at boundary");
    }
    catch (error) { check(error === boundary, "actual dial method reached transport"); }
    check(observed.length === 1, "one dial");
    const options = observed[0]!;
    check(options.inboxPrefix === `_INBOX_${identity.id}`, "held identity inbox preserved");
    check(options.maxReconnectAttempts === -1, "standing reconnect policy preserved");
    check(!("tls" in options), "existing transport policy unchanged");
    if (mode === "open") {
      check(!("authenticator" in options), "open connection stays bare");
      continue;
    }
    check(typeof options.authenticator === "function", "credential authenticator present");
    const authenticate = options.authenticator as Authenticator;
    for (const current of [first, next]) {
      state.creds = current;
      const actual = authenticate("standing-nonce-µ");
      const expected = credsAuthenticator(new TextEncoder().encode(current))("standing-nonce-µ");
      check(actual && "jwt" in actual && expected && "jwt" in expected, "JWT authentication fields");
      check(Object.keys(actual).sort().join() === Object.keys(expected).sort().join(), "field set unchanged");
      for (const field of ["jwt", "nkey", "sig"] as const)
        check(actual[field] === expected[field], `${field} matches current credential`);
    }
    state.creds = "invalid credential";
    let refused = false;
    try { authenticate("standing-nonce"); } catch { refused = true; }
    check(refused, "invalid current supply refuses without retaining a previous key");
    state.creds = next;
    const restored = authenticate("restored");
    check(restored && "jwt" in restored, "restored supply is usable");
  }
}
console.log(`${checks} standing-authenticator compatibility checks passed`);
emitSentinel({ passed: checks, failed: 0 });
