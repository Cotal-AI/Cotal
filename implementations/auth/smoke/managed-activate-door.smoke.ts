/**
 * #5214: a separately hosted stock auth service exposes one account-bound, UID-exact managed
 * lifecycle activation on its existing capability-gated loopback host face.
 *
 * This is a real two-account JWT broker fixture and real authority planes. It proves:
 *  - the ordinary hosted start, without `platformControl`, serves the door;
 *  - exact activation and same-UID idempotence;
 *  - missing/wrong capability, Origin, malformed/extra fields, and foreign account refuse first;
 *  - same-name successors, retiring heads, and retired gates keep native lifecycle semantics;
 *  - the public face has no activation route;
 *  - a real scanner disconnect fences the authority, and a request already admitted to its live
 *    loopback listener refuses unavailable without a lifecycle effect.
 *
 * Run: pnpm smoke:managed-activate-door:auth   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  MEMBERSHIP_INBOX_PREFIX,
  connzRequestSubject,
  lifecycleBlockedFrom,
  mintConnectionEvictorCreds,
  mintCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  serverKickSubject,
  setupSpaceStreams,
} from "@cotal-ai/core";
import {
  MANAGED_ACTIVATE_PATH,
  deriveOwnerToken,
  startAuthService,
  type AuthServiceHandle,
  type ManagedLifecycleActivationRequest,
} from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { ensureRootCredential } from "../src/root-credential.js";
import {
  beginHeadRetirementWithinBarrier,
  completeHeadRetirementWithinBarrier,
  freezeGate,
  observeGate,
  openLifecycleRegistry,
  readLifecycleHeadForOperation,
  retireGate,
} from "../src/lifecycle-registry.js";
import { startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("managed-activate", 2);
const handles: AuthServiceHandle[] = [];
const conns: NatsConnection[] = [];
const readers: Array<Awaited<ReturnType<typeof openAuthorityClient>>> = [];
let count = 0;
const ok = (condition: boolean, name: string, extra?: unknown) => {
  assert.ok(condition, `${name}${extra === undefined ? "" : `: ${JSON.stringify(extra)}`}`);
  count++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|managed-activate");
const HOST_CLIENT = fileURLToPath(new URL("./managed-activate-host-client.mjs", import.meta.url));

type Answer = { status: number; body: Record<string, unknown> };
async function separateHostRequest(handle: AuthServiceHandle, body: ManagedLifecycleActivationRequest): Promise<Answer> {
  return await new Promise<Answer>((resolve, reject) => {
    const child = execFile(process.execPath, [HOST_CLIENT], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`separate host client failed: ${stderr || error.message}`));
      try { resolve(JSON.parse(stdout) as Answer); }
      catch (cause) { reject(new Error("separate host client returned unreadable JSON", { cause })); }
    });
    child.stdin?.end(JSON.stringify({ url: handle.url, path: MANAGED_ACTIVATE_PATH, cap: handle.cap, body }));
  });
}

async function request(handle: AuthServiceHandle, body: unknown, opts: { cap?: string | null; origin?: boolean; path?: string; raw?: string } = {}): Promise<Answer> {
  const response = await fetch(`${handle.url}${opts.path ?? MANAGED_ACTIVATE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.cap === null ? {} : { authorization: `Bearer ${opts.cap ?? handle.cap}` }),
      ...(opts.origin ? { origin: "https://browser.example" } : {}),
    },
    body: opts.raw ?? JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function publicRequest(handle: AuthServiceHandle, body: unknown): Promise<Answer> {
  const response = await fetch(`${handle.publicUrl}${MANAGED_ACTIVATE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function admittedRequest(handle: AuthServiceHandle, body: ManagedLifecycleActivationRequest): Promise<{ release(): void; abort(): void; answer: Promise<Answer> }> {
  const text = JSON.stringify(body);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let admitted!: () => void;
  const admission = new Promise<void>((resolve) => { admitted = resolve; });
  let req: ReturnType<typeof httpRequest> | undefined;
  const answer = new Promise<Answer>((resolve, reject) => {
    const url = new URL(`${handle.url}${MANAGED_ACTIVATE_PATH}`);
    req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${handle.cap}`,
        "content-length": Buffer.byteLength(text),
        expect: "100-continue",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }); }
        catch (error) { reject(error); }
      });
    });
    req.once("continue", () => {
      admitted();
      void gate.then(() => req?.end(text));
    });
    req.on("error", reject);
    req.once("timeout", () => req?.destroy(new Error("activation request timed out")));
    req.setTimeout(5_000);
    req.flushHeaders();
  });
  await Promise.race([admission, wait(2_000).then(() => { req?.destroy(); throw new Error("activation request did not receive 100 Continue"); })]);
  return { release, abort: () => req?.destroy(), answer };
}

/** Native kill-live: find one scanner connection in account CONNZ and KICK it on its server. */
async function kickNamed(acct: HostedAuthAccount, name: string): Promise<number> {
  const observer = await connect({
    servers: fx.servers,
    authenticator: credsAuthenticator(enc(await mintMembershipObserverCreds(acct.auth, newIdentity()))),
    inboxPrefix: MEMBERSHIP_INBOX_PREFIX,
    maxReconnectAttempts: 0,
  });
  const evictor = await connect({
    servers: fx.servers,
    authenticator: credsAuthenticator(enc(await mintConnectionEvictorCreds(acct.auth, newIdentity()))),
    maxReconnectAttempts: 0,
  });
  conns.push(observer, evictor);
  const inbox = `${MEMBERSHIP_INBOX_PREFIX}.activate.${Date.now()}`;
  const sub = observer.subscribe(inbox, { max: 1 });
  observer.publish(connzRequestSubject(acct.auth.account.pub), enc(JSON.stringify({ subscriptions: false, auth: true, limit: 1024 })), { reply: inbox });
  let kicked = 0;
  for await (const message of sub) {
    const reply = message.json<{ server?: { id?: string }; data?: { server_id?: string; connections?: Array<{ cid: number; name?: string }> } }>();
    const serverId = reply.data?.server_id ?? reply.server?.id;
    for (const connection of reply.data?.connections ?? []) {
      if (connection.name !== name || serverId === undefined) continue;
      await evictor.request(serverKickSubject(serverId), enc(JSON.stringify({ cid: connection.cid })), { timeout: 2_000 });
      kicked++;
    }
  }
  return kicked;
}

