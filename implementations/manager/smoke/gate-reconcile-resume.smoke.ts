/**
 * #1064: a crashed gate repair resumes from durable holder-verification progress.
 *
 * RED-FIRST CONTROL: exact origin/main 229f69b054cf781aabdbf4f08ec471482ec201b1 called holder1
 * again on retry after holder2's verification was interrupted. This maintained smoke stages the same
 * residue through the shipped gate APIs and requires holder1 to be skipped only from a cursor bound
 * to the exact registration op, frozen-gate KV revision, and sorted holder set.
 *
 * It also proves the freeze-holder liveness guard runs on every attempt, each completed holder is
 * persisted before the next verification, a mismatched later freeze restarts from zero, failed
 * cleanup cannot authorize that later freeze, and the executor grant names one exact repair key.
 *
 * Run: pnpm smoke:gate-reconcile-resume
 */
import type { KV } from "@nats-io/kv";
import {
  DEV_OWNER,
  endpointRegistrationBarrier,
  epAuthBucket,
  epgateKey,
  eprepairKey,
  loadEndpointRepairCursor,
  mintLifecycleUid,
  parseEndpointGate,
  permissionsFor,
  principalKey,
  provisionEndpointGateOpen,
  repairCursorMatches,
  serveIssuanceGateKv,
} from "@cotal-ai/core";
import { GateReconcileRefused, reconcileEndpointGate } from "../src/reconcile-gate.js";

const casLoss = (message = "wrong last sequence") => Object.assign(new Error(message), { code: 10071 });
const enc = new TextEncoder();
const dec = new TextDecoder();
type Stored = { value: Uint8Array; revision: number; operation: "PUT" | "DEL" };

function memKv(): KV & {
  dump: (key: string) => Stored | undefined;
  writes: Array<{ key: string; value: string; revision: number }>;
  failDelete: number;
} {
  const store = new Map<string, Stored>();
  const writes: Array<{ key: string; value: string; revision: number }> = [];
  let sequence = 0;
  const self = {
    failDelete: 0,
    get: async (key: string) => store.get(key),
    create: async (key: string, value: Uint8Array) => {
      const current = store.get(key);
      if (current?.operation === "PUT") throw casLoss(`create ${key}`);
      const revision = ++sequence;
      store.set(key, { value, revision, operation: "PUT" });
      writes.push({ key, value: dec.decode(value), revision });
      return revision;
    },
    put: async (key: string, value: Uint8Array, opts?: { previousSeq?: number }) => {
      const current = store.get(key);
      if (opts?.previousSeq !== undefined && (current?.revision ?? 0) !== opts.previousSeq)
        throw casLoss(`put ${key}`);
      const revision = ++sequence;
      store.set(key, { value, revision, operation: "PUT" });
      writes.push({ key, value: dec.decode(value), revision });
      return revision;
    },
    update: async (key: string, value: Uint8Array, expected: number) => {
      const current = store.get(key);
      if (!current || current.revision !== expected) throw casLoss(`update ${key}`);
      const revision = ++sequence;
      store.set(key, { value, revision, operation: "PUT" });
      writes.push({ key, value: dec.decode(value), revision });
      return revision;
    },
    delete: async (key: string, opts?: { previousSeq?: number }) => {
      if (self.failDelete > 0) {
        self.failDelete--;
        throw new Error(`simulated cleanup drop for ${key}`);
      }
      const current = store.get(key);
      if (opts?.previousSeq !== undefined && current?.revision !== opts.previousSeq)
        throw casLoss(`delete ${key}`);
      store.set(key, { value: enc.encode(""), revision: ++sequence, operation: "DEL" });
    },
    keys: async (filter?: string) => {
      const prefix = typeof filter === "string" ? filter.replace(/>$/, "") : "";
      const keys = [...store.entries()]
        .filter(([key, value]) => value.operation === "PUT" && (!prefix || key.startsWith(prefix)))
        .map(([key]) => key);
      return (async function* () { for (const key of keys) yield key; })();
    },
    dump: (key: string) => store.get(key),
    writes,
  };
  return self as unknown as ReturnType<typeof memKv>;
}

let passed = 0;
let failed = 0;
const check = (name: string, condition: unknown, extra?: unknown) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const SPACE = "resume1064";
const ENDPOINT = "manager";
const freezeHolder = principalKey(DEV_OWNER, "resumezzfreeze").key;
const holder1 = principalKey(DEV_OWNER, "resumeaholder1").key;
const holder2 = principalKey(DEV_OWNER, "resumebholder2").key;
const holder3 = principalKey(DEV_OWNER, "resumecHolder3").key;
const expectedHolders = [holder1, holder2, holder3, freezeHolder].sort();

