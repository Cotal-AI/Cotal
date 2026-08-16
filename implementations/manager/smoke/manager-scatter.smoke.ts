/**
 * MANAGER CLASS-SCATTER smoke (control-surface P2 item 3, unit [1]: `cotal ps` default class scatter).
 *
 * Two managers in ONE space (two workspace roots, two logical instance ids), AUTH mesh. The P2
 * acceptance surface "class scatter returns both manager statuses": a `control-caller-privileged`
 * instrument FREEZES the expected set from the records registry (its scoped §13.9 read grant) and
 * scatters `ps` on the `all` rail, gathering ONE attributed reply per instance. Then a manager is
 * severed (its serve loop torn down WITHOUT deregistering — the crash shape: the svc record stays
 * READY, so the freeze still names it) and the scatter labels it UNREACHABLE (a `missing` slot),
 * never silently omitted (pin 3), deadline-bounded.
 *
 * RED-FIRST: before the scoped records-read grant + the `scatterCommand` helper + the `ep.all`
 * publish row on the instrument, the freeze is broker-denied and there is no scatter helper.
 *
 * Run: pnpm smoke:manager-scatter   (needs nats-server + node on PATH; boots its own JWT broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER,
  openRecordsBucket, freezeExpectedSet, resolveService, scatterCommand, instancePinnedInstrumentCapabilities,
  type EpCaller,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `mgrscatter-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(SPACE);
const dir = mkdtempSync(join(tmpdir(), "cotal-scatter-"));
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(r), auth); // each manager reloads the SAME space auth from its own root
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));

type MgrPriv = { managerInstanceId: string };
const kids: ReturnType<typeof spawn>[] = [];
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;
let nc: NatsConnection | undefined;
try {
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  kids.push(srv);
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1"), root2 = mkRoot("ws2");
  for (const r of [root1, root2]) recordMesh({ space: SPACE, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  m1 = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;
  check("two managers in one space registered distinct logical instance ids", IID1 !== IID2, { IID1, IID2 });

  // The caller is exactly the `ps` instrument: a `control-caller-privileged` mint (lifecycle-keyed).
  const callerId = newIdentity();
  const callerUid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: callerId.id, uid: callerUid };
  // Pinned to the frozen class, which is the shape the CLI mints after its freeze-then-mint pass:
  // an exact-iid row per instance, no wildcard. Without these rows the scatter's liveness probe is
  // refused at the broker and the severed-instance case below serves out its whole budget.
  const callerCreds = await mintCreds(auth, callerId, "control-caller-privileged", {
    lifecycleUid: callerUid,
    endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", [IID1, IID2]),
  });
  nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: callerCreds, tls: false }), maxReconnectAttempts: 0 });

  console.log("1. the instrument FREEZES the expected set (its scoped §13.9 records read)");
  // checkAPI:false — the scoped scatter grant carries NO account `$JS.API.INFO` (exactly how
  // scatterCommand constructs its JSM); the freeze rides only the `svc.*` records rows.
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const recKv = await openRecordsBucket(nc, SPACE);
  const frozen = await freezeExpectedSet(jsm, SPACE, MANAGER_ENDPOINT);
  const frozenIds = new Set(frozen.map((f) => f.instanceId));
  check("the caller instrument can FREEZE the class (scoped records-read grant) — both instances present",
    frozen.length === 2 && frozenIds.has(IID1) && frozenIds.has(IID2), frozen);

  console.log("2. class scatter returns BOTH manager statuses (pin 3: per-instance attribution)");
  const service = await resolveService(nc, SPACE, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000 });
  const r1 = await scatterCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 6_000 });
  check("the scatter gathered ONE reply per instance — both managers answered",
    r1.replies.size === 2 && r1.replies.has(IID1) && r1.replies.has(IID2), { replies: [...r1.replies.keys()], missing: r1.missing });
  check("both attributed replies are ok (each manager's own ps rows)",
    r1.replies.get(IID1)?.reply.ok === true && r1.replies.get(IID2)?.reply.ok === true);
  check("no instance is missing when both are live (complete coverage)", r1.missing.length === 0 && r1.complete === true, r1.missing);

  console.log("3. a severed manager is labeled UNREACHABLE, never omitted (pin 3), deadline-bounded");
  await m2.stop(); // tear down the serve loop; the svc record is NOT deregistered (stays READY)
  m2 = undefined;
  await wait(500);
  // The freeze STILL names IID2 (READY record, no deregistration): a severed instance is not silently
  // dropped from the expected set.
  const frozen2 = await freezeExpectedSet(jsm, SPACE, MANAGER_ENDPOINT);
  check("the severed instance is STILL frozen (READY record, no clean deregister)",
    new Set(frozen2.map((f) => f.instanceId)).has(IID2), frozen2);
  const t0 = Date.now();
  const r2 = await scatterCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 3_000 });
  const elapsed = Date.now() - t0;
  check("the live instance still answered (its reply is present)", r2.replies.has(IID1), [...r2.replies.keys()]);
  check("the severed instance is reported UNREACHABLE (a missing slot), NEVER omitted (pin 3)",
    r2.missing.includes(IID2) && r2.complete === false, { missing: r2.missing, complete: r2.complete });
  check("the scatter is deadline-bounded — a dead instance does not hang the gather", elapsed < 8_000, { elapsed });
  // THE CELL ABOVE PASSES ON THE DEFECT, and did for as long as it existed: the budget is 3000ms
  // and the bound is 8000ms, so "the gather paid its deadline in full" — the thing `ps` was slow
  // for — reads as ~3050ms and sails through. It proves the gather is BOUNDED; its name promises
  // FAST. Kept as-is (bounded is still worth asserting) and joined by the claim it was read as
  // making.
  //
  // THE END-TO-END PROOF for the liveness probe, and it has to be here rather than in
  // `smoke:scatter-liveness`. That suite hands `epScatter` its hook directly, which proves the
  // gather DEPENDS on a verdict but not that any real caller produces one — mutation-proof says so
  // itself. Nothing is handed in here: a real `scatterCommand` over a real broker, against a manager
  // severed exactly as a crash severs it (serve loop torn down, svc record left READY), under the
  // instrument's own credential.
  //
  // WHAT MAKES IT REACHABLE IS THE CREDENTIAL, NOT THE GATHER, and `cotal ps` does not carry it
  // today — so read this cell for exactly what it proves and no more. The probe publishes `describe`
  // on the target's `ep.inst.…` rail; the instrument is one-shot and minted before the freeze, so a
  // `ps` without `--on` holds no instance rows, the publish is refused, no no-responders frame comes
  // back, the verdict is `unknown`, and `unknown` licenses nothing. This suite mints the pinned
  // capabilities explicitly, which is why the gather ends early here.
  //
  // The CLI wiring that would produce that credential (freeze the class first, re-mint against the
  // frozen ids — exact ids only, so the `inst-route-grant` no-wildcard boundary stays intact) was
  // built and then REMOVED, because it was measured on a live mesh and made `cotal ps` SLOWER:
  // 13.8s -> 17.0s. The extra connect and freeze cost ~3.2s and bought nothing there, because of the
  // three registered managers only ONE was a true corpse (`gone` in 123ms); another answered nothing
  // for 8s while still HOLDING its subscriptions, so it is hung rather than gone and no liveness
  // probe may shortcut it — "connected but slow" and "connected but wedged" are the same observation.
  // A hung instance therefore still costs the full deadline, which is correct.
  //
  // So the mechanism is proven and its cost is not yet worth paying on the operator path. The
  // remaining slowness there is a HUNG MANAGER, which is a different defect.
  check("a severed instance is affirmed gone by the BROKER, so the gather ends instead of serving out its budget",
    elapsed < 1_500, { elapsed, budgetMs: 3_000 });
} finally {
  try { await nc?.drain(); } catch { /* ignore */ }
  await m2?.stop().catch(() => {});
  await m1?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

console.log(`\n${fail === 0 ? "MANAGER CLASS-SCATTER SMOKE OK ✅" : "MANAGER CLASS-SCATTER SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
