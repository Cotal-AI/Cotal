/**
 * Q4 OPEN-MESH PROBE (Lane A, HIGH-1/HIGH-2 rework) — determine BY EXECUTION what fences a
 * deposed OPEN-MESH manager from committing a goal terminal once the epoch-scoped result
 * subject is removed.
 *
 * Runs the REAL open-mesh registration path the manager runs (manager.ts withOpenServeConnection
 * + registerManagerService): ensureAuthorityStores -> provisionEndpointGateOpen ->
 * registerServiceInstance over endpointRegistrationBarrier WITH NO EVICTOR (exactly the open-mesh
 * construction), twice — a first registration and a restart re-registration.
 *
 * Questions it answers:
 *  Q4a does the §13.1 issuance gate (the processEpoch mapping) EXIST on an open mesh at all?
 *  Q4b does a restart advance processEpoch there, and does it do so having revoked/evicted nothing?
 *  Q4c can a BARE (credential-less) connection READ that gate — i.e. is the own-gate currency belt
 *      implementable on open mesh, or is it structurally unavailable?
 *  Q4d with the flat `…result` subject, is a stale-epoch committer's terminal visible to a
 *      current-epoch reader (the fence the epoch token was providing on the read side)?
 *
 * Run: pnpm tsx <this file>   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createEndpointStreams, openRecordsBucket, ensureAuthorityStores,
  provisionEndpointGateOpen, serveIssuanceGateKv, endpointRegistrationBarrier,
  registerServiceInstance, epAuthBucket, recordsBucket, mintLifecycleUid,
  actionContext, bindGoal, createGoal, commitGoalResult, readGoalResult, goalResultSubject,
  goalRefOf, readLastFact, epfStreamName, compileContract, contractDigest, VOID_SCHEMA,
  type EpCaller, type GoalRef, type ParsedEpRequest, type ServiceNameAuthority,
} from "../src/index.js";

/** The manager's endpoint name and a minimal one-command cluster document in its shape — inlined
 *  so the probe stays hermetic in core (the manager package loads core from built `dist/`). */
const MANAGER_ENDPOINT = "manager";
function managerClusterArtifacts() {
  const io = compileContract({ root: VOID_SCHEMA as unknown as Record<string, unknown> });
  const document = {
    urn: "ai.cotal.manager", revision: 1, attributes: [], events: [],
    commands: [{
      name: "status", class: "ephemeral" as const, targeted: false, capability: "manager.read",
      inputDigest: io.closureDigest, outputDigest: io.closureDigest,
    }],
  };
  const rootDigest = contractDigest(document);
  const manifest = { v: 1 as const, root: rootDigest, members: [] as string[] };
  return { document, rootDigest, manifest, closureDigest: contractDigest(manifest) };
}

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log("  ✓", n); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "q4open";
const OWNER = "local";                       // DEV_OWNER on an open/static mesh
const IID = "i".repeat(26);                  // the manager's persisted logical instanceId
const PRINCIPAL = `${OWNER}.${"s".repeat(26)}`; // the persisted serve principal
const UID = "u".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const reqOf = (goalId: string): ParsedEpRequest =>
  ({ plane: "request", route: "one", endpoint: MANAGER_ENDPOINT, command: "spawn", caller, id: goalId } as unknown as ParsedEpRequest);