async function stage(kv: KV, instanceId: string, holderPrincipal: string): Promise<void> {
  await serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId }).stage({
    credentialId: mintLifecycleUid(),
    credentialKey: "",
    holderPrincipal,
    endpoint: ENDPOINT,
    lifecycleUid: instanceId,
    sourceChain: ["root"],
    state: "active",
    exp: Math.floor(Date.now() / 1000) + 3600,
    generation: 0,
    processEpoch: 0,
    registrationRevision: 0,
    nameAuthorityRevision: 0,
  });
}

async function freeze(kv: KV, instanceId: string, opId: string): Promise<number> {
  const observed = await serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId }).observe();
  if (!observed) throw new Error("gate missing before freeze");
  const token = await endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId, opId }).freeze(observed.revision);
  if (token === null) throw new Error("freeze lost its CAS");
  return token;
}

function gateState(kv: ReturnType<typeof memKv>, instanceId: string): string {
  const key = epgateKey(ENDPOINT, instanceId);
  const entry = kv.dump(key);
  return entry?.operation === "PUT" ? parseEndpointGate(entry.value, key).state : "missing";
}

async function attempt(
  kv: KV,
  instanceId: string,
  probe: (principal: string) => Promise<{ state: "gone"; detail: string }>,
  evict: (principal: string) => Promise<boolean>,
) {
  try {
    return { ok: true as const, report: await reconcileEndpointGate({
      kv, space: SPACE, endpoint: ENDPOINT, instanceId, probeHolder: probe, evict, log: () => {},
    }) };
  } catch (error) {
    if (error instanceof GateReconcileRefused)
      return { ok: false as const, condition: error.condition, message: error.message };
    throw error;
  }
}

console.log("A. interruption persists holder1 before holder2 is attempted");
{
  const kv = memKv();
  const instanceId = mintLifecycleUid();
  const opId = mintLifecycleUid();
  await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId, principal: freezeHolder });
  await stage(kv, instanceId, holder1);
  await stage(kv, instanceId, holder2);
  await stage(kv, instanceId, holder3);
  const freezeToken = await freeze(kv, instanceId, opId);

  let probes = 0;
  const firstCalls: string[] = [];
  const first = await attempt(
    kv,
    instanceId,
    async (principal) => { probes++; return { state: "gone", detail: `affirmed ${principal}` }; },
    async (principal) => {
      firstCalls.push(principal);
      if (principal === holder2) throw new Error("simulated link drop during holder2 verification");
      return true;
    },
  );
  check("the interrupted attempt is a named eviction-unverified refusal", !first.ok && first.condition === "eviction-unverified", first);
  check("holder1 completed before holder2 interrupted the pass", JSON.stringify(firstCalls) === JSON.stringify([holder1, holder2]), firstCalls);
  check("the gate remains frozen after the interruption", gateState(kv, instanceId) === "frozen", gateState(kv, instanceId));
  check("the refusal reports durable completed and remaining counts", !first.ok && /1 completed, 3 remaining/.test(first.message), first);

  const stored = await loadEndpointRepairCursor(kv, ENDPOINT, instanceId);
  check("holder1 was persisted before holder2 was attempted", stored?.cursor.freezeToken === freezeToken && stored.cursor.opId === opId &&
    JSON.stringify(stored.cursor.holders) === JSON.stringify(expectedHolders) && JSON.stringify(stored.cursor.verified) === JSON.stringify([holder1]), stored);

  const retryCalls: string[] = [];
  const retry = await attempt(
    kv,
    instanceId,
    async (principal) => { probes++; return { state: "gone", detail: `re-affirmed ${principal}` }; },
    async (principal) => { retryCalls.push(principal); return true; },
  );
  check("the freeze-holder liveness probe ran on both attempts", probes === 2, probes);
  check("retry skips only durable holder1 and verifies every remaining holder", JSON.stringify(retryCalls) === JSON.stringify([holder2, holder3, freezeHolder]), retryCalls);
  check("retry reports one completed before, three completed now, and zero remaining", retry.ok &&
    JSON.stringify(retry.report.holdersVerifiedBeforeAttempt) === JSON.stringify([holder1]) &&
    JSON.stringify(retry.report.holdersVerifiedThisAttempt) === JSON.stringify([holder2, holder3, freezeHolder]) &&
    retry.report.holdersRemaining.length === 0, retry);
  check("the gate reopens only after all current holders verify", retry.ok && gateState(kv, instanceId) === "open", retry);
  check("successful cleanup leaves no live repair cursor", retry.ok && retry.report.repairCursorCleanup === "deleted" &&
    (await loadEndpointRepairCursor(kv, ENDPOINT, instanceId)) === null, kv.dump(eprepairKey(ENDPOINT, instanceId)));
}

