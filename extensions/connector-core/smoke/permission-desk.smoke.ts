/**
 * The permission desk on a real broker: what an asker reads, and what a native answer settles.
 *
 * alice's agent `coder` holds its prompts with the shipped desk over a static agent credential. alice's
 * browser actor `web` is a real interactive ledger row, minted through the shipped auth callout: it
 * watches the records through its own reader and answers. Other `coder` processes, under other
 * lifecycles, hold prompts of their own.
 *
 *  - An answer whose verdict the harness never confirms reads `answered`, with the state the holder
 *    recorded, never a timeout.
 *  - An answer reaches the process its record names. Another process of the same agent never receives
 *    it, and a desk that does not hold a prompt sends no reply, so a stale process cannot reply first.
 *  - One run of a tool settles one held prompt for that tool and input, the oldest, in its own scope,
 *    including two runs reported back to back.
 *  - The main turn's end settles only the main thread's prompts. A subagent's prompt stays pending and
 *    answerable, and settles at its own batch or its own stop.
 *
 * Run: pnpm smoke:permission-desk   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { generateKeyPair, SignJWT } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, mintPermissionRequestId, newIdentity, permissionAnswerSubject,
  serverConfig, setupSpaceStreams, type PermissionAnswerReply, type PermissionRecord, type PermissionRequestId, type PermissionWatch,
} from "@cotal-ai/core";
import { calloutPermissions, createCalloutAuth, deriveOwnerToken, grantActor, ledgerAclResolver, ledgerAuthorizeConnect, startAuthCallout, USER_TOKEN_VER } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openPermissionDesk, type PermissionAsk, type PermissionDesk } from "../src/permission-desk.js";

const { check, finish } = createSuite();
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | false, ms = 8000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = read();
    if (v) return v;
  }
  return undefined;
}

const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}permission-desk-`));
const space = `perm-desk-${randomUUID().slice(0, 8)}`, port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
}));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const ALICE = deriveOwnerToken("s".repeat(32), "permission-desk|alice");
const ISSUER = "https://permission-desk.test";

const raws: NatsConnection[] = [];
const endpoints: CotalEndpoint[] = [];
const desks: PermissionDesk[] = [];
let watch: PermissionWatch | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  const provisioner = new CotalEndpoint({ space, servers, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {});
  await provisioner.start();
  endpoints.push(provisioner);

  // The interactive row is a real ledger row, and the callout mints it through the shipped resolver.
  const ledger = join(dir, "ledger");
  const row = grantActor(ledger, { owner: ALICE, actor: "web", scope: [], allowSubscribe: [], allowPublish: [] });
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const calloutNc = await connect({ servers, authenticator: credsAuthenticator(enc.encode(callout.calloutCreds)), maxReconnectAttempts: 0 });
  raws.push(calloutNc);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space, token: { key: publicKey as never, issuer: ISSUER },
    recordIssuance: async () => {},
    authorizeActor: ledgerAuthorizeConnect(ledger),
    permissionsFor: calloutPermissions(ledgerAclResolver(ledger)),
    log: () => {},
  });
  const bearer = await new SignJWT({ sub: ALICE, ver: USER_TOKEN_VER, act: { owner: ALICE, actor: "web", scope: [], lifecycleUid: row.lifecycleUid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISSUER).setAudience(space).setSubject(ALICE)
    .setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) - 60).setExpirationTime("10m").sign(privateKey);
  const web = new CotalEndpoint({
    space, servers, bearer, sentinelCreds: callout.sentinelCreds, lifecycleUid: row.lifecycleUid, channels: [], consume: false,
    watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "web", kind: "agent", owner: ALICE, actor: "web" },
  });
  web.on("error", () => {});
  await web.start();
  endpoints.push(web);

  async function holder(): Promise<CotalEndpoint> {
    const id = newIdentity(), lifecycleUid = mintLifecycleUid();
    const creds = await mintCreds(auth, id, "agent", { principal: { owner: ALICE, actor: "coder" }, lifecycleUid });
    const ep = new CotalEndpoint({
      space, servers, creds, lifecycleUid, channels: [], consume: false, watchPresence: false, registerPresence: false,
      watchChannels: false, card: { id: id.id, name: "coder", kind: "agent", owner: ALICE, actor: "coder" },
    });
    ep.on("error", () => {});
    ep.on("warning", () => {});
    await ep.start();
    endpoints.push(ep);
    return ep;
  }
  const live = openPermissionDesk(await holder());
  desks.push(live);

  // The owner's own watch reads the records, as a dashboard does.
  watch = await web.watchPermissions((reader) => provisioner.openPermissionReader(reader));
  await watch.ready;
  const stored = (id: PermissionRequestId): PermissionRecord | undefined => watch!.records().find((r) => r.id === id);
  const stateOf = (id: PermissionRequestId) => {
    const s = stored(id)?.state;
    return s?.kind === "answered-on-machine" ? `${s.kind}/${s.outcome}` : s?.kind;
  };
  /** Hold one prompt and wait until the owner's watch shows its pending record. */
  async function ask(desk: PermissionDesk, ask: PermissionAsk) {
    const gone = new AbortController();
    const hold = desk.hold(ask, gone.signal);
    const id = desk.waiting()!;
    const record = await until(() => stateOf(id) === "pending" && stored(id));
    if (!record) throw new Error(`the record of ${JSON.stringify(ask.input)} never reached the watch`);
    return { id, record, hold, gone };
  }
  const settled = (id: PermissionRequestId) => until(() => stateOf(id) !== "pending", 3000);

  // ── An unconfirmed verdict reads answered, never a timeout ───────────────────────────────────
  const unconfirmed = await ask(live, { tool: "Bash", input: { command: "touch unconfirmed" } });
  const t0 = Date.now();
  const late = await web.answerPermission(unconfirmed.record, { decision: "approve" });
  await until(() => stateOf(unconfirmed.id) === "answered-on-machine/withdrawn", 3000);
  check("an answer whose verdict the harness never confirms reads answered, with the state the holder recorded",
    late.kind === "answered" && late.state.kind === "answered-on-machine" && stateOf(unconfirmed.id) === "answered-on-machine/withdrawn",
    { late, afterMs: Date.now() - t0, stored: stateOf(unconfirmed.id) });

  // ── An answer reaches the process its record names, and nothing else replies ─────────────────
  const stale = openPermissionDesk(await holder());
  desks.push(stale);
  const reached = await ask(live, { tool: "Bash", input: { command: "touch reached" } });
  void reached.hold.verdict.then(async () => { await sleep(1500); reached.hold.confirm(true); });
  const answered = await web.answerPermission(reached.record, { decision: "approve" });
  check("an answer reaches the holder its record names, and a stale process of the same agent does not reply first",
    answered.kind === "accepted" && answered.state.kind === "approved" && stateOf(reached.id) === "approved", { answered, stored: stateOf(reached.id) });

  // A raw holder answering everything at once, as a desk did for prompts it did not hold.
  const eager = await holder();
  const heard: string[] = [];
  eager.openPermissionHolder(async (a) => { heard.push(a.id); return { v: 1, ok: false, code: "unknown" }; });
  await sleep(200);
  const isolated = await ask(live, { tool: "Bash", input: { command: "touch isolated" } });
  void isolated.hold.verdict.then(async () => { await sleep(500); isolated.hold.confirm(true); });
  const isolatedAnswer = await web.answerPermission(isolated.record, { decision: "approve" });
  check("another process of the same agent never receives an answer addressed to the holder",
    isolatedAnswer.kind === "accepted" && heard.length === 0, { isolatedAnswer, heard });

  const rawWeb = await connect({
    servers, name: `ibx${randomUUID().replace(/-/g, "")}`, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc.encode(callout.sentinelCreds)), tokenAuthenticator(bearer)],
  });
  raws.push(rawWeb);
  const toLive = permissionAnswerSubject(space, ALICE, "coder", isolated.record.holder.runtimeId, ALICE, "web");
  const unheld = await rawWeb.request(toLive, JSON.stringify({ v: 1, id: mintPermissionRequestId(), decision: "approve" }), {
    noMux: true, reply: `${toLive}.reply.${randomUUID().replace(/-/g, "")}`, timeout: 1500,
  }).then((m) => m.json<PermissionAnswerReply>(), (e: Error) => e.message);
  check("the desk sends no reply for a prompt it does not hold", typeof unheld === "string" && /timeout/i.test(unheld), unheld);

  // ── One run settles one held prompt, the oldest ──────────────────────────────────────────────
  const twin = { tool: "Bash", input: { command: "npm test" } };
  const first = await ask(live, twin);
  const second = await ask(live, twin);
  live.toolsRan([twin]);
  await settled(first.id);
  await sleep(300);
  check("one run of a tool settles one of two identical held prompts, the older",
    stateOf(first.id) === "answered-on-machine/allowed" && stateOf(second.id) === "pending",
    { first: stateOf(first.id), second: stateOf(second.id) });
  const third = await ask(live, twin);
  live.toolsRan([twin]);
  live.toolsRan([twin]);
  await settled(third.id);
  await sleep(300);
  check("two runs reported back to back settle two different prompts",
    stateOf(second.id) === "answered-on-machine/allowed" && stateOf(third.id) === "answered-on-machine/allowed",
    { second: stateOf(second.id), third: stateOf(third.id) });

  // ── The main turn's end leaves a subagent's prompt pending and answerable ────────────────────
  const SUB = "a4d2c4017da5abcd9";
  const main = await ask(live, { tool: "Bash", input: { command: "touch main" } });
  const sub = await ask(live, { tool: "Bash", input: { command: "touch sub" }, scope: SUB });
  live.toolsRan([{ tool: "Bash", input: { command: "touch sub" } }]);
  live.turnEnded();
  await settled(main.id);
  await sleep(300);
  check("a main-thread batch and the main turn's end settle only the main thread's prompt; the subagent's stays pending",
    stateOf(main.id) === "answered-on-machine/allowed" && stateOf(sub.id) === "pending", { main: stateOf(main.id), sub: stateOf(sub.id) });
  void sub.hold.verdict.then(async () => { await sleep(200); sub.hold.confirm(true); });
  const subAnswer = await web.answerPermission(sub.record, { decision: "approve" });
  check("...and the owner can still answer the subagent's prompt", subAnswer.kind === "accepted" && stateOf(sub.id) === "approved", { subAnswer, stored: stateOf(sub.id) });

  const subRan = await ask(live, { tool: "Bash", input: { command: "touch sub-ran" }, scope: SUB });
  live.toolsRan([{ tool: "Bash", input: { command: "touch sub-ran" } }], SUB);
  const subEnded = await ask(live, { tool: "Bash", input: { command: "touch sub-ended" }, scope: SUB });
  live.turnEnded("a80d6aaca61ebb685");
  await settled(subRan.id);
  await sleep(300);
  const otherStop = stateOf(subEnded.id);
  live.turnEnded(SUB);
  await settled(subEnded.id);
  check("a subagent's prompt settles at its own batch and its own stop, and at no other agent's stop",
    stateOf(subRan.id) === "answered-on-machine/allowed" && otherStop === "pending" && stateOf(subEnded.id) === "answered-on-machine/allowed",
    { subRan: stateOf(subRan.id), afterOtherStop: otherStop, subEnded: stateOf(subEnded.id) });
} finally {
  for (const d of desks) d.close();
  await watch?.stop().catch(() => {});
  await Promise.all(endpoints.map((ep) => ep.stop().catch(() => {})));
  for (const nc of raws) await nc.close().catch(() => {});
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
