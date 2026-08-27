/**
 * #878 repro: boot crash-resume derives retirement owed-ness from the gate alone, so a crash
 * between the gate terminal and the head terminal during retirement wedges the alias
 * permanently (SPEC 13.1 cross-object invariant).
 *
 * THE CRASH WINDOW IS STAGED, NOT INJECTED, because the barrier's last two steps are adjacent
 * with no injectable seam (`retireGate` then `completeHeadRetirementWithinBarrier`, both sealed
 * registry calls): the barrier RUNS for real through intent create, gate freeze, head
 * `active -> retiring`, and family containment, and FAILS at verified eviction (fail-closed),
 * leaving the durable intent, a frozen gate, and a `retiring` head. The two writes that would
 * follow a successful eviction are then replayed with the barrier's OWN primitives (the
 * frontier record via `createRecordEntry`, exactly as step 6/7 reads each stream's last_seq and
 * records it, and the gate terminal via `retireGate`, step 8), and the head terminal (step 9) is
 * NEVER run. That durable state is byte-identical to what a real crash between steps 8 and 9
 * leaves: intent present, gate `retired` by the op, head `retiring` under the op, frontier
 * recorded.
 *
 * THE INTERMEDIATE-STATE ASSERTION (before any second boot): gate NOT frozen (terminal
 * `retired` by the op), head still `retiring` under the op, intent + frontier durable. Without
 * it a mis-staged window would false-pass as "cannot reproduce".
 *
 * The suite owns its broker, its port, its state dir, and its store. It never touches
 * `~/.cotal`, the live fleet, or any ambient mesh.
 *
 * Run: pnpm smoke:retirement-wedge:auth   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  createEndpointStreams,
  createRecordEntry,
  createSpaceAuth,
  ensureAuthorityStores,
  epfStreamName,
  epwStreamName,
  isReachable,
  mintLifecycleUid,
  recordAtomicKey,
  RETIREMENT_FRONTIER,
  serverConfig,
  type EvictionResult,
} from "@cotal-ai/core";
import { deriveOwnerToken, openAuthAuthorityPlane } from "../src/index.js";
import { openLifecycleRegistry, observeGate, readLifecycleHeadForOperation, registryStores, retireGate, activateLifecycleAtUid } from "../src/lifecycle-registry.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { stageIntentKey, type EvictPrincipal } from "../src/credential-ledger.js";
import { runAgentRetirementBarrier, type RetirementDeps } from "../src/retirement-barrier.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const rejects = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error)?.message ?? String(e); } };

const space = `rwedge-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const ACTOR = "worker1";
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
const okEvictor = (calls: string[]): EvictPrincipal => async (principal) => {
  calls.push(principal);
  return { principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult;
};
/** The fail-closed seam: eviction cannot verify, so the barrier aborts AFTER freezing the gate
 *  and retiring the head, exactly the mid-crash state #878 is about, but with the gate still
 *  FROZEN, which the CURRENT predicate resumes. The staged gate terminal below is what turns it
 *  into the unreachable crash window. */
const failEvictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 1, verifiedGone: false, scanComplete: true, note: "probe: eviction refused" });
const unreached = (what: string) => async (): Promise<never> => { throw new Error(`${what} must not be reached while staging the crash window`); };

