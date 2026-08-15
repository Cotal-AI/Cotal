/**
 * THE SPLIT-RETRY GUARD, AND THE EDGE OF ITS ALLOWLIST (SPEC §13.2).
 *
 * `invokeService`'s describe-bound currency check is a POST-REPLY check — `endpoint-verbs.ts`:
 * "after the reply lands, the answering incarnation's epoch is checked". When a DIFFERENT live
 * instance wins the class queue and replies, the command has ALREADY EXECUTED by the time the
 * refusal is raised. Re-invoking then runs it a second time.
 *
 * The guard withholds that retry for `GOAL_BEARING_COMMANDS` — `["spawn", "launch"]` — matched by
 * command NAME. This suite grades BOTH sides of that boundary under ONE forced split:
 *
 *   - EVERY goal-bearing command SURFACES, having executed exactly once (the guard bites); and
 *   - a mutating command OUTSIDE the allowlist is still retried, and executes TWICE.
 *
 * EVERY member, not a representative. Grading one name cannot see a guard that lost the others:
 * narrowing the production test from `.includes(command)` to `command === GOAL_BEARING_COMMANDS[0]`
 * leaves `launch` auto-retried, and a suite that only invokes `spawn` stays green through it — an
 * executed survivor, not a hypothesis. So the loop below is driven by the exported constant, and
 * adding a member to the allowlist adds a graded member here on the same commit.
 *
 * THE SECOND CELL RECORDS A KNOWN GAP, NOT AN APPROVAL. It asserts today's behaviour so the gap is
 * visible and measured rather than argued about, and so it fails loudly the day the general fix
 * lands. The guard's own commit says why the gap is there and is not hiding it: a command carries no
 * idempotency declaration and every manager command shares `class: "ephemeral"`, so nothing in the
 * resolved surface distinguishes a read from a mutation, and the allowlist is "a CONSERVATIVE
 * APPROXIMATION of 'unsafe to repeat'". `despawn` and `define-persona` mutate and are still retried,
 * held safe by convergence rather than by anything the wire says. **When a contract-level
 * effect/safety annotation lands, BOTH `KNOWN GAP` checks below must be inverted, not deleted** —
 * the one asserting two executions, and the one asserting the caller is told nothing. The annotation
 * has to reach `append` for that to happen: the target is one execution plus a surfaced refusal.
 *
 * WHY THE BOUNDARY NEEDS ITS OWN CELL. The guard's suite grades a read against a create. That pair
 * cannot see this one: a read has nothing to duplicate, so it says nothing about a command that
 * mutates and is not on the list. This fixture serves its OWN endpoint, so it can offer two commands
 * that differ ONLY in whether their name is on the allowlist — same contracts, same class, same
 * split, same instant — and the outcomes diverge on that alone.
 *
 * WHAT THE GUARD COSTS, AND WHAT THIS SUITE DOES NOT GRADE. Surfacing beats duplicating, but the
 * caller does not merely get an error instead of a second execution — on the `follow:true` path it
 * loses the goal it just started. `epCall` parses the acceptance reply BEFORE the currency check
 * throws, so `submitAndFollowGoal` never reaches its goalId extraction and its `finally`
 * unsubscribes. The responder's goal id is the request id, generated privately inside the request
 * builder, and the unbound-responder refusal does not carry it. So the work runs, in the background,
 * with no id and no terminal follow on the caller's side. These cells invoke without `follow:true`
 * and therefore do NOT cover that path: it is stated here because it is the part a reader would
 * otherwise assume the guard had handled.
 *
 * WHY THE COUNT IS TAKEN AT THE HANDLER. It cannot be taken on the wire: `MintOpts.endpointServe`
 * mints only queue-qualified class subscribes — "no plain class-rail subscribe exists on any
 * credential" — and a queue-qualified observer would COMPETE for requests rather than watch them.
 * Counting the effect is also the stronger claim: not that a request was published twice, but that
 * the write ran twice. Both commands here mutate a ledger the fixture reads back.
 *
 * THE SPLIT IS NOT SIMULATED. Instance A serves alone while the resolve cache is primed, then the
 * replacement comes up and A retires — a rolling replacement, which is what a restart or supersede
 * looks like from the caller's side. `endpoint-invoke.ts` calls this an "ordinary split" in its own
 * refusal text; the fixture removes the coin toss, not the mechanism.
 *
 * Run: pnpm smoke:invoke-retry-duplicate   (needs nats-server on PATH; part of smoke:ci)
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, CotalEndpoint, openRecordsBucket, registerServiceInstance, authorizeServeGrant,
  createEndpointStreams, serveEndpoint, compileContract, contractDigest, contractStoreContext,
  publishContractArtifact, contractArtifactCanonicalBytes, mintLifecycleUid,
  EpEnvelopeError, respondedButUnbound, GOAL_BEARING_COMMANDS,
  type ServiceSpec, type ServiceNameAuthority, type EpCommandDef, type EpIssuanceBarrier,
  type EpAttributedReply,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "invdup";
const ENDPOINT = "ledger";
const IID_A = "a".repeat(26);
const IID_B = "b".repeat(26);
const OWNER = "u_op";
// The two commands differ in ONE property: whether the name is on the allowlist. Read from the
// exported constant rather than spelled here, so a change to the set breaks this suite loudly
// instead of leaving it quietly grading the wrong pair.
const GUARDED = [...GOAL_BEARING_COMMANDS]; // every member — withheld from the retry
const UNGUARDED = "append";                 // mutating, not on the list — still retried
assert.ok(!GOAL_BEARING_COMMANDS.includes(UNGUARDED as (typeof GOAL_BEARING_COMMANDS)[number]),
  `${UNGUARDED} must NOT be goal-bearing or this suite grades nothing`);
assert.ok(GUARDED.length > 0, "GOAL_BEARING_COMMANDS is empty — this suite would grade nothing");

// A `CotalEndpoint` reads connection settings from the ambient environment, and this fixture stops
// serving instances. Inheriting a real mesh's `COTAL_*` vars would aim that at someone else's space.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes("broker.cotal.ai")) throw new Error(`refusing to run: ${k} points at a live broker`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

// ── the §13.7 contracts, and the cluster document that registers their digests ──
const IN_SCHEMA = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"], additionalProperties: false };
const OUT_SCHEMA = { type: "object", properties: { which: { type: "string" }, runs: { type: "number" } }, required: ["which", "runs"], additionalProperties: false };
const inC = compileContract({ root: IN_SCHEMA });
const outC = compileContract({ root: OUT_SCHEMA });
const cmdDecl = (name: string) => ({
  name, class: "ephemeral", targeted: false, capability: "ledger.write",
  inputDigest: inC.closureDigest, outputDigest: outC.closureDigest,
});
const DOC = {
  urn: "ai.cotal.invdup", revision: 1, attributes: [], events: [],
  // Identical declarations. Anything that diverges below is the allowlist and nothing else.
  commands: [UNGUARDED, ...GUARDED].map(cmdDecl),
};
const DOC_ROOT = contractDigest(DOC);
const DOC_MANIFEST = { v: 1 as const, root: DOC_ROOT, members: [] as string[] };
const DOC_CLOSURE = contractDigest(DOC_MANIFEST);
// The registrant AUTHORS the document, so it verifies against its own copy; the CALLER fetches the
// same bytes from the store by digest. Both must exist or the resolve proves nothing.
const local = new Map<string, unknown>([[DOC_ROOT, DOC], [DOC_CLOSURE, DOC_MANIFEST]]);
const readClusterArtifact = (d: string) => local.get(d);

const authority: ServiceNameAuthority = {
  authorize: (name, owner) => ({ authorized: name === ENDPOINT && owner === OWNER, revision: 0 }),
};
// A faithful freeze→(spec write)→reopen issuance barrier. The fence internals are proven in
// endpoint-serve-auth.smoke.ts; here it only has to be honest about state transitions.
const gates = new Map<string, { state: "open" | "frozen"; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number; revision: number }>();
function barrierFor(instanceId: string): EpIssuanceBarrier {
  if (!gates.has(instanceId)) gates.set(instanceId, { state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, revision: 1 });
  const g = gates.get(instanceId)!;
  return {
    observe: () => ({ space: SPACE, endpoint: ENDPOINT, lifecycleUid: instanceId, principal: `${OWNER}.svc`, ...g }),
    freeze: (rev) => { if (g.state !== "open" || g.revision !== rev) return null; g.state = "frozen"; g.revision++; return g.revision; },
    enumerate: () => [],
    revoke: () => {},
    evict: () => true,
    reopen: (token, succ) => {
      if (g.state !== "frozen" || g.revision !== token) return false;
      g.state = "open"; g.generation = succ.generation; g.processEpoch = succ.processEpoch;
      g.registrationRevision = succ.registrationRevision; g.nameAuthorityRevision = succ.nameAuthorityRevision; g.revision++;
      return true;
    },
  };
}

// ── the LEDGER both commands append to: the whole measurement ──
const ledger: Array<{ which: string; command: string; tag: string }> = [];
const since = (n: number) => ledger.slice(n);

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-invdup-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
process.on("exit", () => { try { broker.kill("SIGKILL"); } catch { /* already gone */ } rmSync(sd, { recursive: true, force: true }); });

