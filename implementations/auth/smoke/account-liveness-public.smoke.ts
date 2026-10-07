import assert from "node:assert/strict";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import * as core from "@cotal-ai/core";
import { startAuthService, type AuthServiceHandle } from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("public-sweep", 2);
const handles: AuthServiceHandle[] = [];
let foreign: NatsConnection | undefined;
let count = 0;
try {
  for (const a of fx.accounts) {
    await core.setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await core.mintCreds(a.auth, core.newIdentity(), "provisioner") });
    handles.push(await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "life-a" }, space: a.space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.stateDir }));
  }
  const [a, b] = fx.accounts;
  foreign = await connect({ servers: fx.servers, name: "foreign-live-b", authenticator: credsAuthenticator(new TextEncoder().encode(await core.mintCreds(b.auth, core.newIdentity(), "provisioner"))) });
  assert.ok("observeAccountLivenessWithCreds" in core && typeof core.observeAccountLivenessWithCreds === "function", "cell 3a: root exports account liveness observer"); count++;
  const observerCreds = await core.mintMembershipObserverCreds(a.auth, core.newIdentity());
  const observe = (accountId = a.accountPublicKey) => core.observeAccountLivenessWithCreds({ servers: fx.servers, accountId, observerCreds, options: { settleMs: 50, maxWaitMs: 400, pageLimit: 2 } });
  const live = await observe();
  assert.ok(live.gotAnyReply && !live.truncated && live.sweepComplete, "cell 3b: account filter returns complete live plane sweep"); count++;
  for (const label of ["auth-mint", "auth-barrier", "auth-scan", "records-scan", "auth-reader", "auth-admin", "remote-manager-issuer"]) {
    assert.ok(live.conns.some((c) => c.label === `cotal:${label}:${a.space}` && Number.isSafeInteger(c.cid) && c.serverId.length > 0), `cell 3a: sweep lists ${label}`); count++;
  }
  assert.ok(live.conns.every((c) => c.label !== "foreign-live-b" && !c.label?.includes(b.space)), "cell 3a: sweep never lists another account"); count++;
  const denied = await observe(b.accountPublicKey);
  assert.ok(!denied.gotAnyReply && !denied.sweepComplete && denied.conns.length === 0, "cell 3a: scoped credentials never widen to another account"); count++;
  await handles[0].close();
  await handles[0].closed;
  const gone = await observe();
  assert.ok(gone.gotAnyReply && !gone.truncated && gone.sweepComplete && gone.conns.length === 0, "cell 3a: closed account has no live plane connections"); count++;
  assert.equal((await handles[1].readiness()).state, "ready", "cell 3a: sibling account remains serving"); count++;
  console.log(`account liveness public: ${count} assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  for (const h of handles) await h.close().catch(() => {});
  await foreign?.close();
  await fx.close();
}
