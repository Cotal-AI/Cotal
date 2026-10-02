import assert from "node:assert/strict";
import { createSpaceAuth, credsClaims, credsFromJwt, jwtFromCreds, mintCreds, newIdentity, remoteManagerActors, type RemoteManagerAuthorityMaterial } from "@cotal-ai/core";
import { materialCredential, remoteManagerRenewalCredentials, remoteRunRenewalCredentials } from "../src/remote-authority.js";

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

const supervisor = newIdentity();
const executor = newIdentity();
const standingIdentities = { supervisor, executor, serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() };
const bundleRequest = {
  v: 1 as const, kind: "manager-service-authority" as const, operation: "renewStandingBundle" as const,
  space: "demo", actor: "cli", instanceId: "a".repeat(26), managerLifecycleUid: "b".repeat(26),
  requestId: "requestrequestrequestreq1", registrationProof: `sha256:${"a".repeat(64)}`,
  accountPublicKey: `A${"A".repeat(55)}`, processEpoch: 3,
  identities: Object.fromEntries(Object.entries(standingIdentities).map(([name, id]) => [name, { id: id.id }])) as {
    supervisor: { id: string }; executor: { id: string }; serve: { id: string }; goalWriter: { id: string }; sessionLedger: { id: string };
  },
};
const bundleCreds = Object.fromEntries(Object.entries(bundleRequest.identities).map(([name, id]) => [name, { jwt: jwt(id.id, 200), exp: 200 }])) as RemoteManagerAuthorityMaterial["credentials"];
const bundleResult = { ...bundleRequest, owner: `u_${"a".repeat(26)}`, lifecycleUid: bundleRequest.managerLifecycleUid,
  issuedAt: 1, expiresAt: 200_000, actors: remoteManagerActors(bundleRequest.instanceId), credentials: bundleCreds };
