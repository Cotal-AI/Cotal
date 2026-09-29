/** Run: tsx implementations/manager/smoke/remote-run-client.smoke.ts (needs nats-server). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth, credsClaims, isReachable, jwtFromCreds, mintCreds, mintLifecycleUid, mintPublicUserJwt,
  newIdentity, runDriverCaller, serverConfig, type Identity, type IssuedCaller, type RemoteRunAttemptResult, type RemoteRunAdmissionResult, type RunAdmission,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { remoteRunAdmission, remoteRunAdmissionRequest, remoteRunAttemptCredentials, remoteRunAttemptRequest } from "../src/remote-authority.js";

const space = `runclient${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const other = await createSpaceAuth(space);
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid();
const held = { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() };
const state = { v: 1 as const, space, instanceId, lifecycleUid: mintLifecycleUid(), identities: held };
const proof = `sha256:${"a".repeat(64)}`;
const runId = `run-${"a".repeat(32)}`;
const driver = newIdentity();
const mediator = newIdentity();
const attempt = { runId, takeoverId: "takeover", epoch: 1, fencingToken: 1, driverId: driver.id, mediatorId: mediator.id };
const request = remoteRunAttemptRequest(state, proof, auth.account.pub, 3, { attempt });
const sign = async (signer: typeof auth, identity: Identity, profile: "run-driver" | "run-mediator") => {
  const pin = { endpoint: "manager", runId, owner, takeoverId: attempt.takeoverId, instanceId, epoch: 1 };
  const credential = await mintCreds(signer, identity, profile, {
    principal: { owner, actor: runDriverCaller(runId, owner).actor },
    ...(profile === "run-driver" ? { runDriver: pin } : { runMediator: pin }),
    expiresInSeconds: 90,
  });
  return { jwt: jwtFromCreds(credential)!, exp: credsClaims(credential).exp! };
};
const credentials = { driver: await sign(auth, driver, "run-driver"), mediator: await sign(auth, mediator, "run-mediator") };
const result: RemoteRunAttemptResult = { ...request, owner, credentials };
const refused = (candidate: RemoteRunAttemptResult, pattern: RegExp) =>
  assert.throws(() => remoteRunAttemptCredentials(candidate, request, owner, { driver, mediator }), pattern);

let count = 0;
const check = (name: string, test: () => void) => { test(); count++; console.log(`  ✓ ${name}`); };
const admissionRequest = remoteRunAdmissionRequest(state, proof, auth.account.pub, 3, { runId, subject: "subject-from-served-context" });
const admissionUid = mintLifecycleUid();
const admission: RunAdmission = {
  version: 1 as const, space, endpoint: "manager", runId, instanceId,
  caller: { owner, actor: "cli", uid: admissionUid, generation: "a".repeat(64) } as IssuedCaller,
  ceiling: { publish: { allow: { mode: "none" }, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } },
  provenance: { kind: "issued", ref: { space, owner, actor: "cli", uid: admissionUid, generation: "a".repeat(64) }, resolvedRevision: 1 },
  admittedAt: Date.now(),
};
const admissionResult: RemoteRunAdmissionResult = { v: 1, kind: "manager-run-admission", requestId: admissionRequest.requestId, runId, revision: 1, admission };
check("admission response binds the request, run, instance and issued provenance", () => {
  assert.equal(remoteRunAdmission(admissionResult, admissionRequest).runId, runId);
  assert.throws(() => remoteRunAdmission({ ...admissionResult, requestId: "other" }, admissionRequest), /coordinates/);
  assert.throws(() => remoteRunAdmission({ ...admissionResult, admission: { ...admission, instanceId: mintLifecycleUid() } }, admissionRequest), /foreign/);
  assert.throws(() => remoteRunAdmission({ ...admissionResult, admission: { ...admission, provenance: { kind: "operator", by: "x", reason: "y" } } as never }, admissionRequest), /foreign/);
});
check("first attempt supplies exactly the held pair", () => {
  const pair = remoteRunAttemptCredentials(result, request, owner, { driver, mediator });
  assert.ok("driver" in pair);
});
check("partial, widened, and wrong-operation response sets refuse", () => {
  refused({ ...result, credentials: { driver: credentials.driver } as never }, /non-closed/);
  refused({ ...result, credentials: { ...credentials, operator: credentials.driver } as never }, /non-closed/);
  refused({ ...result, operator: { id: driver.id, takeoverId: "other" } }, /non-closed/);
});
check("request, registration, process and nkey mismatch refuse", () => {
  refused({ ...result, requestId: "foreign" }, /coordinates/);
  refused({ ...result, registrationProof: `sha256:${"b".repeat(64)}` }, /coordinates/);
  refused({ ...result, processEpoch: 4 }, /coordinates/);
  refused({ ...result, attempt: { ...attempt, driverId: mediator.id } }, /coordinates/);
  refused({ ...result, credentials: { ...credentials, driver: credentials.mediator } }, /held nkey/);
});
check("foreign-account, unbounded, malformed and unheld JWT refuse", () => {
  const original = credentials.driver;
  refused({ ...result, credentials: { ...credentials, driver: { ...original, exp: original.exp + 1 } } }, /expiry/);
  refused({ ...result, credentials: { ...credentials, driver: { ...original, exp: 0 } } }, /bounded/);
  refused({ ...result, credentials: { ...credentials, driver: { jwt: "broken", exp: original.exp } } }, /bounded/);
});
const foreign = await sign(other, driver, "run-driver");
check("a foreign signer with the right public nkey still refuses before adoption", () =>
  refused({ ...result, credentials: { ...credentials, driver: foreign } }, /foreign account/));
const operator = newIdentity();
const opRequest = remoteRunAttemptRequest(state, proof, auth.account.pub, 3, { operator: { id: operator.id, takeoverId: "read", runId } });
const opCreds = await mintCreds(auth, operator, "run-operator", {
  principal: { owner, actor: "cli" }, runOperator: { endpoint: "manager", takeoverId: "read", runId }, expiresInSeconds: 60,
});
const opResult: RemoteRunAttemptResult = { ...opRequest, owner, credentials: { operator: { jwt: jwtFromCreds(opCreds)!, exp: credsClaims(opCreds).exp! } } };
check("one-shot operator permits exactly one credential", () => {
  assert.ok("operator" in remoteRunAttemptCredentials(opResult, opRequest, owner, { operator }));
  assert.throws(() => remoteRunAttemptCredentials({ ...opResult, credentials: { ...opResult.credentials, driver: credentials.driver } as never }, opRequest, owner, { operator }), /non-closed/);
});
const publicJwt = await mintPublicUserJwt(auth, driver.id, "run-driver", {
  principal: { owner, actor: runDriverCaller(runId, owner).actor },
  runDriver: { endpoint: "manager", runId, owner, takeoverId: attempt.takeoverId, instanceId, epoch: 1 },
  expiresInSeconds: 90,
});
check("host signs the caller-held public nkey without receiving its seed", () => {
  const pair = remoteRunAttemptCredentials({ ...result, credentials: { ...credentials, driver: publicJwt } }, request, owner, { driver, mediator });
  assert.ok("driver" in pair);
});

const port = await pickFreePort();
const server = `nats://127.0.0.1:${port}`;
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(tmp, "js") }));
const broker = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, tmp);
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  const pair = remoteRunAttemptCredentials(result, request, owner, { driver, mediator });
  assert.ok("driver" in pair);
  for (const credential of [pair.driver, pair.mediator]) {
    const nc = await connect({ servers: server, reconnect: false, authenticator: credsAuthenticator(new TextEncoder().encode(credential)) });
    await nc.flush();
    await nc.close();
  }
  count++;
  console.log("  ✓ both locally materialized JWTs connect to the real broker");
} finally {
  await killAndAwaitExit(broker);
  release();
}
console.log(`${count} remote run client checks passed`);
