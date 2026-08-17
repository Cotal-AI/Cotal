/**
 * DESCRIBE/INVOKE SPLIT — NO DUPLICATE EFFECT ON THE CLASS QUEUE (live regression guard).
 *
 * A resolved handle binds the describe winner's instance; an unpinned invoke goes to the class
 * queue, which picks its own. While the currency check ran only AFTER the reply landed, a
 * non-matching responder had already executed the command when `failed-precondition` was raised,
 * and `invokeService` re-invoked with the same args — for a write, a duplicate the caller could not
 * see. This probe first reproduced that; the pre-effect fence closed it, and the probe now holds it
 * closed. It grades either tip: on an unfenced one the duplicates return and it fails.
 *
 * What it asserts is the CALLER-VISIBLE contract, not the mechanism: one request causes at most one
 * effect, and a request that caused none says so conclusively. A remedy that keeps that promise by
 * other means passes, which is the point — it is a guard, not a mirror of the implementation.
 *
 * `define-persona`, never `spawn`: a duplicated `spawn` starts a second real agent process.
 *
 * Effects are counted at the RESPONDERS because the caller's view is what is under test — each
 * manager writes personas into its own root, so one name in BOTH roots proves it ran twice. This
 * undercounts (a retry landing on the same instance leaves one file), so every number is a floor.
 *
 * Run: pnpm smoke:describe-split-effect   (needs nats-server on PATH; boots its own broker)
 */import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, DEV_OWNER, agentFilePath, CotalEndpoint, EpEnvelopeError,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

// A literal, not an import: the constant does not exist on tips predating the fence, and an import
// would make this probe refuse to load on the very tip it is the baseline for.
const EP_BIND_REFUSED = "ai.cotal.ep.bind-refused";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

// This probe performs WRITES; it must never be able to reach a real mesh.
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

