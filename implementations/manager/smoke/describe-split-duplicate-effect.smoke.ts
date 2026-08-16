/**
 * DESCRIBE/INVOKE SPLIT — DUPLICATE EFFECT ON THE CLASS QUEUE (live repro).
 *
 * The mechanism, all of it in core:
 *  1. `invokeService` resolves an endpoint once and CACHES the resolved service, binding the
 *     describe winner's instance (`endpoint.ts` resolve cache).
 *  2. An unpinned invoke routes to the class `one` queue, which picks its own winner — the describe
 *     and the invoke are two independent trips through the same anycast, so in a multi-instance
 *     space they land on different instances on an ordinary, correct request.
 *  3. `describeBound` is handed to `epCall` as its `currentEpoch` hook, and `epCall` calls it
 *     AFTER the reply lands. So when instance B answers a handle resolved against A, B HAS ALREADY
 *     EXECUTED THE COMMAND when the `failed-precondition` is raised.
 *  4. `invokeService` catches exactly that code, drops the cache, re-resolves and re-invokes WITH
 *     THE SAME ARGS. The refusal is never surfaced; the caller sees the second attempt's outcome.
 *
 * For a read this is waste. For a WRITE it is a duplicate effect the caller cannot see, and the
 * manager already registers writes on this rail (`spawn`, `despawn`, `purge`, `launch`, the resume
 * family, and the one used here).
 *
 * WHY `define-persona` AND NOT `spawn`: a duplicated `spawn` starts a second real agent process.
 * `define-persona` is the most benign write on this surface — it writes one small file and nothing
 * else, a repeat is not destructive, and it rides the SAME `invokeService` path, the same class
 * queue and the same post-reply currency hook. It is admitted by the same `spawn` capability
 * (`SPAWN_SERVICE_COMMANDS`).
 *
 * THE EFFECT IS COUNTED AT THE RESPONDER, NOT AT THE CALLER — the whole defect is that the caller's
 * view is wrong, so the caller cannot be the instrument. Each manager writes personas into its OWN
 * workspace root, so one persona name present in BOTH roots is direct proof the command executed on
 * BOTH instances.
 *
 * This UNDERCOUNTS deliberately: a retry that lands on the same instance executes twice and leaves
 * one file. Every number here is therefore a floor, which is the safe direction for a defect claim.
 *
 * Run: pnpm smoke:describe-split-effect   (needs nats-server on PATH; boots its own broker)
 */
import { randomUUID } from "node:crypto";
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

// The responder fence's marker, as a LITERAL and deliberately not imported: this harness must run
// unchanged on tips that predate the fence (where the constant does not exist) so the two can be
// compared by the same instrument. An import here would make the probe refuse to load on exactly
// the tip it is the baseline for.
const EP_BIND_REFUSED = "ai.cotal.ep.bind-refused";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

// FIRST ACTION: scrub inherited live-broker pointers, then verify the scrub held. This probe
// performs WRITES; it must never be able to reach a real mesh.
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
  // The fence's repair path emits this when it re-resolves and re-issues a bind-refused call. On a
  // tip that predates the fence the event simply never fires, which keeps one instrument on both.
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
  };
  const trials: Trial[] = [];
  let bindRefused = 0;

  console.log(`\n1. ${N} describe+invoke trials of the write \`define-persona\`, two live managers`);
  for (let i = 0; i < N; i++) {
    const name = `epsplit-${i}`;
    let callerSaw: Trial["callerSaw"] = "ok";
    let detail = "";
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
        detail = `${err?.code ?? "?"}|outcome=${err?.outcome ?? "(absent)"}|${marks.join(",") || "(no details)"}`;
      }
    } catch (e) {
      callerSaw = "throw";
      detail = e instanceof EpEnvelopeError ? e.code : (e as Error).message.slice(0, 40);
    }
    const inRoot1 = existsSync(agentFilePath(root1, name));
    const inRoot2 = existsSync(agentFilePath(root2, name));
    trials.push({ i, name, inRoot1, inRoot2, both: inRoot1 && inRoot2, callerSaw, detail, repairs: recoveriesThisTrial });
  }

  const answered = trials.filter((t) => t.inRoot1 || t.inRoot2);
  check("every trial produced an effect somewhere (the sample is valid; no silently lost trials)",
    answered.length === N, { answered: answered.length, N });

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
    console.log(`REPRODUCED. ${dupes.length}/${N} trials executed the SAME write on BOTH instances.`);
    console.log(`${dupeSilent.length} of those returned success to the caller, which therefore has no`);
    console.log(`way to know the write ran twice. The effect count is a FLOOR: a retry landing on the`);
    console.log(`same instance executes twice and leaves one file, and is not counted here.`);
  } else {
    console.log(`NOT REPRODUCED in ${N} trials — no trial wrote to both roots.`);
    console.log(`This does NOT establish that the mechanism cannot fire. Distinguish the two cases`);
    console.log(`from the per-trial line above: a healthy mix of a/b means the queue really did split`);
    console.log(`and the retry still never crossed instances; an all-a or all-b line means this run`);
    console.log(`never produced a split at all, and the harness did not reach the condition.`);
  }

  // The claim under test is that a duplicate CAN occur and is invisible. Assert exactly that, and
  // nothing about a fix: no remedy is adopted, so there is no post-fix state to gate here.
  // A ZERO IS ONLY EVIDENCE IF A SPLIT ACTUALLY HAPPENED. The three observable signatures of a
  // split are tip-dependent and this probe must grade both tips with one rule: a duplicate (no
  // fence, retry crossed instances), a throw (no fence, the second attempt also mismatched), or a
  // `bind-refused` refusal (fence present, refused before the handler). If ALL THREE are zero the
  // queue never split during this run and it grades nothing - which is NOT the same as the defect
  // being absent, and must not be reported as if it were.
  //
  // Keyed on the union rather than on the fence marker alone, because the marker cannot exist on a
  // pre-fence tip: gating on it would label every clean baseline run "unfalsifiable".
  const splitSeen = dupes.length + trials.filter((t) => t.callerSaw === "throw").length + bindRefused;
  if (splitSeen === 0) {
    fail++;
    console.log(`  \u2717 FAIL: GRADES NOTHING - no duplicate, no throw, no ${EP_BIND_REFUSED} refusal.`);
    console.log(`     The class queue never split in these ${N} trials, so this run is evidence about`);
    console.log(`     neither the defect nor any remedy. Re-run; do not read it as absence.`);
  }
  check("DEFECT PRESENT: at least one write executed on both instances for one caller request",
    dupes.length > 0, { dupes: dupes.length, N });
  check("DEFECT IS SILENT: at least one duplicated write returned success to the caller",
    dupeSilent.length > 0, { dupeSilent: dupeSilent.length });

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} finally {
  await ep?.stop().catch(() => {});
  await m1?.stop().catch(() => {});
  await m2?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
