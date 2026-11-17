/**
 * Two complete stock delivery hosts as standby for one space: two real `cotal deliver --spaces
 * <manifest>` processes on one live `nats-server`, each with its own root, its own manifest and its
 * own scoped delivery identity in the same space account. Neither host is a stand-in: the lease
 * holder at every step is a stock host that registered, passed the native credential and scan
 * tenancy checks and took the lease itself.
 *
 * Authority stays in the test process. The space signer and the broker authority are never written
 * to either host root: each root holds only the scoped delivery, membership and `$SYS` credentials
 * the host reads from its own store, the way a separately provisioned host would.
 *
 * What it proves, each from the broker rather than from a host's own report:
 *  - the first host serves and holds the lease, the second reports the live lease, does not serve
 *    and keeps retrying, and refusal hosts (unprovisioned root, foreign-account credential,
 *    malformed credential, missing `$SYS` observer) refuse natively without touching the row;
 *  - a SIGKILLed first host leaves the second to take the lease after the row expires, answer the
 *    control rail and deliver, including a post made while no host served;
 *  - the returning first host does not serve, does not duplicate a lane and does not delete or
 *    rewrite the current holder's row, and stopping it leaves that row in place;
 *  - a graceful stop of the holder releases the row and the standby takes over.
 *
 * It does not add or test an election, a placement or a failover API: the standby is the existing
 * lease retry. Timings are measured in this topology and are not an SLA. One machine running two
 * isolated host processes is not two-physical-host or network-partition acceptance. The fixture
 * signs replacement delivery credentials into each host's own store before the initial credentials
 * expire. Membership and observer credentials do not expire during this test.
 *
 * Runs the BUILT dist (`pnpm build` first). Needs `nats-server` on PATH.
 * Run: pnpm smoke:delivery-standby
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, NoRespondersError, RequestError, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, CONTROL_DELIVERY, DEV_OWNER, LEASE_TTL_MS, MEMBERSHIP_INBOX_PREFIX, composeSpaceAuth, controlServiceSubject, createBrokerAuth,
  createSpaceAccountAuth, credsClaims, deliveryLeaseHolderFor, isReachable, mintConnectionEvictorCreds, mintCreds, mintLifecycleUid,
  mintMembershipObserverCreds, newIdentity, provisionAgent, serverConfig, setupSpaceStreams, type CotalMessage, type Identity,
  type SpaceAuth,
} from "@cotal-ai/core";
import {
  authDir, connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, workspaceSecretStore,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>, ms: number, step = 200): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await test()) return true; await wait(step); }
  return test();
}
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail)); }
};

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cotalJs = join(repoRoot, "bin", "dist", "cotal.js");
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const tag = randomUUID().slice(0, 6);
const brokerAuth = await createBrokerAuth(`sby-${tag}`);
const SPACE = `sby-${tag}-a`;
const FOREIGN_SPACE = `sby-${tag}-f`;
const [spaceAccount, foreignAccount] = await Promise.all([SPACE, FOREIGN_SPACE].map((s) => createSpaceAccountAuth(brokerAuth, s)));
const auth: SpaceAuth = composeSpaceAuth(brokerAuth, spaceAccount!);
const foreignAuth: SpaceAuth = composeSpaceAuth(brokerAuth, foreignAccount!);
const config = join(dir, "server.conf");
writeFileSync(config, serverConfig(brokerAuth, [spaceAccount!, foreignAccount!], { transport: { kind: "plaintext" }, port, host: "127.0.0.1", storeDir: join(dir, "js") }), { mode: 0o600 });
const nats = spawn("nats-server", ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
let brokerLog = "";
nats.stderr!.on("data", (chunk: Buffer) => { brokerLog += chunk.toString(); });
const releaseBroker = teardownOnSignal(nats, dir);

const children: ChildProcess[] = [];
const callers: NatsConnection[] = [];
const endpoints: CotalEndpoint[] = [];

/** One host's own state: its root, its environment and its manifest. Nothing is shared with another host. */
type Host = { name: string; env: NodeJS.ProcessEnv; root: string; manifest: string; store: ReturnType<typeof workspaceSecretStore>; composition: { injected: false; root: string }; delivery: Identity };
function makeHost(name: string): Host {
  const hostDir = join(dir, name);
  const root = join(hostDir, "root");
  mkdirSync(join(root, ".cotal", "auth"), { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", NO_COLOR: "1", COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "COTAL_HOME", "TMPDIR"]) {
    env[key] = join(hostDir, key.toLowerCase());
    mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  }
  const manifest = join(hostDir, "spaces.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, spaces: [SPACE] }));
  return { name, env, root, manifest, store: workspaceSecretStore(root), composition: { injected: false, root }, delivery: newIdentity() };
}

/** Provision a host root as `cotal up` leaves a delivery host's inputs: scoped credentials only.
 *  The space signer is not saved here, so the host root holds no authority to mint anything. */
async function provision(host: Host, overrides: { delivery?: string; observer?: string | null } = {}): Promise<void> {
  const { store, composition } = host;
  await store.put(deliveryCredsKey(SPACE, composition), overrides.delivery ?? await mintCreds(auth, host.delivery, "delivery", { expiresInSeconds: 3600 }));
  await store.put(membershipRwCredsKey(SPACE, composition), await mintCreds(auth, newIdentity(), "membership-rw", { expiresInSeconds: 3600 }));
  if (overrides.observer !== null) await store.put(membershipObserverCredsKey(SPACE, composition), overrides.observer ?? await mintMembershipObserverCreds(auth, newIdentity()));
  await store.put(connectionEvictorCredsKey(SPACE, composition), await mintConnectionEvictorCreds(auth, newIdentity()));
}

type Run = { host: Host; child: ChildProcess; out: string[]; text(): string; exited: Promise<number | null> };
function startHost(host: Host): Run {
  const child = spawn(process.execPath, [cotalJs, "deliver", "--spaces", host.manifest, "--server", servers], { cwd: host.root, env: host.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const out: string[] = [];
  child.stdout!.on("data", (d: Buffer) => out.push(d.toString()));
  child.stderr!.on("data", (d: Buffer) => out.push(d.toString()));
  return { host, child, out, text: () => out.join(""), exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))) };
}
const lanesUp = (run: Run) => run.text().split(`✓ delivery lane up (space ${SPACE})`).length - 1;

/** A read-only endpoint on the space, for its lease row. */
async function inspector(): Promise<CotalEndpoint> {
  const id = newIdentity();
  const ep = new CotalEndpoint({ space: SPACE, servers, creds: await mintCreds(auth, id, "delivery"), card: { id: id.id, name: "sby-inspector", kind: "endpoint" }, channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
  ep.on("error", () => {});
  await ep.start();
  endpoints.push(ep);
  return ep;
}

/** Ask the space's `ctl.delivery` rail for one lifecycle's memberships, as an agent does. */
async function prober(): Promise<() => Promise<boolean>> {
  const actor = newIdentity(), uid = mintLifecycleUid();
  const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, actor, "agent", { lifecycleUid: uid }))), inboxPrefix: `_INBOX_${actor.id}` });
  callers.push(nc);
  return async () => {
    const subject = controlServiceSubject(SPACE, CONTROL_DELIVERY, DEV_OWNER, actor.id);
    try {
      await nc.request(subject, JSON.stringify({ op: "listMemberships", args: { lifecycleUid: uid }, from: { id: `${DEV_OWNER}.${actor.id}`, name: "sby-probe", kind: "agent" } }), { timeout: 3000, noMux: true, reply: `${subject}.reply.${randomUUID()}` });
      return true;
    } catch (error) {
      if (error instanceof NoRespondersError || (error instanceof RequestError && error.isNoResponders())) return false;
      throw error;
    }
  };
}

