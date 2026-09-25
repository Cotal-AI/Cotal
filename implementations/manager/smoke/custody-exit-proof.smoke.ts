/**
 * CUSTODY-EXIT-PROOF SMOKE
 *
 * Verifies that static retirement and reap require authoritative exit proof:
 * 1. Clean stop/despawn: custodian unlinks the custody record on exit; retirement verifies the exit
 *    authoritatively via pinned record and completes deprovisioning, freeing the alias.
 * 2. Custodian SIGKILL with surviving child (SIGHUP ignored): the custodian dies, but the child
 *    remains alive. Socket loss sets SeatHandle.status() == "exited" via failAll, but the child is NOT
 *    dead. Static retirement must NOT free the alias without authoritative exit proof.
 * 3. Unadopted reference with missing on-disk record fails closed as RuntimeReapUnproven.
 *
 * Run: pnpm tsx implementations/manager/smoke/custody-exit-proof.smoke.ts
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager, JetStreamApiError, JetStreamApiCodes } from "@nats-io/jetstream";
import {
  isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity, setupSpaceStreams,
  openAclRegistry, readAcl, dmStream, dlvStream, dmDurable, dlvDurable, DEV_OWNER, principalKey,
  mintLifecycleUid, CotalEndpoint, evictDeniedPrincipalWithCreds,
  mintConnectionEvictorCreds, mintMembershipObserverCreds,
} from "@cotal-ai/core";
import type { Connector, LaunchOpts, LaunchSpec } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { registry } from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit, emitSentinel } from "@cotal-ai/smoke-kit";
import { identityVerdict, type SeatRecord } from "@cotal-ai/seat";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");
// Restoration state is not a child-process environment.
const savedEnv = new Map(Object.entries(process.env));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("COTAL_") || key.startsWith("JCODE_COTAL_")) delete process.env[key];
}
const seatRoot = mkdtempSync(join(tmpdir(), "s"));
process.env.COTAL_SEAT_ROOT = seatRoot;
const ownedRecords: SeatRecord[] = [];

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EXPECTED_CHECKS = 23;
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? extra : ""); }
};

const space = `cust-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
process.env.COTAL_HOME = join(dir, "home");
mkdirSync(process.env.COTAL_HOME, { recursive: true });
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const n of ["clean1", "survivor1"]) {
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
}
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], {
  stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.COTAL_HOME, TMPDIR: dir },
});
const releaseBroker = teardownOnSignal(srv);
let delivery: CotalEndpoint | undefined;

const DM = dmStream(space), DLV = dlvStream(space);
const provId = newIdentity();
const provCreds = await mintCreds(auth, provId, "provisioner");

async function inspect<T>(fn: (jsm: Awaited<ReturnType<typeof jetstreamManager>>, aclNc: import("@nats-io/transport-node").NatsConnection) => Promise<T>): Promise<T> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)), inboxPrefix: `_INBOX_${provId.id}`, maxReconnectAttempts: 0 });
  try { return await fn(await jetstreamManager(nc), nc); } finally { await nc.drain().catch(() => {}); }
}
const consumerExists = (stream: string, name: string) =>
  inspect(async (jsm) => {
    try {
      await jsm.consumers.info(stream, name);
      return true;
    } catch (e) {
      if (e instanceof JetStreamApiError && e.code === JetStreamApiCodes.ConsumerNotFound) return false;
      throw e;
    }
  });
const localPrincipal = (id: string) => principalKey(DEV_OWNER, id).key;
const aclPresent = (id: string, uid: string) => inspect(async (_j, nc) => (await readAcl(await openAclRegistry(nc, space), localPrincipal(id), uid)) !== undefined);
const credsFile = (name: string, uid: string) => agentLifecycleSecretFilePaths(workspaceRoot, space, name, uid).creds;
async function until(f: () => Promise<boolean>, want: boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await f()) === want) return true; await wait(300); }
  return (await f()) === want;
}

function processGroupOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.lastIndexOf(") ");
    if (after < 0) return undefined;
    const fields = stat.slice(after + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    const pgrp = Number(fields[2]);
    return Number.isInteger(pgrp) ? pgrp : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw error;
  }
}
function groupMembers(pgid: number): number[] {
  const out: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (processGroupOf(pid) === pgid) out.push(pid);
  }
  return out;
}

async function killAndAwaitGroup(pgid: number, start: string, ms = 5000): Promise<void> {
  if (identityVerdict(pgid, start) === "live") {
    try { process.kill(-pgid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (identityVerdict(pgid, start) === "gone" && groupMembers(pgid).length === 0) return;
    await wait(50);
  }
  throw new Error(`fixture group ${pgid} exit is unproven; preserve its storage`);
}

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds), COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});

const stubCon: Connector = { kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
const survivorCon: Connector = {
  kind: "connector",
  name: "e2e-survivor",
  requires: ["node"],
  buildLaunch: (o): LaunchSpec => ({
    command: "sh",
    args: ["-c", `trap '' HUP; node ${STUB} & wait $!`],
    env: envFor(o),
  }),
};
registry.register(stubCon);
registry.register(survivorCon);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
  const deliveryId = newIdentity();
  delivery = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, deliveryId, "delivery"),
    card: { id: deliveryId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  delivery.on("error", () => {});
  await delivery.start();
  const dlvRevision = await delivery.acquireDeliveryLease(0);
  await delivery.startPlane3(async () => undefined, {
    evictPrincipal: (principal) => evictDeniedPrincipalWithCreds({
      servers: SERVERS, observerCreds, evictorCreds, accountId: auth.account.pub, principal,
    }),
    reloadStoreIdentity: () => ({ kind: "fs", root: resolve(workspaceRoot) }),
  });
  await delivery.markDeliveryLeaseReady(0, dlvRevision);
  await mgr.start();

  type PrivMgr = {
    agents: Map<string, { id: string; lifecycleUid: string; handle: { record?: import("@cotal-ai/seat").SeatRecord; pid?: number; status: () => string } }>;
    retiring: Map<string, unknown>;
    opStop: (a: Record<string, unknown>, c: string, admin: boolean) => Promise<unknown>;
    ep: { ref: () => { id: string } };
  };
  const priv = mgr as unknown as PrivMgr;
  const callerId = priv.ep.ref().id;

  // ─────────────────────────────────────────────────────────────────────────────
  // Cell 1: Clean despawn completes and deprovisions
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("1. Clean despawn → footprint deprovisioned:");
  const r1 = await mgr.startAgent({ name: "clean1", agent: "e2e-stub", cwd: repoRoot, events: false });
  check("clean1 started", r1.ok === true, r1);
  const rec1 = priv.agents.get("clean1")?.handle.record;
  if (!rec1) throw new Error("clean1 missing custody record");
  ownedRecords.push(rec1);
  const id1 = (r1 as { data: { id: string } }).data.id;
  const uid1 = (r1 as { data: { lifecycleUid: string } }).data.lifecycleUid;

  check("clean1 dm_local- durable exists before despawn", await consumerExists(DM, dmDurable(DEV_OWNER, id1, uid1)));
  check("clean1 dlv_local- durable exists before despawn", await consumerExists(DLV, dlvDurable(DEV_OWNER, id1, uid1)));
  check("clean1 read-ACL row exists before despawn", await aclPresent(id1, uid1));
  check("clean1 creds file exists before despawn", existsSync(credsFile("clean1", uid1)));

  await priv.opStop({ name: "clean1", graceful: false }, callerId, true);
  check("clean1 dm_local- durable gone after despawn", await until(() => consumerExists(DM, dmDurable(DEV_OWNER, id1, uid1)), false));
  check("clean1 dlv_local- durable gone after despawn", await until(() => consumerExists(DLV, dlvDurable(DEV_OWNER, id1, uid1)), false));
  check("clean1 read-ACL row gone after despawn", await until(() => aclPresent(id1, uid1), false));
  check("clean1 creds file gone after despawn", await until(async () => existsSync(credsFile("clean1", uid1)), false));
  check("clean1 alias freed from retiring", await until(async () => !priv.retiring.has("clean1"), true));

  // ─────────────────────────────────────────────────────────────────────────────
  // Cell 2: Custodian SIGKILL with surviving child refuses retirement
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("2. Custodian SIGKILL with surviving child → retirement refused:");
  const r2 = await mgr.startAgent({ name: "survivor1", agent: "e2e-survivor", cwd: repoRoot, events: false });
  check("survivor1 started", r2.ok === true, r2);
  const id2 = (r2 as { data: { id: string } }).data.id;
  const uid2 = (r2 as { data: { lifecycleUid: string } }).data.lifecycleUid;

  check("survivor1 dm_local- durable exists before despawn", await consumerExists(DM, dmDurable(DEV_OWNER, id2, uid2)));
  check("survivor1 dlv_local- durable exists before despawn", await consumerExists(DLV, dlvDurable(DEV_OWNER, id2, uid2)));
  check("survivor1 read-ACL row exists before despawn", await aclPresent(id2, uid2));
  check("survivor1 creds file exists before despawn", existsSync(credsFile("survivor1", uid2)));

  const a2 = priv.agents.get("survivor1");
  const rec2 = a2?.handle.record;
  check("survivor1 has custody record", rec2 !== undefined);

  const childPid = rec2 ? rec2.childPid : 0;
  const custodianPid = rec2 ? rec2.custodianPid : 0;
  const childStart = rec2?.childStart ?? "";
  const custodianStart = rec2?.custodianStart ?? "";
  if (rec2) ownedRecords.push(rec2);

  check("survivor1 child is live before custodian SIGKILL", identityVerdict(childPid, childStart) === "live");

  // SIGKILL the custodian directly
  if (custodianPid) process.kill(custodianPid, "SIGKILL");
  await wait(200);

  check("custodian is gone", identityVerdict(custodianPid, custodianStart) === "gone");
  check("child is STILL LIVE after custodian killed", identityVerdict(childPid, childStart) === "live");

  // Now attempt despawn / stop on survivor1:
  await priv.opStop({ name: "survivor1", graceful: false }, callerId, true);

  // Give deprovisioning a chance to run:
  await wait(2000);

  const aliasFreed = !priv.retiring.has("survivor1");
  const childGone = identityVerdict(childPid, childStart) === "gone";
  const groupEmpty = groupMembers(childPid).length === 0;
  check("if alias freed, child is verified gone", !aliasFreed || childGone);
  check("if alias freed, process group is verified empty", !aliasFreed || groupEmpty);

  // Clean up the survivor process group directly:
  if (childPid) await killAndAwaitGroup(childPid, childStart);

  // ─────────────────────────────────────────────────────────────────────────────
  // Cell 3: No-pinned-record refusal (unadopted orphan with missing disk record fails closed)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("3. No-pinned-record refusal → fails closed as RuntimeReapUnproven:");
  const { requireRuntimeReap, RuntimeReapUnproven } = await import("../src/runtime/index.js");
  const fakeRef = { kind: "pty" as const, id: "0123456789abcdef0123456789abcdef" };
  let reapThrew: unknown;
  try {
    await requireRuntimeReap((mgr as unknown as { runtime: import("../src/runtime/index.js").Runtime }).runtime, fakeRef);
  } catch (e) {
    reapThrew = e;
  }
  check("reap with no disk record and no pinned record throws RuntimeReapUnproven", reapThrew instanceof RuntimeReapUnproven);

  // ─────────────────────────────────────────────────────────────────────────────
  // Sentinel: all expected checks completed
  // ─────────────────────────────────────────────────────────────────────────────
  check("all expected checks completed without error", pass + fail === EXPECTED_CHECKS - 1);
} finally {
  const cleanupErrors: unknown[] = [];
  try { await mgr.stop({ withAgents: true }); } catch (error) { cleanupErrors.push(error); }
  try { await delivery?.stop(); } catch (error) { cleanupErrors.push(error); }
  for (const rec of ownedRecords) {
    try {
      await killAndAwaitGroup(rec.childPid, rec.childStart ?? "");
      if (identityVerdict(rec.custodianPid, rec.custodianStart ?? "") !== "gone") {
        throw new Error("fixture custodian exit is unproven");
      }
    } catch (error) { cleanupErrors.push(error); }
  }
  await killAndAwaitExit(srv, "SIGKILL");
  if (srv.exitCode === null && srv.signalCode === null) cleanupErrors.push(new Error("fixture broker exit is unproven"));
  releaseBroker();
  for (const key of Object.keys(process.env)) if (!savedEnv.has(key)) delete process.env[key];
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "fixture cleanup failed; storage preserved");
  rmSync(dir, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true });
}

console.log(`\nCUSTODY EXIT PROOF SMOKE (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail, cells: pass + fail });
process.exit(fail === 0 && pass === EXPECTED_CHECKS ? 0 : 1);
