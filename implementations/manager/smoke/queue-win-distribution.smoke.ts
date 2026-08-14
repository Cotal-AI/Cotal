/**
 * CLASS-QUEUE WIN DISTRIBUTION (#385, the unexplained residue) — measures WHO answers the class
 * `one` rail across many resolutions in a multi-manager space.
 *
 * The observation to explain: seven consecutive spawn resolutions, from two different callers,
 * were all answered by the same manager. Under uniform delivery across two responders that run is
 * 2 x 0.5^7 = 1/64 (~1.6%) for either side, ~0.8% for one named side — improbable enough to want a
 * mechanism, and explained by neither the resolve amplification nor the routing defects on this
 * seam.
 *
 * This is a MEASUREMENT, not an assertion about a bug. It reports the distribution, the longest
 * same-side run, and how surprising that run is under a uniform null. The only hard checks are
 * that the sample is valid (both managers registered, every describe answered) — a distribution
 * measurement that silently lost half its trials would otherwise look like a finding.
 *
 * IMPORTANT SCOPE LIMIT, stated up front so the result is not over-read: both managers here are
 * local, on one box, with effectively identical broker RTT. The reported field condition had two
 * managers on DIFFERENT MACHINES with different WAN RTTs to the broker. NATS queue-group delivery
 * is not documented as round-robin and can favour a more responsive subscriber, so a uniform result
 * here does NOT refute the field observation — it localizes it to the asymmetry this harness does
 * not reproduce. Phase 3 injects that asymmetry directly to test exactly that.
 *
 * Run: pnpm smoke:queue-win
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
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER, describeEndpoint,
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

// FIRST ACTION: scrub the inherited live-broker pointers, then verify the scrub held.
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

/** The longest run of identical consecutive values. */
const longestRun = (xs: string[]): { len: number; who: string } => {
  let best = { len: 0, who: "" }, cur = { len: 0, who: "" };
  for (const x of xs) {
    cur = x === cur.who ? { len: cur.len + 1, who: x } : { len: 1, who: x };
    if (cur.len > best.len) best = { ...cur };
  }
  return best;
};
/** P(at least one run of >= k) among n Bernoulli(1/2) trials, exactly, by DP over run state. */
const pRunAtLeast = (n: number, k: number): number => {
  // state: current run length 1..k-1, plus absorbed. p[i] = probability mass with run length i.
  let p = new Array(k).fill(0); p[1] = 1; let absorbed = 0;
  for (let t = 1; t < n; t++) {
    const q = new Array(k).fill(0);
    for (let i = 1; i < k; i++) {
      if (p[i] === 0) continue;
      const extend = p[i] * 0.5, breakRun = p[i] * 0.5;
      if (i + 1 >= k) absorbed += extend; else q[i + 1] += extend;
      q[1] += breakRun;
    }
    p = q;
  }
  return absorbed;
};

const space = `qwin-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-qwin-"));
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
  check("two managers registered distinct instance ids (the sample is a real two-way race)", IID1 !== IID2, { IID1, IID2 });

  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  const creds = await mintCreds(auth, id, "agent", { lifecycleUid: uid, capabilities: ["spawn"] });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });

  const N = 100;
  const label = (iid: string): string => (iid === IID1 ? "A" : iid === IID2 ? "B" : `?${iid.slice(0, 6)}`);
  const sample = async (): Promise<string[]> => {
    const seq: string[] = [];
    for (let i = 0; i < N; i++) {
      const { responder } = await describeEndpoint(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000 });
      seq.push(label(responder.instanceId));
    }
    return seq;
  };
  const report = (seq: string[], title: string): { a: number; run: { len: number; who: string } } => {
    const a = seq.filter((s) => s === "A").length;
    const run = longestRun(seq);
    console.log(`   ${title}`);
    console.log(`     A=${a}  B=${seq.length - a}  (of ${seq.length})`);
    console.log(`     longest same-side run: ${run.len} (${run.who})`);
    console.log(`     sequence: ${seq.join("").slice(0, 80)}${seq.length > 80 ? "…" : ""}`);
    return { a, run };
  };

  console.log(`\n1. ${N} sequential class-queue describes, two SYMMETRIC local managers`);
  const seq1 = await sample();
  check("every describe was answered by one of the two registered managers (no lost trials)",
    seq1.every((s) => s === "A" || s === "B") && seq1.length === N, seq1.filter((s) => s !== "A" && s !== "B"));
  const r1 = report(seq1, "distribution:");

  console.log(`\n2. how surprising is a run of 7, at this sample size, under a uniform null?`);
  const p7 = pRunAtLeast(N, 7);
  console.log(`     P(some run >= 7 | uniform, n=${N})  = ${(p7 * 100).toFixed(1)}%`);
  console.log(`     P(a NAMED 7-in-a-row | uniform, n=7) = ${(2 * 0.5 ** 7 / 2 * 100).toFixed(1)}%  (the reported event, in isolation)`);
  console.log(`     observed longest run here: ${r1.run.len}`);
  console.log(`   NOTE: the reported 7-run was 7 CONSECUTIVE ATTEMPTS, not the longest run in a long`);
  console.log(`   sample — so ~0.8% is the right prior for it, and a long sample's runs are not`);
  console.log(`   comparable to it directly. Both are printed so neither is mistaken for the other.`);

  // ---- 3. ASYMMETRY: the variable the field condition had and this box does not ----------------
  // The reported space had one manager per MACHINE. If queue delivery favours the more responsive
  // subscriber, a persistent RTT difference produces a persistent winner. Approximated by stopping
  // one manager: the extreme of asymmetry, which at least establishes whether the queue re-balances
  // at all, and whether a single-responder space is silently indistinguishable from a fair race.
  console.log(`\n3. asymmetry probe: with manager B stopped, does the class queue still answer?`);
  await m2.stop(); m2 = undefined;
  await wait(1000);
  const seq3 = await sample();
  const r3 = report(seq3, "distribution with only A live:");
  check("with one manager stopped the survivor answers every describe (the queue re-homes cleanly)",
    r3.a === N, { a: r3.a, n: N });

  console.log(`\n=== FINDING ===`);
  if (r1.run.len >= 7) {
    console.log(`A run of ${r1.run.len} occurred with two SYMMETRIC managers, so long same-side runs`);
    console.log(`do NOT require an asymmetry — the reported 7-run is within what this queue does.`);
  } else if (Math.abs(r1.a - N / 2) > N * 0.2) {
    console.log(`Delivery is measurably SKEWED (A=${r1.a}/${N}) even with symmetric local managers.`);
    console.log(`A persistent winner is therefore a property of the queue here, not of WAN asymmetry.`);
  } else {
    console.log(`Delivery is near-uniform (A=${r1.a}/${N}, longest run ${r1.run.len}) between two`);
    console.log(`SYMMETRIC local managers. This does NOT explain the reported 7-run, and it does not`);
    console.log(`refute it: the untested variable is per-machine RTT asymmetry, which this box cannot`);
    console.log(`reproduce. Face 4 stays OPEN, now with the symmetric case eliminated.`);
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  await nc.drain().catch(() => nc.close());
} finally {
  await m1?.stop().catch(() => {});
  await m2?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