/** Client connections in the space's account by authenticated user nkey, read with a fixture `$SYS`
 *  observer that is not any host's. Facts for the record; the suite asserts no exact count. */
const sweeperCreds = await mintMembershipObserverCreds(auth, newIdentity());
async function connz(): Promise<Map<string, number>> {
  const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(sweeperCreds)), inboxPrefix: MEMBERSHIP_INBOX_PREFIX });
  try {
    const reply = await nc.request(`$SYS.REQ.ACCOUNT.${spaceAccount!.account.pub}.CONNZ`, JSON.stringify({ auth: true, limit: 1024 }), { timeout: 5000 });
    const body = reply.json<{ data?: { connections?: { cid: number; authorized_user?: string }[] } }>();
    const byUser = new Map<string, number>();
    for (const c of body.data?.connections ?? []) if (c.cid !== nc.info?.client_id && c.authorized_user) byUser.set(c.authorized_user, (byUser.get(c.authorized_user) ?? 0) + 1);
    return byUser;
  } finally {
    await nc.close();
  }
}

/** Real Plane-3 traffic: a sender and a receiver joined durably to one channel, the receiver
 *  counting the durable copies it is handed per message id. */
async function traffic() {
  const channel = "general";
  const copies = new Map<string, number>();
  const errors: string[] = [];
  const note = (e: Error) => { errors.push(e.message.slice(0, 300)); };
  const prov = new CotalEndpoint({ space: SPACE, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "sby-prov", role: "manager", kind: "endpoint" } });
  prov.on("error", note);
  endpoints.push(prov);
  await prov.start();
  const members: CotalEndpoint[] = [];
  try {
    for (let k = 0; k < 2; k++) {
      const identity = newIdentity(), uid = mintLifecycleUid();
      const creds = await provisionAgent(prov, auth, identity, { subscribe: [channel], allowSubscribe: [channel], allowPublish: [channel], role: "default", lifecycleUid: uid });
      const ep = new CotalEndpoint({ space: SPACE, servers, creds, lifecycleUid: uid, channels: [channel], card: { id: identity.id, name: `sby-member-${k}`, role: "default", kind: "agent" } });
      ep.on("error", note);
      if (k === 1) ep.on("message", (m: CotalMessage, d: { durable: boolean; ack(): void }) => {
        if (d.durable) { copies.set(m.id, (copies.get(m.id) ?? 0) + 1); d.ack(); }
      });
      members.push(ep);
      endpoints.push(ep);
      await ep.start();
    }
  } finally {
    await prov.stop();
  }
  return {
    errors,
    post: async (text: string): Promise<string> => (await members[0]!.multicast(text, { channel })).id,
    copiesOf: (id: string) => copies.get(id) ?? 0,
  };
}