cell("renewal result matches every lifecycle, epoch, account and nkey echo", () => {
  assert.throws(() => remoteManagerRenewalCredentials({ ...bundleResult, processEpoch: 4 }, bundleRequest, bundleResult.owner, standingIdentities), /coordinates/);
  assert.throws(() => remoteManagerRenewalCredentials({ ...bundleResult, accountPublicKey: `A${"B".repeat(55)}` }, bundleRequest, bundleResult.owner, standingIdentities), /coordinates/);
});
{
  const auth = await createSpaceAuth("demo");
  const liveRequest = { ...bundleRequest, accountPublicKey: auth.account.pub };
  const liveCredentials = {} as NonNullable<RemoteManagerAuthorityMaterial["credentials"]>;
  for (const name of Object.keys(standingIdentities) as Array<keyof typeof standingIdentities>) {
    const actor = remoteManagerActors(bundleRequest.instanceId)[name];
    const creds = await mintCreds(auth, standingIdentities[name], name === "goalWriter" ? "goal-writer" : name === "sessionLedger" ? "session-ledger" : "remote-manager", {
      principal: { owner: bundleResult.owner, actor: name === "serve" ? remoteManagerActors(bundleRequest.instanceId).supervisor : actor },
      ...(name === "goalWriter" ? { goalWriter: { endpoint: "manager" } } : {}),
      ...(name === "supervisor" || name === "executor" || name === "serve" ? { remoteManager: { instanceId: bundleRequest.instanceId, owner: bundleResult.owner, actor: name === "serve" ? remoteManagerActors(bundleRequest.instanceId).supervisor : actor } } : {}),
    });
    const token = jwtFromCreds(creds)!;
    liveCredentials[name] = { jwt: token, exp: credsClaims(creds).exp! };
  }
  const liveMaterial = { ...bundleResult, accountPublicKey: auth.account.pub, credentials: liveCredentials,
    expiresAt: Math.min(...Object.values(liveCredentials).map((c) => c!.exp * 1000)) };
  cell("five signed JWTs preflight with matching account and caller nkeys", () => {
    assert.deepEqual(Object.keys(remoteManagerRenewalCredentials(liveMaterial, liveRequest, bundleResult.owner, standingIdentities)),
      ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"]);
    assert.throws(() => remoteManagerRenewalCredentials({ ...liveMaterial, credentials: { ...liveCredentials, serve: { ...liveCredentials.serve!, jwt: jwt(newIdentity().id, liveCredentials.serve!.exp) } } }, liveRequest, bundleResult.owner, standingIdentities), /requested identity/);
  });
  const driver = newIdentity();
  const mediator = newIdentity();
  const run = { runId: `run-${"a".repeat(32)}`, holder: `holder.${"c".repeat(16)}`, takeoverId: "c".repeat(16),
    epoch: 2, fencingToken: 3, driverId: driver.id, mediatorId: mediator.id };
  const runRequest = { ...liveRequest, operation: "renewRunDriver" as const, run };
  const runTokens = {} as Record<"runDriver" | "runMediator", { jwt: string; exp: number }>;
  for (const [name, identity] of [["runDriver", driver], ["runMediator", mediator]] as const) {
    const creds = await mintCreds(auth, identity, name === "runDriver" ? "run-driver" : "run-mediator", {
      principal: { owner: bundleResult.owner, actor: "wf_test" },
      ...(name === "runDriver" ? { runDriver: { endpoint: "manager", runId: run.runId, takeoverId: run.takeoverId,
        instanceId: runRequest.instanceId, epoch: run.epoch, owner: bundleResult.owner } } :
        { runMediator: { endpoint: "manager", runId: run.runId, takeoverId: run.takeoverId,
          instanceId: runRequest.instanceId, epoch: run.epoch, owner: bundleResult.owner } }),
    });
    runTokens[name] = { jwt: jwtFromCreds(creds)!, exp: credsClaims(creds).exp! };
  }
  const runMaterial = { ...liveMaterial, ...runRequest, lifecycleUid: runRequest.managerLifecycleUid, credentials: runTokens,
    expiresAt: Math.min(...Object.values(runTokens).map((c) => c.exp * 1000)) };
  cell("run material validates the exact active driver and mediator nkeys", () => {
    assert.deepEqual(Object.keys(remoteRunRenewalCredentials(runMaterial, runRequest, bundleResult.owner, driver, mediator)), ["driver", "mediator"]);
    assert.throws(() => remoteRunRenewalCredentials({ ...runMaterial, run: { ...run, fencingToken: 4 } }, runRequest, bundleResult.owner, driver, mediator), /coordinates/);
    assert.throws(() => remoteRunRenewalCredentials({ ...runMaterial, credentials: { ...runTokens, runMediator: undefined } }, runRequest, bundleResult.owner, driver, mediator), /coordinates/);
  });
}
const sup = credential(supervisor, 200);
const exec = credential(executor, 150);

cell("a longer-lived supervisor is valid inside an envelope whose earliest member is the executor", () => {
  assert.equal(
    materialCredential(material({ supervisor: sup, executor: exec }, 150_000), "supervisor", supervisor),
    credsFromJwt(sup.jwt, supervisor),
  );
});
cell("the shortest-lived executor remains valid at the envelope expiry", () => {
  assert.equal(
    materialCredential(material({ supervisor: sup, executor: exec }, 150_000), "executor", executor),
    credsFromJwt(exec.jwt, executor),
  );
});
cell("a forged envelope expiry is refused", () => {
  assert.throws(() => materialCredential(material({ supervisor: sup, executor: exec }, 200_000), "supervisor", supervisor), /expiry does not match/);
});
cell("a credential entry that disagrees with its JWT expiry is refused", () => {
  const bad = { jwt: sup.jwt, exp: 201 };
  assert.throws(() => materialCredential(material({ supervisor: bad, executor: exec }, 150_000), "supervisor", supervisor), /expiry does not match/);
});

console.log(`\nremote-authority-expiry: ${pass} passed`);
