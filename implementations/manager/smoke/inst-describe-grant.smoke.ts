/**
 * INSTANCE-PINNED DESCRIBE GRANT (#397) — the baseline row that makes `--on` reach its instance.
 *
 * The defect: the client has always routed a describe carrying an `instanceId` on the `ep.inst`
 * rail, and every serve credential has always SUBSCRIBED that rail (the reserved describe is
 * derived for every serve). Only the caller's PUBLISH row was missing, so every instance-addressed
 * describe died at the broker as
 *   `Publish Violation on <space>.ep.inst.<endpoint>.<instance>.describe.<caller>`
 * and the client surfaced that as `no describe reply from <endpoint> within 10000ms`. So `--on`
 * looked like an unresponsive or overloaded manager, and was in fact unauthorized by construction —
 * it had never once worked. The wrong story was plausible enough to absorb the evidence for days.
 *
 * The fix is one baseline row, `ep.inst.*.*.describe.<caller>.*`, argued as reach-neutral: the
 * class row already grants describe on EVERY endpoint, and a describe answer is the endpoint's
 * public content-addressed contract surface, identical whichever registered instance returns it.
 * Phase 2 checks that neutrality is real rather than asserted — the pinned answer must MATCH the
 * unpinned one.
 *
 * SCOPE, asserted rather than left implicit: this row covers `describe` ONLY. A pinned INVOKE needs
 * its own instance-rail grant, which is deliberately not in the agent baseline. Phase 3 pins that
 * boundary down so a later reader does not mistake "`--on` describes" for "`--on` works".
 *
 * Run: pnpm smoke:inst-describe-grant
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER, EpEnvelopeError,
  resolveService, epDescribeInstGrantRow, epBaselineGrantRows,
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
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`this probe only runs against an ephemeral loopback broker; got ${SERVERS}`);
console.log(`broker-url guard: ${SERVERS} is ephemeral loopback; no env var references ${LIVE_HOST}\n`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const space = `instdesc-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-instdesc-"));
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(r), auth);
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

type MgrPriv = { managerInstanceId: string };
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1"), root2 = mkRoot("ws2");
  for (const r of [root1, root2]) recordMesh({ space, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  m1 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;
  check("two managers registered distinct instance ids (a pin has something to disambiguate)", IID1 !== IID2, { IID1, IID2 });

  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };

  console.log("\n1. the row is in the AGENT BASELINE (not an operator-only extra)");
  const rows = epBaselineGrantRows(space, caller).pub;
  const instRow = epDescribeInstGrantRow(space, caller);
  check("the baseline publish set carries the inst-rail describe row", rows.includes(instRow), instRow);
  check("the row wildcards endpoint AND instance, pins the caller, and names only `describe`",
    /\.ep\.inst\.\*\.\*\.describe\./.test(instRow) && instRow.includes(caller.actor), instRow);

  // A PLAIN agent cred: baseline only, no endpoint capabilities, no operator set. If the pinned
  // describe works for this credential it works for every credential in the space.
  const creds = await mintCreds(auth, id, "agent", { lifecycleUid: uid });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });

  console.log("\n2. a PINNED describe reaches the instance it named (was: a 10s timeout, always)");
  // Without the grant a pinned resolve THROWS (the refused publish expires as a describe timeout),
  // and an uncaught throw would kill this script before the assertion below ever printed — a red
  // run that never names its reason. Catch it so the failure is REPORTED as this check, not as a
  // stack trace: the whole point of the suite is to be legible when the grant is absent.
  const pin = async (iid: string): Promise<{ ok: true; svc: Awaited<ReturnType<typeof resolveService>> } | { ok: false; why: string }> => {
    try { return { ok: true, svc: await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000, instanceId: iid }) }; }
    catch (e) { return { ok: false, why: e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message }; }
  };
  for (const [label, iid] of [["A", IID1], ["B", IID2]] as const) {
    const r = await pin(iid);
    check(`pinning ${label} is answered by ${label} itself, not by the class queue`,
      r.ok && r.svc.responder.instanceId === iid && r.svc.pinnedInstanceId === iid,
      r.ok ? { want: iid, got: r.svc.responder.instanceId } : r.why);
  }

  // Reach-neutrality, CHECKED rather than argued: the pinned answer must be the same surface the
  // class rail already hands out. If pinning could reveal anything extra, the baseline placement
  // would be wrong.
  const unpinned = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000 });
  const pinnedAr = await pin(IID1);
  const pinnedA = pinnedAr.ok ? pinnedAr.svc : unpinned; // fall through to a fair comparison; the check above already recorded the failure
  const surface = (s: { commands: Map<string, unknown> }): string => [...s.commands.keys()].sort().join(",");
  check("the pinned answer is IDENTICAL to the unpinned one — the row grants a route, not reach",
    pinnedAr.ok && surface(pinnedA) === surface(unpinned) && pinnedA.owner === unpinned.owner,
    pinnedAr.ok ? { pinned: surface(pinnedA).slice(0, 60), unpinned: surface(unpinned).slice(0, 60) } : "the pinned resolve never completed");

  console.log("\n3. SCOPE: describe only — a pinned INVOKE still needs its own instance-rail grant");
  const capId = newIdentity();
  const capUid = mintLifecycleUid();
  const capCaller: EpCaller = { owner: DEV_OWNER, actor: capId.id, uid: capUid };
  const capCreds = await mintCreds(auth, capId, "agent", {
    lifecycleUid: capUid,
    endpointCapabilities: [{ endpoint: MANAGER_ENDPOINT, command: "status" }], // CLASS-rail status only
  });
  const capNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: capCreds, tls: false }), maxReconnectAttempts: 0 });
  let capSvc: Awaited<ReturnType<typeof resolveService>> | undefined;
  try { capSvc = await resolveService(capNc, space, MANAGER_ENDPOINT, capCaller, { deadlineMs: 10_000, instanceId: IID1 }); }
  catch { capSvc = undefined; } // same reason as above: report it, never crash the run
  check("that caller CAN pin its describe (the baseline row is enough for the resolve)",
    capSvc?.responder.instanceId === IID1, capSvc?.responder.instanceId ?? "the pinned resolve never completed");
  if (capSvc) {
    const { invokeCommand } = await import("@cotal-ai/core");
    let invokeOutcome = "SUCCEEDED";
    try {
      await invokeCommand(capNc, space, capSvc, "status", undefined, { deadlineMs: 4_000 });
    } catch (e) {
      invokeOutcome = e instanceof EpEnvelopeError ? e.code : "error";
    }
    console.log(`   pinned invoke with only a CLASS-rail status capability: ${invokeOutcome}`);
    check("...but the pinned INVOKE does not ride on it — that grant is deliberately separate",
      invokeOutcome !== "SUCCEEDED", invokeOutcome);
  }
  await capNc.drain().catch(() => capNc.close());

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  await nc.drain().catch(() => nc.close());
} finally {
  await m1?.stop().catch(() => {});
  await m2?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