let heldRequest: { abort(): void } | undefined;
try {
  const [a, b] = fx.accounts;
  for (const account of fx.accounts)
    await setupSpaceStreams({ servers: fx.servers, space: account.space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  const inputs = fx.accounts.map((account, i) => ({
    context: { accountPublicKey: account.accountPublicKey, lifecycleUid: `authority-${i}` },
    space: account.space,
    servers: fx.servers,
    store: account.store,
    storeIdentity: account.store.identity,
    stateDir: account.stateDir,
    publicFace: { port: 0, trustedProxy: false },
  }));
  const aHandle = await startAuthService(inputs[0]); handles.push(aHandle);
  const bHandle = await startAuthService(inputs[1]); handles.push(bHandle);
  ok(aHandle.activateManagedLifecycle === undefined, "ordinary hosted start serves no in-process platformControl activation handle");

  const openReader = async (account: HostedAuthAccount) => {
    const reader = await openAuthorityClient({
      server: fx.servers,
      space: account.space,
      dataAccount: { pub: account.auth.account.pub, signingSeed: account.auth.account.signingSeed! },
      label: `managed-activate-reader:${account.space}`,
      grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }),
      log: () => {},
    });
    readers.push(reader);
    return openLifecycleRegistry(reader.nc, account.space);
  };
  const aRegistry = await openReader(a);
  const bRegistry = await openReader(b);
  const target = (actor: string, lifecycleUid = mintLifecycleUid()): ManagedLifecycleActivationRequest => ({
    accountPublicKey: a.accountPublicKey,
    owner: OWNER,
    actor,
    lifecycleUid,
  });
  const head = async (actor: string) => (await readLifecycleHeadForOperation(aRegistry, OWNER, actor))?.mapping;

  console.log("A. exact ready activation through the ordinary hosted stock authority");
  const ready = target("ready");
  const activated = await separateHostRequest(aHandle, ready);
  ok(activated.status === 200 && activated.body.activated === true && activated.body.lifecycleUid === ready.lifecycleUid,
    "a separate host process activates through the ordinary hosted loopback authority", activated);
  ok((await head("ready"))?.state === "active" && (await head("ready"))?.lifecycleUid === ready.lifecycleUid,
    "ready activation creates the exact active lifecycle");
  const repeated = await request(aHandle, ready);
  ok(repeated.status === 200 && repeated.body.activated === true, "same exact active UID converges as native idempotence", repeated);

  console.log("B. request and authority guards refuse before effects");
  const guarded = target("guarded");
  const absentCap = await request(aHandle, guarded, { cap: null });
  ok(absentCap.status === 401 && absentCap.body.outcome === "not-executed" && (await head("guarded")) === undefined,
    "an absent capability refuses not-executed with no head", absentCap);
  const wrongCap = await request(aHandle, guarded, { cap: "wrong" });
  ok(wrongCap.status === 401 && wrongCap.body.outcome === "not-executed" && (await head("guarded")) === undefined,
    "a wrong capability refuses not-executed with no head", wrongCap);
  const origin = await request(aHandle, guarded, { origin: true });
  ok(origin.status === 403 && origin.body.outcome === "not-executed" && (await head("guarded")) === undefined,
    "Origin refuses not-executed with no head", origin);
  const extra = await request(aHandle, { ...guarded, extra: true });
  ok(extra.status === 400 && extra.body.outcome === "not-executed" && (await head("guarded")) === undefined,
    "an extra target field refuses not-executed with no head", extra);
  const malformed = await request(aHandle, guarded, { raw: "{" });
  ok(malformed.status === 400 && malformed.body.outcome === "not-executed" && (await head("guarded")) === undefined,
    "malformed JSON refuses not-executed with no head", malformed);
  const oversized = await request(aHandle, guarded, { raw: JSON.stringify({ ...guarded, padding: "x".repeat(66_000) }) });
  ok(oversized.status === 413 && oversized.body.outcome === "not-executed" && (await head("guarded")) === undefined,
    "oversized JSON refuses not-executed with no head", oversized);
  const foreign = await request(bHandle, guarded);
  ok(foreign.status === 403 && foreign.body.code === "permission-denied" && foreign.body.outcome === "not-executed",
    "the wrong account authority refuses the assigned account key", foreign);
  ok((await head("guarded")) === undefined && (await readLifecycleHeadForOperation(bRegistry, OWNER, "guarded")) === undefined,
    "foreign-account refusal creates no lifecycle in either account");
  const publicAnswer = await publicRequest(aHandle, guarded);
  ok(publicAnswer.status === 404 && (await head("guarded")) === undefined,
    "the public exchange face exposes no unauthenticated activation route", publicAnswer);

  console.log("C. seeded native lifecycle states preserve the activation contract");
  const successorUid = mintLifecycleUid();
  await ensureRootCredential(aRegistry, { owner: OWNER, actor: "successor", lifecycleUid: successorUid, managerInstance: "smoke" });
  const successor = await request(aHandle, target("successor"));
  ok(successor.status === 409 && successor.body.code === "already-exists" && (await head("successor"))?.lifecycleUid === successorUid,
    "a same-name active successor refuses with native already-exists and stays current", successor);

  const retiringUid = mintLifecycleUid();
  await ensureRootCredential(aRegistry, { owner: OWNER, actor: "retiring", lifecycleUid: retiringUid, managerInstance: "smoke" });
  const retirementOp = mintLifecycleUid();
  const retiringGate = await observeGate(aRegistry, retiringUid);
  assert.ok(retiringGate?.row.state === "open");
  await freezeGate(aRegistry, { lifecycleUid: retiringUid, revision: retiringGate.revision, op: { opId: retirementOp, kind: "retirement" } });
  await beginHeadRetirementWithinBarrier(aRegistry, { owner: OWNER, actor: "retiring", lifecycleUid: retiringUid, opId: retirementOp });
  const retiring = await request(aHandle, target("retiring", retiringUid));
  const retiringBlocked = lifecycleBlockedFrom({ details: retiring.body.details });
  ok(retiring.status === 412 && retiring.body.code === "failed-precondition" && retiringBlocked?.blockedOp === "retirement" && (await head("retiring"))?.state === "retiring",
    "a retiring lifecycle keeps the native lifecycle-blocked refusal", retiring);

  const retiredUid = mintLifecycleUid();
  await ensureRootCredential(aRegistry, { owner: OWNER, actor: "retired", lifecycleUid: retiredUid, managerInstance: "smoke" });
  const retiredOp = mintLifecycleUid();
  const retiredGate = await observeGate(aRegistry, retiredUid);
  assert.ok(retiredGate?.row.state === "open");
  const frozenRetired = await freezeGate(aRegistry, { lifecycleUid: retiredUid, revision: retiredGate.revision, op: { opId: retiredOp, kind: "retirement" } });
  await beginHeadRetirementWithinBarrier(aRegistry, { owner: OWNER, actor: "retired", lifecycleUid: retiredUid, opId: retiredOp });
  await retireGate(aRegistry, { lifecycleUid: retiredUid, revision: frozenRetired.revision, opId: retiredOp });
  await completeHeadRetirementWithinBarrier(aRegistry, { owner: OWNER, actor: "retired", lifecycleUid: retiredUid, opId: retiredOp });
  const retired = await request(aHandle, target("retired", retiredUid));
  const retiredBlocked = lifecycleBlockedFrom({ details: retired.body.details });
  ok(retired.status === 403 && retired.body.code === "permission-denied" && retiredBlocked?.gateState === "retired" && (await head("retired"))?.state === "retired",
    "a terminally retired UID keeps the native retired-gate refusal", retired);

  console.log("D. genuine stock scanner fence refuses without lifecycle effect");
  const fenced = target("fenced");
  const admitted = await admittedRequest(aHandle, fenced);
  heldRequest = admitted;
  ok((await kickNamed(a, `cotal:auth-scan:${a.space}`)) === 1, "exactly the stock auth-ledger scanner connection is disconnected");
  let unavailable = await aHandle.readiness();
  for (let i = 0; i < 50 && unavailable.state !== "unavailable"; i++) { await wait(20); unavailable = await aHandle.readiness(); }
  ok(unavailable.state === "unavailable", "the same stock authority reports unavailable before the admitted body is released", unavailable);
  admitted.release();
  const fencedAnswer = await admitted.answer;
  heldRequest = undefined;
  ok(fencedAnswer.status === 503 && fencedAnswer.body.code === "unavailable" && fencedAnswer.body.outcome === "unknown",
    "the admitted request reaches the fenced authority and refuses instead of reporting activation", fencedAnswer);
  ok((await head("fenced")) === undefined, "the genuine scanner-fence refusal creates no lifecycle head");

  console.log(`managed activation door: ${count} assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  heldRequest?.abort();
  for (const reader of readers) await reader.close().catch(() => {});
  for (const connection of conns) await connection.close().catch(() => {});
  for (const handle of handles) await handle.close().catch(() => {});
  await fx.close();
}