const lease = (ep: CotalEndpoint) => ep.readDeliveryLease(0);
const creds = new Map<Host, string>();
const holderOf = (host: Host) => deliveryLeaseHolderFor(creds.get(host)!);

async function suite(): Promise<void> {
  check("the broker answers", await until(() => isReachable(servers), 15_000));
  await setupSpaceStreams({ servers, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const h1 = makeHost("host1"), h2 = makeHost("host2");
  for (const h of [h1, h2]) {
    const own = await mintCreds(auth, h.delivery, "delivery", { expiresInSeconds: 45 });
    creds.set(h, own);
    await provision(h, { delivery: own });
  }
  check("the two host roots are separate, hold no space signer and name distinct delivery identities",
    h1.root !== h2.root && h1.delivery.id !== h2.delivery.id
    && [h1, h2].every((h) => !readdirSync(authDir(h.root)).some((name) => name.includes(SPACE) || name.endsWith(".json"))),
    { auth1: readdirSync(authDir(h1.root)), auth2: readdirSync(authDir(h2.root)) });

  const look = await inspector();
  const ask = await prober();
  const times: Record<string, number> = {};

  // ---- the first host serves, the second does not ---------------------------------------------------
  const run1 = startHost(h1);
  await until(() => run1.text().includes(`✓ delivery host up (1 space(s): ${SPACE})`) || run1.child.exitCode !== null, 120_000);
  check("the first host comes up serving the space", run1.text().includes(`✓ delivery host up (1 space(s): ${SPACE})`) && run1.child.exitCode === null, run1.text().slice(-800));
  const first = await lease(look);
  check("the lease row is ready and held by the first host's identity", first?.ready === true && first.holder === holderOf(h1), first);
  check("the control rail answers", await ask());
  const sink = await traffic();
  const delivered1 = await sink.post("before the standby starts");
  check("a post is delivered exactly once while the first host serves", await until(() => sink.copiesOf(delivered1) >= 1, 30_000) && (await wait(1500), sink.copiesOf(delivered1) === 1), sink.copiesOf(delivered1));

  const run2 = startHost(h2);
  check("the second host reports the held lease and keeps retrying",
    await until(() => run2.text().includes("a live lease already exists for shard 0") && run2.text().includes(`could not be served (`), 120_000), run2.text().slice(-800));
  check("the second host's ready line names the space it is retrying and serves none", run2.text().includes(`✓ delivery host up (0 space(s); retrying ${SPACE})`), run2.text().slice(-800));
  check("the second host keeps retrying on its own", await until(() => run2.text().split("could not be served (").length > 3, 30_000), run2.text().slice(-800));
  const standby = await lease(look);
  check("the second host never took or rewrote the row", standby?.holder === holderOf(h1) && standby.incarnation === first?.incarnation && standby.acquiredAt === first?.acquiredAt, { first, standby });
  check("the second host opened no lane", lanesUp(run2) === 0 && !run2.text().includes("delivery lane up"));
  const sweepSteady = await connz();
  const steady = { holder1: sweepSteady.get(h1.delivery.id) ?? 0, holder2: sweepSteady.get(h2.delivery.id) ?? 0 };
  check("the first host holds delivery connections", steady.holder1 >= 2, steady);

  // Only the fixture's provisioning owner signs. Each host receives its own renewed credential
  // through the same atomic SecretStore key it already reads, with no signer in either root.
  const initialExp = Math.max(...[h1, h2].map((h) => credsClaims(creds.get(h)!).exp ?? 0)) * 1000;
  check("initial delivery credentials have a live bounded expiry before renewal", initialExp > Date.now());
  for (const h of [h1, h2]) {
    const fresh = await mintCreds(auth, h.delivery, "delivery", { expiresInSeconds: 600 });
    check("renewal keeps this host's serving identity and extends its lifetime", deliveryLeaseHolderFor(fresh) === holderOf(h)
      && (credsClaims(fresh).exp ?? 0) * 1000 > initialExp);
    await h.store.put(deliveryCredsKey(SPACE, h.composition), fresh);
  }
  await wait(Math.max(0, initialExp - Date.now() + 1500));
  const afterRenewal = await lease(look);
  check("the original host serves beyond its initial credential expiry without replacing its lease", Date.now() > initialExp
    && afterRenewal?.holder === holderOf(h1) && afterRenewal.incarnation === first?.incarnation
    && lanesUp(run1) === 1 && await ask());
  check("the renewed standby remains non-serving until takeover", lanesUp(run2) === 0 && run2.child.exitCode === null);
  const renewedPost = await sink.post("after the first delivery credential expired");
  check("a post after credential renewal is durably delivered once", await until(() => sink.copiesOf(renewedPost) >= 1, 30_000)
    && (await wait(1500), sink.copiesOf(renewedPost) === 1));

  const malformed = makeHost("malformed-manifest");
  await provision(malformed);
  writeFileSync(malformed.manifest, JSON.stringify({ version: 2, spaces: [SPACE] }));
  const malformedRun = startHost(malformed);
  const malformedCode = await Promise.race([malformedRun.exited, wait(15_000).then(() => "timeout" as const)]);
  check("a malformed manifest refuses before any lane is opened", typeof malformedCode === "number" && malformedCode !== 0
    && malformedRun.text().includes("version must be 1") && lanesUp(malformedRun) === 0, { code: malformedCode });
  const afterMalformed = await lease(look);
  check("malformed manifest startup leaves the live holder and its delivery intact", afterMalformed?.holder === holderOf(h1)
    && afterMalformed.incarnation === first?.incarnation && await ask());

  // ---- refusal hosts against the live holder -----------------------------------------------------
  const refusals: { name: string; needle: string; prepare: (h: Host) => Promise<void> }[] = [
    { name: "unprovisioned root", needle: "delivery: no scoped creds at", prepare: async () => {} },
    { name: "foreign-account credential", needle: "the $SYS observer cred is scoped to account", prepare: (h) => provision(h, { delivery: undefined, observer: undefined }).then(async () => {
      await h.store.put(deliveryCredsKey(SPACE, h.composition), await mintCreds(foreignAuth, h.delivery, "delivery", { expiresInSeconds: 3600 }));
    }) },
    // The stock host reports a credential the broker cannot authenticate as an unreachable broker.
    { name: "malformed credential", needle: "delivery: can't reach NATS at", prepare: async (h) => { await provision(h, { delivery: "this is not a credential file" }); } },
    { name: "missing $SYS observer", needle: "the $SYS observer cred is not provisioned here", prepare: (h) => provision(h, { observer: null }) },
  ];
  const refusalRuns: { name: string; needle: string; run: Run }[] = [];
  for (const r of refusals) {
    const host = makeHost(`refuse-${refusalRuns.length}`);
    await r.prepare(host);
    refusalRuns.push({ ...r, run: startHost(host) });
  }
  for (const r of refusalRuns) {
    check(`${r.name}: refused natively, named and retried`, await until(() => r.run.text().includes(r.needle) && r.run.text().includes("retrying in 5s"), 120_000), r.run.text().slice(-600));
    console.log(`    ${r.name} reason: ${r.run.text().split("\n").find((l) => l.includes("could not be served ("))?.replace(/^.*could not be served \(/, "(").slice(0, 220)}`);
    check(`${r.name}: never opened a lane`, lanesUp(r.run) === 0 && !r.run.text().includes("a live lease already exists"), r.run.text().slice(-400));
  }
  const afterRefusals = await lease(look);
  check("the refusal hosts left the holder's row in place", afterRefusals?.holder === holderOf(h1) && afterRefusals.incarnation === first?.incarnation && afterRefusals.acquiredAt === first?.acquiredAt, afterRefusals);
  check("the holder kept serving through the refusals", await ask());
  for (const r of refusalRuns) await killAndAwaitExit(r.run.child, "SIGTERM", 30_000);

  // ---- the holder is killed, the standby takes over -----------------------------------------------
  await killAndAwaitExit(run1.child, "SIGKILL", 15_000);
  const killedAt = Date.now();
  check("the holder exited by SIGKILL before the outage post", run1.child.signalCode === "SIGKILL");
  const finalHolderLease = await lease(look);
  check("the killed holder's final lease is still present and no control responder remains", finalHolderLease?.holder === holderOf(h1) && !await ask(), finalHolderLease);
  const outageId = await sink.post("posted after the first host exited");
  check("the outage post was accepted before any durable copy or control responder returned", typeof outageId === "string" && outageId.length > 0 && sink.copiesOf(outageId) === 0 && !await ask());
  let rowGoneAt: number | undefined, takeoverAt: number | undefined, taken: Awaited<ReturnType<typeof lease>>;
  const tookOver = await until(async () => {
    taken = await lease(look);
    if (taken === undefined) rowGoneAt ??= Date.now();
    else if (taken.holder === holderOf(h2) && taken.ready === true) takeoverAt ??= Date.now();
    return takeoverAt !== undefined;
  }, 120_000, 200);
  check("the standby took the lease with its own identity after the holder was killed", tookOver && taken?.holder === holderOf(h2) && taken.ready === true, { taken, finalHolderLease });
  check("the successor was acquired after the final holder lease's TTL window", finalHolderLease !== undefined && taken?.acquiredAt !== undefined && taken.acquiredAt >= finalHolderLease.since + LEASE_TTL_MS, { rowGoneAt, finalHolderLease, taken });
  times.rowExpiredAfterKillMs = rowGoneAt === undefined ? -1 : rowGoneAt - killedAt;
  times.takeoverAfterKillMs = takeoverAt === undefined ? -1 : takeoverAt - killedAt;
  times.lastRenewalBeforeKillAgeMs = finalHolderLease === undefined ? -1 : killedAt - finalHolderLease.since;
  check("the standby's lane opened once and it answers the control rail", lanesUp(run2) === 1 && await until(ask, 15_000), run2.text().slice(-600));
  check("the post made during the outage reaches the receiver exactly once", outageId !== undefined && await until(() => sink.copiesOf(outageId) >= 1, 60_000) && (await wait(2000), sink.copiesOf(outageId) === 1), outageId && sink.copiesOf(outageId));
  const afterTakeover = await sink.post("after the standby took over");
  check("a post made after the takeover is delivered exactly once", await until(() => sink.copiesOf(afterTakeover) >= 1, 30_000) && (await wait(1500), sink.copiesOf(afterTakeover) === 1), sink.copiesOf(afterTakeover));
  const sweepTaken = await connz();
  const takeoverConns = { holder1: sweepTaken.get(h1.delivery.id) ?? 0, holder2: sweepTaken.get(h2.delivery.id) ?? 0 };
  check("the new holder holds delivery connections", takeoverConns.holder2 >= 2, takeoverConns);
  const held2 = await lease(look);

  // ---- the first host returns ---------------------------------------------------------------------
  const back = startHost(h1);
  check("the returning host reports the held lease and retries", await until(() => back.text().includes("a live lease already exists for shard 0") && back.text().split("could not be served (").length > 2, 120_000), back.text().slice(-800));
  check("the returning host opened no lane", lanesUp(back) === 0);
  const afterReturn = await lease(look);
  check("the returning host did not delete or rewrite the current holder's row", afterReturn?.holder === holderOf(h2) && afterReturn.incarnation === held2?.incarnation && afterReturn.acquiredAt === held2?.acquiredAt && afterReturn.ready === true && (afterReturn.since ?? 0) >= (held2?.since ?? 0), { held2, afterReturn });
  check("the current holder still serves with one lane", await ask() && lanesUp(run2) === 1);
  const sweepReturn = await connz();
  const returnConns = { holder1: sweepReturn.get(h1.delivery.id) ?? 0, holder2: sweepReturn.get(h2.delivery.id) ?? 0 };
  check("the current holder keeps its delivery connections", returnConns.holder2 >= 2, returnConns);
  await killAndAwaitExit(back.child, "SIGTERM", 30_000);
  const afterReturnStop = await lease(look);
  check("stopping the returning host left the current holder's row in place", afterReturnStop?.holder === holderOf(h2) && afterReturnStop.incarnation === held2?.incarnation && afterReturnStop.acquiredAt === held2?.acquiredAt, afterReturnStop);
  check("the current holder still answers after the returning host stopped", await ask());

  // ---- graceful stop of the holder: the standby takes the released row -----------------------------
  const run3 = startHost(h1);
  check("the first host is standby again", await until(() => run3.text().includes("a live lease already exists for shard 0"), 120_000), run3.text().slice(-600));
  const releasedFrom = Date.now();
  run2.child.kill("SIGTERM");
  const code2 = await Promise.race([run2.exited, wait(30_000).then(() => "timeout" as const)]);
  check("the holder stops on SIGTERM with exit 0", code2 === 0, { code2, tail: run2.text().slice(-400) });
  let regained: Awaited<ReturnType<typeof lease>>, regainedAt: number | undefined;
  const handover = await until(async () => {
    regained = await lease(look);
    if (regained?.holder === holderOf(h1) && regained.ready === true) regainedAt ??= Date.now();
    return regainedAt !== undefined;
  }, 60_000, 200);
  check("the standby took the released row with its own identity", handover && regained?.holder === holderOf(h1) && regained.incarnation !== undefined && regained.incarnation !== held2?.incarnation, { regained, held2 });
  times.gracefulHandoverMs = regainedAt === undefined ? -1 : regainedAt - releasedFrom;
  check("the new holder's lane opened once and it answers", lanesUp(run3) === 1 && await until(ask, 15_000), run3.text().slice(-600));
  const last = await sink.post("after the graceful handover");
  check("a post after the graceful handover is delivered exactly once", await until(() => sink.copiesOf(last) >= 1, 30_000) && (await wait(1500), sink.copiesOf(last) === 1), sink.copiesOf(last));
  run3.child.kill("SIGTERM");
  const code3 = await Promise.race([run3.exited, wait(30_000).then(() => "timeout" as const)]);
  check("the last holder stops with exit 0 and releases the row", code3 === 0 && await until(async () => (await lease(look)) === undefined, 10_000), { code3, row: await lease(look) });
  check("no member endpoint reported an error", sink.errors.length === 0, sink.errors);
  console.log(`STANDBY_RESULT ${JSON.stringify({ space: "isolated single machine, two host processes, one broker", times, steady, takeoverConns, returnConns, killToTakeoverNote: "measured in this topology; not an SLA, not a TTL-plus-retry bound" })}`);
}

try {
  await suite();
} catch (error) {
  fail++;
  console.log(`  ✗ FAIL: the suite threw: ${(error as Error).stack ?? error}`);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await killAndAwaitExit(child, "SIGKILL");
  for (const nc of callers) await nc.close().catch(() => {});
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await killAndAwaitExit(nats, "SIGKILL");
  if (fail > 0) console.log(`--- broker log tail ---\n${brokerLog.slice(-1500)}`);
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ndelivery standby: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
