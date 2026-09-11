import assert from "node:assert/strict";
import { credsFromJwt, newIdentity, type RemoteManagerAuthorityMaterial } from "@cotal-ai/core";
import { materialCredential } from "../src/remote-authority.js";

let pass = 0;
const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const cell = (name: string, fn: () => void) => {
  const realNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } finally {
    Date.now = realNow;
  }
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

const supervisor = newIdentity();
const executor = newIdentity();
const sup = credential(supervisor, NOW_SECONDS + 200);
const exec = credential(executor, NOW_SECONDS + 150);

cell("a longer-lived supervisor is valid inside an envelope whose earliest member is the executor", () => {
  assert.equal(
    materialCredential(material({ supervisor: sup, executor: exec }, exec.exp * 1000), "supervisor", supervisor) ===
      credsFromJwt(sup.jwt, supervisor),
    true,
  );
});
cell("the shortest-lived executor remains valid at the envelope expiry", () => {
  assert.equal(
    materialCredential(material({ supervisor: sup, executor: exec }, exec.exp * 1000), "executor", executor) ===
      credsFromJwt(exec.jwt, executor),
    true,
  );
});
cell("a forged envelope expiry is refused", () => {
  assert.throws(() => materialCredential(material({ supervisor: sup, executor: exec }, sup.exp * 1000), "supervisor", supervisor), /expiry does not match/);
});
cell("a credential entry that disagrees with its JWT expiry is refused", () => {
  const bad = { jwt: sup.jwt, exp: sup.exp + 1 };
  assert.throws(() => materialCredential(material({ supervisor: bad, executor: exec }, exec.exp * 1000), "supervisor", supervisor), /expiry does not match/);
});
cell("a credential expiring at the current clock boundary is refused", () => {
  const expired = credential(executor, NOW_SECONDS);
  assert.throws(() => materialCredential(material({ executor: expired }, NOW_MS), "executor", executor), /already expired/);
});

console.log(`\nremote-authority-expiry: ${pass} passed`);
