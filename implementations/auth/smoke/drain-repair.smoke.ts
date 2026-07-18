/**
 * #29 HIGH 1 drain-repair confinement smoke: the CLOSED self-commit class, the closed pool-repair
 * subject shape, and the per-repair credentials' broker-enforced exact-coordinate confinement.
 *
 * A. the applier class (assertAppliableCommitKey): derived from the canonical frozen kind
 *    collections + the registered writer metadata — ONLY commit-path kinds at exact arity mint.
 *    Every authority kind (oblig/uid/govern/policy/frontier), the 3-token lifecycle HEAD, every
 *    non-commit-path caller kind, every unregistered kind, and every arity/tail/qualifier
 *    violation refuses BEFORE any credential exists (the confused-deputy closure, fact pin 2).
 * B. the reconciler subject shape (assertPoolRepairSubject): exact 6-token EPW item coordinates
 *    in THIS space only; wildcards, foreign rails, and wrong arity refuse.
 * C. LIVE broker confinement: an applier credential granted commit key A is broker-DENIED on
 *    sibling key B; a reconciler credential granted item X is broker-DENIED on item Y (the JWT
 *    grant is the enforcement, not the validator).
 * D. CAS classification: an applier landing on a moved record reports "another writer" conflict
 *    (the drain re-classifies), never a silent overwrite.
 *
 * Run: pnpm smoke:drain-repair   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createSpaceAuth, ensureAuthorityStores, isReachable, recordsBucket, serverConfig, spacePrefix, createEndpointStreams } from "@cotal-ai/core";
import { openAuthorityClient } from "../src/authority-client.js";
import { assertAppliableCommitKey, assertPoolRepairSubject, drainApplierGrants, drainReconcilerGrants, makeDrainRepairers } from "../src/drain-repair.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const rejects = async (fn: () => Promise<unknown> | unknown): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error)?.message ?? String(e); } };
const quiet = () => {};

const UID = "c".repeat(26);
const GOAL_KEY = `goal.manager.local.worker.${UID}.g00001.spec`;

// ---- A. the closed applier class (broker-free) ----
console.log("A. the closed self-commit class");
{
  check("a commit-path goal spec key at exact arity is ACCEPTED", (await rejects(() => assertAppliableCommitKey(GOAL_KEY))) === "");
  check("a commit-path cp status key at exact arity is ACCEPTED", (await rejects(() => assertAppliableCommitKey("cp.manager.tok1.status"))) === "");
  for (const [what, key] of Object.entries({
    "an obligation row (authority kind)": `oblig.${UID}.manager.local.worker.${UID}.acc001`,
    "a uid reservation (authority kind)": `uid.${UID}`,
    "a govern head (authority kind)": "govern.manager",
    "a policy version (authority kind)": `policy.manager.${"a".repeat(64)}`,
    "a retirement frontier (authority kind)": `frontier.${UID}`,
    "the 3-token lifecycle HEAD (authority arity)": "lifecycle.local.worker",
    "a lifecycle audit detail (writer is the minting manager, not the commit path)": `lifecycle.local.worker.${UID}.spec`,
    "a svc registration (writer is the provisioner)": "svc.manager.inst1.spec",
    "a contracts row (writer is the instance)": "contracts.manager.spec",
    "a lease record (writer is the pool-owner lease command)": `lease.manager.workpool.local.worker.${UID}.acc001.spec`,
    "an unregistered kind": "taks.manager.spec",
    "a too-shallow goal coordinate": "goal.manager.spec",
    "a too-deep goal coordinate": `goal.manager.local.worker.${UID}.g00001.extra.spec`,
    "a goal key without the split tail": `goal.manager.local.worker.${UID}.g00001.body`,
    "a goal key with an invalid uid qualifier": "goal.manager.local.worker.NOT-A-UID.g00001.spec",
    "an empty key": "",
  })) {
    const msg = await rejects(() => assertAppliableCommitKey(key));
    check(`${what} REFUSES before any credential mints`, msg.length > 0 && msg.includes("SPEC 13."), { key, msg });
  }
}

// ---- B. the closed reconciler subject shape (broker-free) ----
console.log("B. the closed pool-repair subject");
{
  const space = "drsp";
  const ok = `${spacePrefix(space)}.epw.manager.workpool.local.worker.${UID}.acc001`;
  check("an exact 6-token EPW item subject in this space is ACCEPTED", (await rejects(() => assertPoolRepairSubject(space, ok))) === "");
  for (const [what, subject] of Object.entries({
    "a foreign space's EPW rail": `${spacePrefix("other")}.epw.manager.workpool.local.worker.${UID}.acc001`,
    "a non-EPW rail": `${spacePrefix(space)}.epf.manager.dec.local.worker.${UID}.acc001`,
    "a wildcard coordinate": `${spacePrefix(space)}.epw.manager.workpool.local.worker.${UID}.*`,
    "a full-tail wildcard": `${spacePrefix(space)}.epw.manager.>`,
    "a too-shallow coordinate": `${spacePrefix(space)}.epw.manager.workpool.local.worker.${UID}`,
    "a too-deep coordinate": `${spacePrefix(space)}.epw.manager.workpool.local.worker.${UID}.acc001.extra`,
  })) {
    const msg = await rejects(() => assertPoolRepairSubject(space, subject));
    check(`${what} REFUSES before any credential mints`, msg.length > 0 && msg.includes("no reconciler credential mints"), { subject, msg });
  }
}

// ---- C/D. live broker confinement + CAS classification ----
console.log("C. live exact-coordinate confinement over the real JWT broker");
const space = `drrp-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), "cotal-drrp-"));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  // Stores via a wide harness client (the provisioner's job in production).
  const wide = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `harness:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const wideJsm = await jetstreamManager(wide.nc);
  await ensureAuthorityStores(wideJsm, new Kvm(wide.nc), space);
  await createEndpointStreams(wideJsm, new Kvm(wide.nc), space);

  const keyB = `goal.manager.local.worker.${UID}.g00002.spec`;
  const applier = await openAuthorityClient({
    server: SERVERS, space, dataAccount, label: `probe:apply`,
    grants: (id) => drainApplierGrants(space, GOAL_KEY, id), log: quiet,
  });
  try {
    const js = jetstream(applier.nc);
    const okPub = await rejects(() => js.publish(`$KV.${recordsBucket(space)}.${GOAL_KEY}`, new TextEncoder().encode("{\"v\":1}"), { timeout: 3000 }));
    check("the applier credential CAN write its ONE granted commit key", okPub === "", okPub);
    const denied = await rejects(() => js.publish(`$KV.${recordsBucket(space)}.${keyB}`, new TextEncoder().encode("{\"v\":1}"), { timeout: 1500 }));
    check("the applier credential is broker-DENIED on a sibling commit key (exact-coordinate grant)", denied.length > 0, denied);
  } finally {
    await applier.close();
  }

  const itemX = `${spacePrefix(space)}.epw.manager.workpool.local.worker.${UID}.acc001`;
  const itemY = `${spacePrefix(space)}.epw.manager.workpool.local.worker.${UID}.acc002`;
  const recon = await openAuthorityClient({
    server: SERVERS, space, dataAccount, label: `probe:reenqueue`,
    grants: (id) => drainReconcilerGrants(space, itemX, id), log: quiet,
  });
  try {
    const js = jetstream(recon.nc);
    const okPub = await rejects(() => js.publish(itemX, new TextEncoder().encode("{\"item\":1}"), { timeout: 3000 }));
    check("the reconciler credential CAN create its ONE granted EPW item", okPub === "", okPub);
    const denied = await rejects(() => js.publish(itemY, new TextEncoder().encode("{\"item\":2}"), { timeout: 1500 }));
    check("the reconciler credential is broker-DENIED on a sibling item (exact-coordinate grant)", denied.length > 0, denied);
  } finally {
    await recon.close();
  }

  console.log("D. CAS classification through the real per-op executor");
  const repairers = makeDrainRepairers({ server: SERVERS, space, dataAccount, log: quiet });
  const apply = repairers.applyCommitFor("op".padEnd(26, "1"));
  // GOAL_KEY already has revision 1 (written by the probe above): a base-0 create must CLASSIFY
  // as "another writer", never overwrite.
  const cas = await rejects(() => apply(GOAL_KEY, new TextEncoder().encode("{\"v\":2}"), 0));
  check("an applier landing on a MOVED record reports the another-writer conflict (the drain re-classifies)",
    cas.includes("another writer moved"), cas);
  // And the executor itself refuses an out-of-class key before minting anything.
  const outOfClass = await rejects(() => apply(`oblig.${UID}.manager.local.worker.${UID}.acc001`, new TextEncoder().encode("{}"), 0));
  check("the real executor refuses an out-of-class commit key BEFORE any mint (the confused-deputy closure, live)",
    outOfClass.includes("no applier credential mints"), outOfClass);
  const reenq = repairers.reconcilePoolRouteFor("op".padEnd(26, "1"));
  const foreign = await rejects(() => reenq({ kind: "pool", subject: `${spacePrefix("other")}.epw.manager.workpool.local.worker.${UID}.acc001`, bytes: new TextEncoder().encode("{}"), workExpiry: 1 }));
  check("the real reconciler refuses a foreign-space repair BEFORE any mint", foreign.includes("no reconciler credential mints"), foreign);

  await wide.close();
} finally {
  srv.kill("SIGTERM"); // exact PID — never pkill nats-server
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nDRAIN-REPAIR SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nDRAIN-REPAIR SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