console.log("B. failed cleanup cannot authorize a later freeze");
{
  const kv = memKv();
  const instanceId = mintLifecycleUid();
  await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId, principal: freezeHolder });
  await stage(kv, instanceId, holder1);
  await stage(kv, instanceId, holder2);
  const firstOp = mintLifecycleUid();
  const firstToken = await freeze(kv, instanceId, firstOp);
  kv.failDelete = 1;
  const firstCalls: string[] = [];
  const first = await attempt(kv, instanceId, async () => ({ state: "gone", detail: "first freeze holder gone" }), async (p) => { firstCalls.push(p); return true; });
  const retained = await loadEndpointRepairCursor(kv, ENDPOINT, instanceId);
  check("the gate still reopens when post-reopen cursor cleanup fails", first.ok && first.report.repairCursorCleanup === "retained" && gateState(kv, instanceId) === "open", first);
  check("failed cleanup retains a cursor bound to the old freeze only", retained?.cursor.freezeToken === firstToken && retained.cursor.opId === firstOp &&
    retained.cursor.verified.length === retained.cursor.holders.length, retained);

  const secondOp = mintLifecycleUid();
  const secondToken = await freeze(kv, instanceId, secondOp);
  let probes = 0;
  const secondCalls: string[] = [];
  const second = await attempt(kv, instanceId, async () => { probes++; return { state: "gone", detail: "later freeze holder gone" }; }, async (p) => { secondCalls.push(p); return true; });
  check("the later freeze has a distinct observed gate revision", secondToken !== firstToken, { firstToken, secondToken });
  check("the later freeze runs liveness and restarts verification from zero", probes === 1 && second.ok &&
    second.report.holdersVerifiedBeforeAttempt.length === 0 && JSON.stringify(secondCalls) === JSON.stringify([holder1, holder2, freezeHolder]), { probes, secondCalls, second });
  check("a retained old cursor cannot authorize the later reopen", second.ok && second.report.holdersVerifiedThisAttempt.length === 3 && second.report.holdersRemaining.length === 0, second);
}

console.log("C. cursor binding and executor authority are exact");
{
  const cursor = { v: 1 as const, opId: mintLifecycleUid(), freezeToken: 10, holders: expectedHolders, verified: [holder1] };
  check("the same op, freeze revision, and sorted holder set match", repairCursorMatches(cursor, { opId: cursor.opId, freezeToken: 10, holders: [...expectedHolders].reverse() }));
  check("a foreign op does not match", !repairCursorMatches(cursor, { opId: mintLifecycleUid(), freezeToken: 10, holders: expectedHolders }));
  check("a foreign freeze revision does not match", !repairCursorMatches(cursor, { opId: cursor.opId, freezeToken: 11, holders: expectedHolders }));
  check("a changed holder set does not match", !repairCursorMatches(cursor, { opId: cursor.opId, freezeToken: 10, holders: expectedHolders.slice(1) }));

  const instanceId = mintLifecycleUid();
  const sibling = mintLifecycleUid();
  const permissions = permissionsFor(
    "endpoint-serve-executor",
    SPACE,
    { owner: DEV_OWNER, actor: "repair_exec", connId: "repairconn0123456789", lifecycleUid: mintLifecycleUid() },
    { endpointServeExecutor: { endpoint: ENDPOINT, instanceId } },
  );
  const publish = ((permissions.pub as { allow?: string[] } | undefined)?.allow ?? []);
  const exact = `$KV.${epAuthBucket(SPACE)}.${eprepairKey(ENDPOINT, instanceId)}`;
  const foreign = `$KV.${epAuthBucket(SPACE)}.${eprepairKey(ENDPOINT, sibling)}`;
  check("the executor can write exactly its one repair cursor key", publish.includes(exact), publish);
  check("the executor has no wildcard or sibling repair-key grant", !publish.includes(foreign) && !publish.some((row: string) => row.includes("eprepair") && row.includes(">")), publish);
}

const EXPECTED = 21;
check(`every cell ran (${EXPECTED} before the sentinel)`, passed + failed === EXPECTED, { passed, failed });
console.log(`\nGATE-RECONCILE RESUME SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
if (failed) process.exitCode = 1;
