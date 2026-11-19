/** Native ledger classification through the shipped worker. This does not redeem a session grant. */
import assert from "node:assert/strict";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  chatStream, credsFromJwt, endpointToken, eptReqStreamName, fanoutDurableConfig, inboxReaderConfig, inboxStream,
  markLedgerRowRevoked, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams, standaloneConnectOpts, timerWriterConsumerConfig,
  type SessionLedgerRow,
} from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { activateLifecycle, openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { finalizeAgentMint, stageAgentMint } from "../src/credential-ledger.js";
import { kvSessionLedger } from "../src/session-ledger.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

import { observeSpaceQuiescence } from "../dist/index.js";
const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("quiet-roots", 1, { keepFiles: process.argv.includes("--keep-fixture") });
const account = fx.accounts[0]!, space = account.space;
let writer: NatsConnection | undefined;
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  const id = newIdentity(), signer = fromSeed(new TextEncoder().encode(account.auth.account.signingSeed));
  let jwt;
  try { jwt = await encodeUser("owned-authority-fixture", fromPublic(id.id), fromPublic(account.accountPublicKey), {}, { signer, exp: Math.floor(Date.now() / 1000) + 300 }); }
  finally { signer.clear(); }
  writer = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: credsFromJwt(jwt, id), tls: false }), reconnect: false });
  const jsm = await jetstreamManager(writer);
  await jsm.consumers.add(chatStream(space), fanoutDurableConfig(space));
  await jsm.consumers.add(inboxStream(space), inboxReaderConfig(space));
  await jsm.consumers.add(eptReqStreamName(space), timerWriterConsumerConfig(space));
  const reader = await mintCreds(account.auth, newIdentity(), "space-quiescence-reader");
  const observe = async () => {
    const value = await observeSpaceQuiescence({ servers: fx.servers, space, creds: reader, accountPublicKey: account.accountPublicKey, tls: false });
    return { ...value, counts: value.counts as typeof value.counts & { liveRootCredentialRows?: number } };
  };
  const initial = await observe();
  check("empty native authority remains quiescent", initial.complete && initial.state === "quiescent", initial);
  const registry = await openLifecycleRegistry(writer, space), { authKv } = registryStores(registry);
  const actor = await activateLifecycle(registry, { owner: "local", actor: "worker", managerInstance: "fixture" });
  const mint = async (credentialId: string, sourceChain: string[]) => {
    const row = await stageAgentMint(registry, { lifecycleUid: actor.mapping.lifecycleUid, credentialId, holderPrincipal: "local.worker", sourceChain, exp: Date.now() + 90 * 86_400_000 });
    await finalizeAgentMint(registry, row); return row;
  };
  const root = await mint("root", ["root"]), rooted = await observe();
  check("an active root is separately counted while the default verdict stays active", rooted.complete && rooted.state === "active" &&
    rooted.counts.liveAuthorityRows === 1 && rooted.counts.liveRootCredentialRows === 1 && rooted.counts.unsettledAuthorityRows === 0, rooted);
  const child = await mint("derived", ["root", "session.fixture"]), derived = await observe();
  check("a non-root lineage is not included in the root-only count", derived.complete && derived.counts.liveAuthorityRows === 2 && derived.counts.liveRootCredentialRows === 1, derived);
  await markLedgerRowRevoked(authKv, child.rowKey); await markLedgerRowRevoked(authKv, root.rowKey);
  const revoked = await observe();
  check("revoked root and child rows remain stored but count as neither live nor root", revoked.complete && revoked.state === "quiescent" &&
    revoked.counts.liveAuthorityRows === 0 && revoked.counts.liveRootCredentialRows === 0, revoked);

  const ledger = kvSessionLedger(authKv);
  const session = async (lifeMs: number): Promise<SessionLedgerRow> => {
    const sessionId = mintLifecycleUid(), instanceId = mintLifecycleUid(), endpoint = "org.example.quiet";
    const row: SessionLedgerRow = { sessionId, endpoint, serving: { instanceId, epoch: 1 },
      holder: { principal: "local.worker", lifecycleUid: actor.mapping.lifecycleUid }, grantSig: "owned-ledger-fixture",
      credCaller: `${actor.mapping.lifecycleUid}.${sessionId}.c`, credServing: `${endpointToken(endpoint)}.${instanceId}.${sessionId}.s`,
      revoked: { caller: false, serving: false }, state: "issuing", exp: Date.now() + lifeMs };
    assert.equal(await ledger.createIssuing(row), "created"); assert.equal((await ledger.read(sessionId))?.state, "issuing");
    return row;
  };
  const row = await session(60_000), issuing = await observe();
  check("a real issuing session is unsettled authority, not an idle root", issuing.complete && issuing.state === "active" && issuing.counts.unsettledAuthorityRows > 0, issuing);
  check("observation does not complete the native issuance row", (await ledger.read(row.sessionId))?.state === "issuing");
  assert.equal(await ledger.finalizeActive(row.sessionId), true);
  const active = await observe();
  check("a finalized live session remains outside the root-only exception", active.complete && active.state === "active" && active.counts.liveAuthorityRows === 1 &&
    active.counts.liveRootCredentialRows === 0 && active.counts.unsettledAuthorityRows === 0, active);
  assert.equal(await ledger.transitionTerminal(row.sessionId, "closed"), true);
  const closing = await observe();
  check("terminal session with revocations still owed blocks quiescence", closing.complete && closing.state === "active" && closing.counts.unsettledAuthorityRows > 0, closing);
  await ledger.markRevoked(row.sessionId, row.credCaller);
  const half = await observe();
  check("one completed revocation does not hide the other party's debt", half.complete && half.state === "active" && half.counts.unsettledAuthorityRows > 0, half);
  await ledger.markRevoked(row.sessionId, row.credServing);
  check("both real revocation marks clear the terminal session debt", (await observe()).state === "quiescent");

  const expired = await session(400);
  while (Date.now() <= expired.exp) await new Promise(resolve => setTimeout(resolve, 25));
  const pendingExpiry = await observe();
  check("an expired issuing row still needs its terminal cleanup", pendingExpiry.complete && pendingExpiry.state === "active" &&
    pendingExpiry.counts.liveAuthorityRows === 0 && pendingExpiry.counts.unsettledAuthorityRows > 0, pendingExpiry);
  await ledger.transitionTerminal(expired.sessionId, "expired");
  await ledger.markRevoked(expired.sessionId, expired.credCaller); await ledger.markRevoked(expired.sessionId, expired.credServing);
  check("native terminal cleanup clears the expired issuance", (await observe()).state === "quiescent");
  const expiredActive = await session(400);
  await ledger.finalizeActive(expiredActive.sessionId);
  while (Date.now() <= expiredActive.exp) await new Promise(resolve => setTimeout(resolve, 25));
  const needsSweep = await observe();
  check("an expired active session waits for its real sweep", needsSweep.complete && needsSweep.state === "active" && needsSweep.counts.unsettledAuthorityRows > 0, needsSweep);
  await ledger.transitionTerminal(expiredActive.sessionId, "expired");
  await ledger.markRevoked(expiredActive.sessionId, expiredActive.credCaller); await ledger.markRevoked(expiredActive.sessionId, expiredActive.credServing);
  check("the final positive control is quiescent without deleting ledger history", (await observe()).state === "quiescent" &&
    (await ledger.read(row.sessionId))?.state === "closed" && (await ledger.read(expired.sessionId))?.state === "expired" && (await ledger.read(expiredActive.sessionId))?.state === "expired");
} catch (error) {
  check(`harness: ${error instanceof Error ? error.stack : String(error)}`, false);
} finally {
  await writer?.close(); await fx.close();
  if (passed() + failed() !== 14) check(`cell count: ran ${passed() + failed()}, expected 14`, false);
  finish();
}
process.exit(process.exitCode ?? 0);
