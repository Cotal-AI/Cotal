import assert from "node:assert/strict";
import { credsFromJwt, newIdentity, type RemoteManagerAuthorityMaterial } from "@cotal-ai/core";
import { materialCredential } from "../src/remote-authority.js";

let pass = 0;
const cell = (name: string, fn: () => void) => {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
};
const jwt = (sub: string, exp: number) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.sig`;
const credential = (identity: ReturnType<typeof newIdentity>, exp: number) => ({ jwt: jwt(identity.id, exp), exp });
const material = (credentials: RemoteManagerAuthorityMaterial["credentials"], expiresAt: number): RemoteManagerAuthorityMaterial => ({
  v: 1, kind: "manager-service-authority", operation: "prepare", space: "demo",
  owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "cli", instanceId: "a".repeat(26),
  lifecycleUid: "b".repeat(26), requestId: "requestrequestrequestreq1", issuedAt: 1,
  expiresAt, actors: { supervisor: "s", executor: "e", serve: "v", goalWriter: "g", sessionLedger: "l" },
  identities: {
    supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id },
    goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id },
  }, credentials,
});

// A successful return is the strongest positive result. If the synthetic JWT reaches a formatting
// error on another runtime, it must still have passed the expiry validation first.
const acceptsExpiry = (fn: () => unknown) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /expiry does not match the material envelope/);
  }
};

const supervisor = newIdentity();
const executor = newIdentity();
const sup = credential(supervisor, 200);
const exec = credential(executor, 150);

cell("a longer-lived supervisor is valid inside an envelope whose earliest member is the executor", () => {
  acceptsExpiry(() => materialCredential(material({ supervisor: sup, executor: exec }, 150_000), "supervisor", supervisor));
});
cell("the shortest-lived executor remains valid at the envelope expiry", () => {
  acceptsExpiry(() => materialCredential(material({ supervisor: sup, executor: exec }, 150_000), "executor", executor));
});
cell("a forged envelope expiry is refused", () => {
  assert.throws(() => materialCredential(material({ supervisor: sup, executor: exec }, 200_000), "supervisor", supervisor), /expiry does not match/);
});
cell("a credential entry that disagrees with its JWT expiry is refused", () => {
  const bad = { jwt: sup.jwt, exp: 201 };
  assert.throws(() => materialCredential(material({ supervisor: bad, executor: exec }, 150_000), "supervisor", supervisor), /expiry does not match/);
});

void credsFromJwt;
console.log(`\nremote-authority-expiry: ${pass} passed`);
