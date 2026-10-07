import assert from "node:assert/strict";
import { type NatsConnection } from "@nats-io/transport-node";
import { mintCreds, newIdentity, setupSpaceStreams, epAuthBucket, mintLifecycleUid, type PlatformControlAssignment } from "@cotal-ai/core";
import { Kvm } from "@nats-io/kv";
import { startAuthService, readPlaneClaim, type AuthServiceHandle } from "../src/index.js";
import { openAuthorityClient, authorityBarrierGrants } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("public-close", 2);
const handles: AuthServiceHandle[] = [];
let harness: NatsConnection | undefined;
let harnessClient: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let restore: (() => void) | undefined;
let leaked: NatsConnection | undefined;
let resume: (() => void) | undefined;
let count = 0;
const ok = (condition: boolean, cell: string) => { assert.ok(condition, cell); count++; };
const leakedLive = () => leaked !== undefined && !leaked.isClosed();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  const [a] = fx.accounts;
  const inputs = fx.accounts.map((acct) => ({ context: { accountPublicKey: acct.accountPublicKey, lifecycleUid: "life-a" }, space: acct.space, servers: fx.servers, store: acct.store, storeIdentity: acct.store.identity, stateDir: acct.stateDir }));
  for (const acct of fx.accounts)
    await setupSpaceStreams({ servers: fx.servers, space: acct.space, creds: await mintCreds(acct.auth, newIdentity(), "provisioner") });
  harnessClient = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! }, label: "harness-reader", grants: (id) => {
    const g = authorityBarrierGrants(a.space, id);
    return { publish: g.publish.filter((s) => !s.startsWith("$KV.")), subscribe: g.subscribe };
  }, log: () => {} });
  harness = harnessClient.nc;
  const kv = await new Kvm(harness).open(epAuthBucket(a.space));
  const sibling = await startAuthService(inputs[1]); handles.push(sibling);
  let handle = await startAuthService(inputs[0]); handles.push(handle);
  // In-memory patch of the exact nats.js prototype used by live instances. No installed file edit.
  const proto = Object.getPrototypeOf(harness) as { close(this: NatsConnection & { options: { name?: string } }): Promise<void> };
  const original = proto.close;
  restore = () => { proto.close = original; };
  proto.close = async function () {
    if (this.options.name === `cotal:auth-mint:${a.space}`) {
      leaked = this;
      throw new Error("injected mint transport close failure");
    }
    await original.call(this);
  };
  let failure: unknown;
  try { await handle.close(); } catch (e) { failure = e; }
  console.log(`cell 1a observation: closeRejected=${failure !== undefined}, mintStillOpen=${leakedLive()}`);
  ok(failure !== undefined, "cell 1a: suppressed owned close failure rejects close");
  ok(typeof handle.connections === "function", "cell 1a: public connection inventory exists");
  ok(handle.connections().some((c) => c.label === `cotal:auth-mint:${a.space}` && !c.ended), "cell 1a: failed label remains not ended");
  let settled = false;
  void handle.closed.then(() => { settled = true; });
  await wait(20);
  ok(!settled, "cell 1a: rejected owned close leaves closed pending");
  restore();
  await handle.close();
  ok((await handle.closed).connections.every((c) => c.ended), "cell 1a: repaired close ends every owned connection");
  leaked = undefined;

  handle = await startAuthService(inputs[0]); handles.push(handle);
  settled = false;
  void handle.closed.then(() => { settled = true; });
  proto.close = async function () {
    if (this.options.name === `cotal:auth-service:${a.space}`) {
      leaked = this;
      throw new Error("injected callout close rejection");
    }
    await original.call(this);
  };
  await assert.rejects(handle.close(), /auth-service.*failed to close/, "cell 1a: callout close rejects by label"); count++;
  ok(handle.connections().some((c) => c.label === `cotal:auth-service:${a.space}` && !c.ended) && leakedLive(), "cell 1a: rejected callout is actually live and inventoried");
  await wait(20);
  ok(!settled, "cell 1a: rejected callout leaves closed pending");
  ok((await readPlaneClaim(kv, a.space))?.state === "released", "cell 1a: release precedes callout end");
  restore();
  await handle.close();
  await handle.closed;
  leaked = undefined;

  handle = await startAuthService(inputs[0]); handles.push(handle);
  settled = false;
  void handle.closed.then(() => { settled = true; });
  let reached!: () => void;
  const closingCallout = new Promise<void>((r) => { reached = r; });
  const delayed = new Promise<void>((r) => { resume = r; });
  proto.close = async function () {
    if (this.options.name === `cotal:auth-service:${a.space}`) {
      leaked = this;
      reached();
      await delayed;
    }
    await original.call(this);
  };
  const closing = handle.close();
  await closingCallout;
  await wait(20);
  ok(!settled && leakedLive(), "cell 1a: closed waits for actual callout end");
  ok((await readPlaneClaim(kv, a.space))?.state === "released", "cell 1a: closed remains pending after release until callout ends");
  ok((await sibling.readiness()).state === "ready" && (await fetch(`${sibling.url}/health`)).ok, "cell 1a: sibling remains ready while A closes");
  resume!();
  await closing;
  const ended = await handle.closed;
  ok(ended.connections.every((c) => c.ended) && settled, "cell 1a: closed settles after all actual ends");
  for (const role of ["auth-mint", "auth-registration", "auth-reader", "remote-manager-issuer", "auth-barrier", "auth-scan", "records-scan", "auth-admin", "auth-service"])
    ok(ended.connections.some((c) => c.label === `cotal:${role}:${a.space}`), `cell 1a: owned inventory includes ${role}`);
  const snapshot = handle.connections(); snapshot[0].ended = false;
  ok(handle.connections().every((c) => c.ended), "cell 1a: inventory snapshot cannot alter custody");
  restore();
  await handle.close();

  // The real readiness door opens its read-only connection before an absent manager refuses.
  // No manager is fabricated. A changed assignment drives the production replacement path.
  const assignment: PlatformControlAssignment = { v: 1, space: a.space, accountPublicKey: a.accountPublicKey, instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid(), assignmentRevision: 1, state: "assigned" };
  handle = await startAuthService({ ...inputs[0], platformControl: { observeAssignment: async () => assignment } });
  handles.push(handle);
  await assert.rejects(handle.platformControlReadiness!(assignment.instanceId), /not-found|no responders|timed out|timeout|not registered|resolve|describe/i); count++;
  ok(handle.connections().some((c) => c.label === `cotal:platform-readiness:${a.space}` && !c.ended), "cell 1a: readiness door connection is inventoried");
  assignment.instanceId = mintLifecycleUid(); assignment.assignmentRevision++;
  await assert.rejects(handle.platformControlReadiness!(assignment.instanceId), /not-found|no responders|timed out|timeout|not registered|resolve|describe/i); count++;
  await wait(20);
  const readers = handle.connections().filter((c) => c.label === `cotal:platform-readiness:${a.space}`);
  ok(readers.length === 2 && readers.some((c) => c.ended) && readers.some((c) => !c.ended), "cell 1a: replaced readiness reader retains actual end state");
  await handle.close();
  ok((await handle.closed).connections.every((c) => c.ended), "cell 1a: readiness readers end before closed settles");
  console.log(`auth public closure: ${count} assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  resume?.(); restore?.();
  await leaked?.close();
  for (const h of handles) await h.close().catch(() => {});
  await harnessClient?.close();
  await fx.close();
}