const guardedCallers = new Map<string, CotalEndpoint>();
let epUngarded: CotalEndpoint | undefined;
let srvA: { stop: () => Promise<void> } | undefined;
let srvB: { stop: () => Promise<void> } | undefined;

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("fixture broker did not come up — refusing to report on a server that never started");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });

  // Publish every artifact a caller must fetch-verify-compile: each schema root with its
  // single-member closure manifest, then the cluster document with its manifest.
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  const storeCtx = await contractStoreContext(nc, SPACE);
  for (const value of [
    IN_SCHEMA, { v: 1, root: contractDigest(IN_SCHEMA), members: [] },
    OUT_SCHEMA, { v: 1, root: contractDigest(OUT_SCHEMA), members: [] },
    DOC, DOC_MANIFEST,
  ]) await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));

  const kv = await openRecordsBucket(nc, SPACE, { create: true });
  const spec: ServiceSpec = { endpoint: ENDPOINT, owner: OWNER, clusterDigests: [DOC_CLOSURE], protocol: { v: 1 } };
  const serveOne = async (instanceId: string, which: string) => {
    await registerServiceInstance(kv, {
      space: SPACE, spec, instanceId, registrant: { owner: OWNER }, authority,
      barrier: barrierFor(instanceId), readClusterArtifact,
    });
    const grant = await authorizeServeGrant(kv, {
      space: SPACE, endpoint: ENDPOINT, instanceId, epoch: gates.get(instanceId)!.processEpoch,
      holder: { owner: OWNER }, authority, readClusterArtifact,
      readProcessEpoch: async () => gates.get(instanceId)!.processEpoch,
    });
    // ONE handler body behind every name. Any difference in outcome is the allowlist, by construction.
    const defs: EpCommandDef[] = [UNGUARDED, ...GUARDED].map((command) => ({
      command,
      contract: { input: inC, output: outC },
      handler: (ctx) => {
        ledger.push({ which, command, tag: String((ctx.request.args as { tag?: unknown } | undefined)?.tag ?? "") });
        return { which, runs: ledger.length };
      },
    }));
    return serveEndpoint(nc, SPACE, grant, defs, { public: true });
  };

  // Instance A serves ALONE while the cache is primed. With both live, describe and the invoke are
  // independent trips through one queue and the PRIMING call could itself split — the fixture would
  // then be testing the defect by accident and flaking when it didn't.
  srvA = await serveOne(IID_A, "A");

  // TWO PURE CALLERS, one per side, so that neither side depends on the CODE UNDER TEST to stage the
  // other. `resolvedServices` is per-endpoint-instance, and whether a refusal evicts it is precisely
  // what the guard varies: the goal-bearing path throws BEFORE the eviction and keeps the stale
  // resolve, while the fallback path evicts and re-resolves. Staging both sides through one caller
  // would therefore make the second side's setup a function of the first side's outcome. That is not
  // hypothetical — on an earlier blanket-rethrow variant of this code the eviction left the second
  // command facing no split at all, and its cell passed vacuously rather than going red.
  // A caller invokes and nothing else, so it binds no lifecycle durables and publishes no presence;
  // `lifecycleUid` is still required, because `invokeService` pins the caller triple into every
  // request subject.
  const newCaller = async (name: string) => {
    const e = new CotalEndpoint({
      space: SPACE, servers: `nats://127.0.0.1:${PORT}`, lifecycleUid: mintLifecycleUid(),
      consume: false, registerPresence: false, card: { name, role: "agent" },
    });
    await e.start();
    return e;
  };
  // One caller PER guarded command, for the same reason there are two sides: a guarded refusal
  // retains the stale resolve, so a second guarded call through the same caller would be staged by
  // the outcome of the first rather than by the fixture. Independent callers keep each member's
  // split its own fact.
  for (const command of GUARDED) guardedCallers.set(command, await newCaller(`caller-${command}`));
  epUngarded = await newCaller("caller-unguarded");

  const allCallers = [...guardedCallers.values(), epUngarded];
  for (const e of allCallers) await e.invokeService(ENDPOINT, UNGUARDED, { tag: "prime" });
  check("every caller holds a resolve cache primed against A, which executed each write once",
    ledger.length === allCallers.length && ledger.every((l) => l.which === "A"), { ledger });

  // Bring the replacement up, then retire EXACTLY the instance the cache describes. From here every
  // invoke is answered by an incarnation the cached resolve does not name.
  srvB = await serveOne(IID_B, "B");
  await srvA.stop();
  srvA = undefined;
  await wait(300);

  // ── side 1: the guard BITES on EVERY goal-bearing command ──
  const firstGuarded = ledger.length;
  for (const command of GUARDED) {
    const before = ledger.length;
    let guardedErr: unknown;
    let guardedReply: EpAttributedReply | undefined;
    try { guardedReply = await guardedCallers.get(command)!.invokeService(ENDPOINT, command, { tag: command }); }
    catch (e) { guardedErr = e; }
    const runs = ledger.length - before;
    const shape = { command, runs, tail: since(before), err: guardedErr === undefined ? null : `${(guardedErr as EpEnvelopeError).code}`, reply: guardedReply?.reply };

    check(`a goal-bearing command (${command}) SURFACES the split instead of being retried`,
      guardedErr instanceof EpEnvelopeError && guardedErr.code === "failed-precondition", shape);
    check(`${command} executed EXACTLY ONCE — the responder ran it, and the guard did not run it again`,
      runs === 1 && since(before)[0]?.which === "B", shape);
    check(`${command}'s refusal carries the unbound-responder marker the guard keys on`,
      guardedErr instanceof EpEnvelopeError && respondedButUnbound(guardedErr), shape);
  }

  // ── side 2: THE DOCUMENTED GAP — a mutating command off the allowlist is still retried ──
  const beforeUnguarded = ledger.length;
  let unguardedErr: unknown;
  let unguardedReply: EpAttributedReply | undefined;
  try { unguardedReply = await epUngarded.invokeService(ENDPOINT, UNGUARDED, { tag: "gap" }); }
  catch (e) { unguardedErr = e; }
  const unguardedRuns = ledger.length - beforeUnguarded;
  const unguardedShape = { runs: unguardedRuns, tail: since(beforeUnguarded), err: unguardedErr === undefined ? null : String(unguardedErr), reply: unguardedReply?.reply };

  check(`KNOWN GAP: a mutating command off the allowlist (${UNGUARDED}) is retried and executes TWICE`,
    unguardedRuns === 2 && since(beforeUnguarded).every((e) => e.tag === "gap"), unguardedShape);
  check(`KNOWN GAP: ${UNGUARDED} returns SUCCESS, so the caller never learns it ran twice`,
    unguardedReply?.reply.ok === true && unguardedErr === undefined, unguardedShape);
  check("every side met the SAME split — every execution after the retirement landed on B",
    since(firstGuarded).every((e) => e.which === "B"), { tail: since(firstGuarded) });
} finally {
  for (const e of guardedCallers.values()) await e.stop().catch(() => { /* already down */ });
  await epUngarded?.stop().catch(() => { /* already down */ });
  await srvA?.stop().catch(() => { /* already down */ });
  await srvB?.stop().catch(() => { /* already down */ });
}

console.log(`\n${fail === 0 ? "INVOKE-RETRY-DUPLICATE SMOKE OK ✅" : "INVOKE-RETRY-DUPLICATE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
assert.equal(fail, 0, `${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