const space = `epsplit-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-epsplit-"));
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
let ep: CotalEndpoint | undefined;

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
  check("two managers registered distinct instance ids (a real two-way race, not a single responder)",
    IID1 !== IID2, { IID1, IID2 });

  const id = newIdentity();
  const uid = mintLifecycleUid();
  const creds = await mintCreds(auth, id, "agent", { lifecycleUid: uid, capabilities: ["spawn"] });
  ep = new CotalEndpoint({
    space, servers: SERVERS, creds, lifecycleUid: uid,
    channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { name: "epsplit-caller", owner: DEV_OWNER, actor: id.id, kind: "endpoint" },
  });
  ep.on("error", () => {});
  // Emitted by the fence's repair path; never fires on a pre-fence tip, so one instrument grades both.
  let recoveriesThisTrial = 0, recoveriesTotal = 0;
  ep.on("split-recovered", () => { recoveriesThisTrial++; recoveriesTotal++; });
  await ep.start();

  const N = 24;
  type Trial = {
    i: number; name: string;
    inRoot1: boolean; inRoot2: boolean; both: boolean;
    callerSaw: "ok" | "app-error" | "throw";
    detail: string;
    repairs: number;
    /** The refusal said the command did not run — the marker AND `not-executed` together, because
     *  the marker is this implementation's vocabulary and the outcome is the spec's, and only the
     *  outcome licenses a caller to conclude that no effect exists. */
    refusedBeforeEffect: boolean;
    /** The failure said whether its effect landed, either way. §13.3 reads an ABSENT outcome as
     *  `unknown`, so absence is the caller being left unable to tell — which is the condition this
     *  whole class of defect consists of, duplicate or not. */
    outcomeStated: boolean;
  };
  const trials: Trial[] = [];
  let bindRefused = 0;

  console.log(`\n1. ${N} describe+invoke trials of the write \`define-persona\`, two live managers`);
  for (let i = 0; i < N; i++) {
    const name = `epsplit-${i}`;
    let callerSaw: Trial["callerSaw"] = "ok";
    let detail = "";
    let refusedBeforeEffect = false;
    let outcomeStated = true;
    recoveriesThisTrial = 0;
    try {
      const r = await ep.invokeService(MANAGER_ENDPOINT, "define-persona",
        { name, persona: `probe persona ${i}` }, { deadlineMs: 15_000 });
      if (r.reply.ok === true) { callerSaw = "ok"; detail = r.responder.instanceId === IID1 ? "A" : "B"; }
      else {
        callerSaw = "app-error";
        const err = r.reply.error as { code?: string; outcome?: string; details?: Array<{ kind?: string }> } | undefined;
        const marks = (err?.details ?? []).map((d) => d.kind).filter(Boolean);
        if (marks.includes(EP_BIND_REFUSED)) bindRefused++;
        refusedBeforeEffect = marks.includes(EP_BIND_REFUSED) && err?.outcome === "not-executed";
        outcomeStated = err?.outcome !== undefined;
        detail = `${err?.code ?? "?"}|outcome=${err?.outcome ?? "(absent)"}|${marks.join(",") || "(no details)"}`;
      }
    } catch (e) {
      callerSaw = "throw";
      // The marker arrives on THIS path too: a failed re-issue rethrows the ORIGINAL refusal, so
      // reading marks only off `ok:false` replies undercounts the fence to zero on exactly the
      // trials where it fired twice.
      const marks = (e instanceof EpEnvelopeError ? e.details ?? [] : []).map((d) => d.kind).filter(Boolean);
      if (marks.includes(EP_BIND_REFUSED)) bindRefused++;
      refusedBeforeEffect = marks.includes(EP_BIND_REFUSED) && (e as EpEnvelopeError).outcome === "not-executed";
      outcomeStated = e instanceof EpEnvelopeError && e.outcome !== undefined;
      detail = e instanceof EpEnvelopeError
        ? `${e.code}|outcome=${e.outcome ?? "(absent)"}|${marks.join(",") || "(no details)"}`
        : (e as Error).message.slice(0, 60);
    }
    const inRoot1 = existsSync(agentFilePath(root1, name));
    const inRoot2 = existsSync(agentFilePath(root2, name));
    trials.push({ i, name, inRoot1, inRoot2, both: inRoot1 && inRoot2, callerSaw, detail, repairs: recoveriesThisTrial, refusedBeforeEffect, outcomeStated });
  }

  // CONSERVATION, and it replaces "every trial produced an effect somewhere". That older invariant
  // was true only while the split was unfenced: once a responder can refuse before running, a call
  // that splits TWICE legitimately produces no effect at all and says so, and demanding an effect
  // would fail the fixed tip for doing the right thing. What must hold on any correct tip is that
  // no trial goes unaccounted: exactly one effect, or a refusal that states nothing ran.
  const answered = trials.filter((t) => t.inRoot1 || t.inRoot2);
  const accounted = trials.filter((t) => (t.inRoot1 || t.inRoot2) || t.refusedBeforeEffect);
  check("CONSERVATION: every trial is accounted for — an effect, or a refusal stating it did not run",
    accounted.length === N, { accounted: accounted.length, effects: answered.length, N });

  const dupes = trials.filter((t) => t.both);
  const dupeSilent = dupes.filter((t) => t.callerSaw === "ok");

  console.log(`\n2. effects counted at the RESPONDERS (persona files per manager root)`);
  console.log(`     trials:                        ${N}`);
  console.log(`     effect on A only:              ${trials.filter((t) => t.inRoot1 && !t.inRoot2).length}`);
  console.log(`     effect on B only:              ${trials.filter((t) => t.inRoot2 && !t.inRoot1).length}`);
  console.log(`     effect on BOTH (duplicate):    ${dupes.length}`);
  console.log(`     ...of those, caller saw "ok":  ${dupeSilent.length}`);
  console.log(`     caller outcomes: ok=${trials.filter((t) => t.callerSaw === "ok").length} ` +
    `app-error=${trials.filter((t) => t.callerSaw === "app-error").length} ` +
    `throw=${trials.filter((t) => t.callerSaw === "throw").length}`);
  console.log(`     per-trial: ${trials.map((t) => (t.both ? "D" : t.inRoot1 ? "a" : t.inRoot2 ? "b" : "-")).join("")}`);
  console.log(`                (D = duplicate across both instances, a/b = single effect, - = none)`);

  console.log(`     refusals carrying ${EP_BIND_REFUSED}: ${bindRefused}`);
  // WHICH refusal, not just how many: a count of zero cannot distinguish "the fence never fired"
  // from "it fired in a shape this probe does not recognise", and those call for opposite work.
  const byDetail = new Map<string, number>();
  for (const t of trials) if (t.detail !== "A" && t.detail !== "B") byDetail.set(t.detail, (byDetail.get(t.detail) ?? 0) + 1);
  for (const [d, n] of [...byDetail].sort((x, y) => y[1] - x[1])) console.log(`       ${n}x ${d}`);
  const repaired = trials.filter((t) => t.repairs > 0);
  const repairedOk = repaired.filter((t) => t.callerSaw === "ok");
  console.log(`\n3. the repair path, measured on a LIVE contended queue (not a constructed re-seed)`);
  console.log(`     trials where a re-issue was attempted:  ${repaired.length}`);
  console.log(`     ...that HEALED into a success:          ${repairedOk.length}`);
  console.log(`     ...that split AGAIN and surfaced:       ${repaired.length - repairedOk.length}`);
  console.log(`     self-heal rate: ${repaired.length === 0 ? "n/a (no repair attempted)" : `${((repairedOk.length / repaired.length) * 100).toFixed(0)}%`}`);
  console.log(`     total recoveries emitted: ${recoveriesTotal}`);

  console.log(`\n=== FINDING ===`);
  if (dupes.length > 0) {
    console.log(`REGRESSED. ${dupes.length}/${N} trials executed the SAME write on BOTH instances,`);
    console.log(`${dupeSilent.length} of them while telling the caller "ok". A responder is not refusing before`);
    console.log(`the command runs. The count is a FLOOR: a retry landing back on the same instance`);
    console.log(`executes twice and leaves one file, and is not counted here.`);
  } else {
    console.log(`HELD. No trial wrote to both roots in ${N} trials, and ${bindRefused} split(s) were refused`);
    console.log(`before the command ran. The duplicate this probe was written to reproduce does not occur.`);
  }

  // A zero is only evidence if a split actually happened, and the signature differs by tip: on an
  // unfenced tip a split shows as a duplicate or a throw; on a fenced one as a bind-refused refusal
  // or a recovery that healed it invisibly. All four zero means the queue never split and this run
  // grades nothing — which is not the same as the defect being absent.
  const splitSeen = dupes.length + trials.filter((t) => t.callerSaw === "throw").length + bindRefused + recoveriesTotal;
  if (splitSeen === 0) {
    fail++;
    console.log(`  \u2717 FAIL: GRADES NOTHING - no duplicate, no throw, no ${EP_BIND_REFUSED} refusal.`);
    console.log(`     The class queue never split in these ${N} trials, so this run is evidence about`);
    console.log(`     neither the defect nor any remedy. Re-run; do not read it as absence.`);
  }
  check("NO DUPLICATE EFFECT: no caller request executed the same write on both instances",
    dupes.length === 0, { dupes: dupes.length, N });
  check("NO SILENT DUPLICATE: no duplicated write was reported to the caller as success",
    dupeSilent.length === 0, { dupeSilent: dupeSilent.length });
  // The marker without the outcome is what makes two implementations disagree about whether the
  // command ran, so a refusal carrying only one of the pair is a defect even with nothing
  // duplicated. Vacuous when the queue never split — which the grades-nothing guard above forbids.
  const markedButUnstated = trials.filter((t) => t.detail.includes(EP_BIND_REFUSED) && !t.refusedBeforeEffect);
  check("REFUSALS ARE CONCLUSIVE: every fence refusal also states `not-executed`",
    markedButUnstated.length === 0, markedButUnstated.map((t) => t.detail));

  // THE ASSERTION THAT IS SENSITIVE TO THE FENCE ITSELF. Removing the pre-effect refusal does not
  // bring the duplicate back on its own — the caller-side repair still collapses it — so the two
  // checks above pass on a tip whose responder never fences. What returns is this: the split is
  // reported AFTER the command ran, as `failed-precondition` with NO outcome, which §13.3 says a
  // caller must read as `unknown`. The effect landed and the caller is told only that it failed.
  // Measured: with the fence neutered, 15/24 failures arrive this way and zero duplicates do.
  const inconclusive = trials.filter((t) => t.callerSaw !== "ok" && !t.outcomeStated);
  check("NO INCONCLUSIVE FAILURE: every failed call states whether its effect landed",
    inconclusive.length === 0, { inconclusive: inconclusive.length, sample: inconclusive[0]?.detail });

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} finally {
  await ep?.stop().catch(() => {});
  await m1?.stop().catch(() => {});
  await m2?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