let writer: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // The broad permissive mint connection is the smoke suites' established seeding profile
  // (barrier-plane.smoke.ts uses the same): the plane's real mint writer holds a narrower
  // grant set that excludes endpoint-stream provisioning, which belongs to space setup.
  writer = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:auth-mint:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const jsm = await jetstreamManager(writer.nc);
  await ensureAuthorityStores(jsm, new Kvm(writer.nc), space);
  // The endpoint streams (EPF/EPW) must exist for the frontier step's STREAM.INFO read; a real
  // deployment creates them at space setup.
  await createEndpointStreams(jsm, new Kvm(writer.nc), space);
  const wreg = await openLifecycleRegistry(writer.nc, space);
  const { recordsKv, authKv } = registryStores(wreg);

  // A lifecycle to retire: the root-credential ensure activates the alias at the reserved uid
  // (reserve -> gate frozen -> head CAS active -> reopen LAST) and mints its root row.
  const uid = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: ACTOR, lifecycleUid: uid, managerInstance: "smoke" });
  const active = await readLifecycleHeadForOperation(wreg, OWNER, ACTOR);
  check("setup: the alias is active at the reserved uid with an open gate",
    active?.mapping.state === "active" && active.mapping.lifecycleUid === uid
    && (await observeGate(wreg, uid))?.row.state === "open", active?.mapping);

  // ---- STAGE THE CRASH WINDOW ---------------------------------------------------------------
  // The barrier runs for real (intent, freeze, head -> retiring, containment) and aborts at
  // verified eviction. The gate is FROZEN and the head RETIRING, both under the op.
  const op = mintLifecycleUid();
  const frontierKey = recordAtomicKey(RETIREMENT_FRONTIER, [uid]);
  const deps: RetirementDeps = {
    evictPrincipal: failEvictor,
    drainTargetObligations: unreached("drain"),
    openCleaner: unreached("openCleaner"), retireCleanerCredential: unreached("retireCleanerCredential"),
    openExecutor: unreached("openExecutor"), retireExecutorCredential: unreached("retireExecutorCredential"),
    now: Date.now,
  };
  const wedgeMsg = await rejects(() => runAgentRetirementBarrier(wreg, {
    owner: OWNER, actor: ACTOR, lifecycleUid: uid, opId: op,
    frontierStreams: [epfStreamName(space), epwStreamName(space)],
  }, deps));
  check("staging: the barrier aborted at verified eviction (fail-closed)", wedgeMsg.length > 0, wedgeMsg.slice(0, 120));

  // Replay the two writes a successful eviction would have preceded, with the barrier's OWN
  // primitives, and STOP before the head terminal. That stop IS the crash.
  const streams: Record<string, number> = {};
  for (const s of [epfStreamName(space), epwStreamName(space)]) streams[s] = (await jsm.streams.info(s)).state.last_seq;
  await createRecordEntry(recordsKv, frontierKey, { lifecycleUid: uid, opId: op, streams });
  const gateFrozen = await observeGate(wreg, uid);
  if (gateFrozen === undefined || gateFrozen.row.state !== "frozen" || gateFrozen.row.op?.opId !== op)
    throw new Error(`cannot stage the gate terminal: expected the gate frozen by ${op}, got ${JSON.stringify(gateFrozen)}`);
  await retireGate(wreg, { lifecycleUid: uid, revision: gateFrozen.revision, opId: op }); // step 8
  // step 9 (head retiring -> retired) NEVER RUNS. The crash lands here.

  // ---- THE INTERMEDIATE-STATE ASSERTION (before any second boot) ----------------------------
  {
    const gate = await observeGate(wreg, uid);
    check("THE CRASH WINDOW: the gate is terminal `retired` by THIS op (NOT frozen)",
      gate?.row.state === "retired" && gate.row.op?.opId === op, gate?.row);
    const head = await readLifecycleHeadForOperation(wreg, OWNER, ACTOR);
    check("THE CRASH WINDOW: the head is still `retiring` under THIS op",
      head?.mapping.state === "retiring" && head.mapping.op?.opId === op, head?.mapping);
    const intent = await authKv.get(stageIntentKey(op));
    check("THE CRASH WINDOW: the durable intent survives (only the head terminal drops it)",
      intent !== null && intent.operation === "PUT", intent?.operation);
    const fr = await recordsKv.get(frontierKey);
    check("THE CRASH WINDOW: the frontier record precedes the gate terminal (as a crash after step 8 leaves)",
      fr !== null && fr.operation === "PUT" && (JSON.parse(new TextDecoder().decode(fr.value)) as { opId: string }).opId === op, fr?.operation);
  }

  // THE WEDGE CONSEQUENCE IS REAL: while the head is `retiring`, a same-name respawn is refused
  // (SPEC 13.1: a retiring alias is NOT replaceable). A state you read is not a defect; the
  // refusal you trigger is.
  {
    const respawnMsg = await rejects(() => activateLifecycleAtUid(wreg, { owner: OWNER, actor: ACTOR, lifecycleUid: mintLifecycleUid(), managerInstance: "smoke" }));
    check("REPRO: the wedge REFUSES a same-name respawn (a retiring alias is not replaceable, SPEC 13.1)",
      respawnMsg.includes("retiring") && respawnMsg.includes("not replaceable"), respawnMsg);
    const headStill = await readLifecycleHeadForOperation(wreg, OWNER, ACTOR);
    check("REPRO: the refused respawn left the head untouched (still retiring)", headStill?.mapping.state === "retiring", headStill?.mapping);
  }

  // ---- THE SECOND BOOT: resumeOpenOperations runs inside openAuthAuthorityPlane ----
  // FIXED expectation: owed-ness is the cross-object invariant, so this boot RESUMES the intent
  // (the barrier's gate-retired branch finishes the head terminal) and the alias becomes
  // replaceable. On the gate-only predicate this boot SKIPS the intent (gate not frozen) and the
  // alias stays wedged. That is the defect, and the checks below go red with the refusal in
  // view.
  const bootLines: string[] = [];
  const bootEvicted: string[] = [];
  const plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: (l) => bootLines.push(l), probeEvictor: okEvictor(bootEvicted) });
  await plane.close();

  const headAfter = await readLifecycleHeadForOperation(wreg, OWNER, ACTOR);
  check("THE FIX: the second boot RESUMED the intent and completed the head terminal (retired)",
    headAfter?.mapping.state === "retired", headAfter?.mapping);
  check("THE FIX: the resume was attempted and logged (the skip is no longer silent)",
    bootLines.some((l) => l.includes(`resumed retirement ${op}`)), bootLines.filter((l) => l.includes(op)));
  {
    const gate = await observeGate(wreg, uid);
    check("THE FIX: the gate stays terminal `retired` by the op (a retirement never reopens)",
      gate?.row.state === "retired" && gate.row.op?.opId === op, gate?.row);
    const respawnMsg = await rejects(() => activateLifecycleAtUid(wreg, { owner: OWNER, actor: ACTOR, lifecycleUid: mintLifecycleUid(), managerInstance: "smoke" }));
    check("THE FIX: the alias is replaceable now (the respawn that the wedge refused now SUCCEEDS)",
      respawnMsg === "", respawnMsg.slice(0, 200));
  }

  // ---- THE COMPLETED CELL IS STILL SKIPPED: a third boot must NOT re-run a completed op ----
  {
    const lines3: string[] = [];
    const plane3 = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: (l) => lines3.push(l), probeEvictor: okEvictor([]) });
    await plane3.close();
    check("the COMPLETED cell stays skipped: a boot over gate retired + head retired resumes nothing",
      !lines3.some((l) => l.includes(`resuming retirement ${op}`) || l.includes(`resumed retirement ${op}`)), lines3.filter((l) => l.includes(op)));
  }

  console.log(`\nRETIREMENT-WEDGE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await writer?.close().catch(() => {});
  srv.kill();
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