const ref = (goalId: string): GoalRef => goalRefOf(reqOf(goalId), goalId);

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-q4open-"));
// NO -auth, NO operator: a genuinely OPEN broker, the mode the probe is about.
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");

  const artifacts = managerClusterArtifacts();
  const store = new Map<string, unknown>([
    [artifacts.rootDigest, artifacts.document],
    [artifacts.closureDigest, artifacts.manifest],
  ]);
  const readClusterArtifact = (digest: string): unknown => store.get(digest);
  const authority: ServiceNameAuthority = {
    authorize: (name, owner) => ({ authorized: name === MANAGER_ENDPOINT && owner === OWNER, revision: 0 }),
  };
  const spec = { endpoint: MANAGER_ENDPOINT, owner: OWNER, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 as const } };

  // ── the open-mesh serve ceremony, exactly as withOpenServeConnection runs it ──
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  await ensureAuthorityStores(jsm, kvm, SPACE);
  await createEndpointStreams(jsm, kvm, SPACE);
  const authKv = await kvm.open(epAuthBucket(SPACE));
  const recordsKv = await kvm.open(recordsBucket(SPACE));
  await openRecordsBucket(nc, SPACE);

  const gate = () => serveIssuanceGateKv(authKv, SPACE, { endpoint: MANAGER_ENDPOINT, instanceId: IID });
  // NO evictor — the open-mesh construction (manager.ts spreads `evict` only when `auth`).
  const barrier = () => endpointRegistrationBarrier(authKv, SPACE, {
    endpoint: MANAGER_ENDPOINT, instanceId: IID, opId: mintLifecycleUid(),
  });

  console.log("\n── Q4a: does the §13.1 gate exist on an OPEN mesh? ──");
  c("no gate before provisioning", (await gate().observe()) === null);
  await provisionEndpointGateOpen(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: IID, principal: PRINCIPAL });
  const born = await gate().observe();
  c("provisionEndpointGateOpen created the gate on an open mesh", born !== null, born);
  c("it is born open@gen0, processEpoch 0", born?.state === "open" && born?.generation === 0 && born?.processEpoch === 0, born);

  console.log("\n── Q4b: does a RESTART advance processEpoch, with nothing revoked/evicted? ──");
  const first = await registerServiceInstance(recordsKv, {
    space: SPACE, spec, instanceId: IID, registrant: { owner: OWNER }, authority, barrier: barrier(), readClusterArtifact,
  });
  const afterFirst = await gate().observe();
  c("first registration keeps processEpoch 0", afterFirst?.processEpoch === 0, afterFirst);

  // The restart: the SAME persisted instanceId re-registers. This is the takeover path.
  const second = await registerServiceInstance(recordsKv, {
    space: SPACE, spec, instanceId: IID, registrant: { owner: OWNER }, authority, barrier: barrier(), readClusterArtifact,
  });
  const afterSecond = await gate().observe();
  c("re-registration ADVANCED processEpoch 0 -> 1", afterSecond?.processEpoch === 1, afterSecond);
  c("the gate reopened (never left frozen)", afterSecond?.state === "open", afterSecond);
  // THE PROOF that the revoke/evict loop was vacuous: the barrier's evict default is FAIL-CLOSED
  // (`() => false`), and PHASE 2 throws on any holder it cannot verify-evict. A re-registration that
  // SUCCEEDS with no evictor injected can only mean the enumerated family was EMPTY.
  c("it succeeded with NO evictor => the credential family was EMPTY => nothing was revoked or evicted",
    typeof second.registrationRevision === "number" && second.registrationRevision > first.registrationRevision,
    { first: first.registrationRevision, second: second.registrationRevision });

  console.log("\n── Q4c: can a BARE connection read that gate (is the own-gate belt implementable)? ──");
  const bare = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  try {
    const bareKv = await new Kvm(bare).open(epAuthBucket(SPACE));
    const observed = await serveIssuanceGateKv(bareKv, SPACE, { endpoint: MANAGER_ENDPOINT, instanceId: IID }).observe();
    c("a credential-less connection READS the gate's current processEpoch", observed?.processEpoch === 1, observed);
  } finally { await bare.drain().catch(() => bare.close()); }

  console.log("\n── Q4d: on the FLAT result subject, is a stale committer's terminal visible? ──");
  const ctx = await actionContext(nc, SPACE);           // no resolveExecutorEpoch: the post-rework shape
  const g = ref("g-openmesh");
  const FP = "sha256:" + "a".repeat(64);
  await bindGoal(ctx, g, FP);
  await createGoal(ctx, g, {
    fingerprint: FP, command: "spawn",
    caller: { id: `${caller.owner}.${caller.actor}`, lifecycleUid: caller.uid },
    requestId: "g-openmesh", sourceSeq: 1, acceptedAt: 1_000_000, readinessDeadlineMs: 30_000,
  });
  // The "deposed" writer commits first, under its stale epoch. With the flat subject there is no
  // epoch in the address at all, so its terminal lands on THE one create-only subject.
  const stale = await commitGoalResult(ctx, { ref: g, now: 1_000_001, cause: "complete", state: "failed", data: { by: "deposed-incarnation" } });
  c("the deposed writer's terminal WON the create-only CAS", stale.won === true);
  // The successor reads the same one subject — there is no epoch to resolve.
  const surfaced = await readGoalResult(ctx, g);
  c("a CURRENT-epoch reader SURFACES the deposed writer's terminal (no read-side epoch fence)",
    surfaced?.state === "failed" && (surfaced?.data as { by?: string })?.by === "deposed-incarnation", surfaced);
  const successor = await commitGoalResult(ctx, { ref: g, now: 1_000_002, cause: "complete", state: "succeeded", data: { by: "successor" } });
  c("the successor's later terminal LOSES (first-terminal-fact-wins is now global, not per-epoch)",
    successor.won === false && successor.fact.state === "failed", successor.fact);
  c("exactly ONE result subject exists for the goal",
    (await readLastFact(jsm, epfStreamName(SPACE), goalResultSubject(SPACE, g))) !== undefined);

  await nc.drain().catch(() => nc.close());
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nq4-openmesh-probe: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
