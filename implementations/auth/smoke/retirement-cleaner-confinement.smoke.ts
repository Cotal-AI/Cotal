/**
 * The per-op RETIREMENT CLEANER credential confinement smoke (#29 piece 1). Proves the production
 * `makeRetirementCleaners` seams over a LIVE broker: the cleaner is a per-op, principal-tagged,
 * exact-pool-scoped connection — CONNZ-evictable, able to reach its OWN pool + settlement rows, and
 * broker-DENIED everything else. distsys vote (2): a DISTINCT principal per op so an evict never
 * collateral-kills a concurrent op's cleaner.
 *
 * Denial probes ride bounded `nc.request` (a permission-denied JetStream publish gets NO reply, so
 * an unbounded manager call would hang): an ALLOWED API subject replies fast (even a JS error reply
 * resolves the request); a DENIED one is dropped at publish and times out.
 *
 * Run: pnpm smoke:retirement-cleaner:auth   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  createSpaceAuth, createEndpointStreams, isReachable, mintLifecycleUid, serverConfig,
  epwStreamName, epfStreamName, poolDurable, poolConsumerConfig, assertValidOwnerToken,
  retirementCleanerGrants,
} from "@cotal-ai/core";
import { makeRetirementCleaners } from "../src/retirement-cleaner.js";
import { openAuthorityClient, barrierExecutorSettlementGrants } from "../src/authority-client.js";
import type { NatsConnection } from "@nats-io/transport-node";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ALLOWED = the API subject replies within the budget (a JS error reply still resolves); DENIED =
 *  the publish is permission-blocked so no reply ever comes and the request times out. */
const reaches = async (nc: NatsConnection, subject: string, body?: Uint8Array): Promise<"allowed" | "denied"> => {
  try { await nc.request(subject, body, { timeout: 1500 }); return "allowed"; }
  catch { return "denied"; }
};

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `rclean-${randomUUID().slice(0, 8)}`;
const EP = "jobsrv", EP2 = "mgrjob", POOL_A = "pa", POOL_B = "pb";
const enc = new TextEncoder();
const tmp = mkdtempSync(join(tmpdir(), "cotal-rclean-"));
const auth = await createSpaceAuth(SPACE);
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // A privileged seed over the data account (allow-all) to lay down the endpoint streams + pre-create
  // the pool durables the cleaner will bind (the provisioner's job in production).
  const god = await openAuthorityClient({ server: SERVERS, space: SPACE, dataAccount, label: `seed:${SPACE}`, grants: () => ({ publish: [">"], subscribe: [">"] }), log: quiet });
  const gjsm = await jetstreamManager(god.nc);
  await createEndpointStreams(gjsm, new Kvm(god.nc), SPACE);
  for (const [ep, pool] of [[EP, POOL_A], [EP, POOL_B], [EP2, POOL_A]] as const)
    await gjsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, ep, pool, { ackWaitMs: 700 }));

  const cleaners = makeRetirementCleaners({ server: SERVERS, space: SPACE, dataAccount, log: quiet });

  // ---- A. per-op principal shape + distinctness (distsys vote 2) ----
  const op1 = mintLifecycleUid(), op2 = mintLifecycleUid();
  const bind1 = await cleaners.openCleaner({ opId: op1, endpoint: EP, pools: [POOL_A] });
  const bind2 = await cleaners.openCleaner({ opId: op2, endpoint: EP, pools: [POOL_A] });
  c("the cleaner principal is a CONNZ-attributable local.epcln_<hash> (owner.actor, evictable)",
    /^local\.epcln_[0-9a-f]{16}$/.test(bind1.principal), bind1.principal);
  c("the actor token is a single valid owner token (no '-', bounded)",
    (() => { try { assertValidOwnerToken(bind1.principal.split(".")[1]); return true; } catch { return false; } })());
  c("DISTINCT principal per op (an evict of one op's cleaner cannot collateral-kill another's)",
    bind1.principal !== bind2.principal, { p1: bind1.principal, p2: bind2.principal });
  c("a DOUBLE-OPEN of a LIVE op's cleaner THROWS (a silent overwrite would leak the first connection)",
    await cleaners.openCleaner({ opId: op1, endpoint: EP, pools: [POOL_A] }).then(() => false, () => true));
  // ATOMIC acquisition (freelance a559d9c HIGH): two CONCURRENT opens of the SAME op race the
  // reservation, not a check-then-connect gap — exactly one wins, the other throws, and NO second
  // connection is leaked (the synchronous "opening" reservation refuses the loser before it connects).
  {
    const op3 = mintLifecycleUid();
    const settled = await Promise.allSettled([
      cleaners.openCleaner({ opId: op3, endpoint: EP, pools: [POOL_A] }),
      cleaners.openCleaner({ opId: op3, endpoint: EP, pools: [POOL_A] }),
    ]);
    const wins = settled.filter((r) => r.status === "fulfilled");
    c("two CONCURRENT same-op opens: exactly ONE wins, the other throws (synchronous reservation, no leaked loser)",
      wins.length === 1 && settled.filter((r) => r.status === "rejected").length === 1, settled.map((r) => r.status));
    if (wins[0]?.status === "fulfilled") await cleaners.retireCleanerCredential(wins[0].value);
    // The reservation was released on the loser's path: the same op re-opens cleanly afterward.
    const reopen = await cleaners.openCleaner({ opId: op3, endpoint: EP, pools: [POOL_A] });
    c("after the race + retire, the same op re-opens (the loser released its reservation, no poisoned map entry)", reopen.principal.length > 0);
    await cleaners.retireCleanerCredential(reopen);
  }
  await cleaners.retireCleanerCredential(bind1);
  const bind1b = await cleaners.openCleaner({ opId: op1, endpoint: EP, pools: [POOL_A] });
  c("the SAME opId re-derives the same principal after retire (a crash-resume)", bind1b.principal === bind1.principal);
  await cleaners.retireCleanerCredential(bind2);
  await cleaners.retireCleanerCredential(bind1b);

  // ---- B/C. reach + confinement via a directly-opened cleaner connection (bounded probes) ----
  const clean = await openAuthorityClient({
    server: SERVERS, space: SPACE, dataAccount, label: `cotal:ep-cleaner:${SPACE}:probe`,
    principal: { owner: "local", actor: "epcln_probe000000000" },
    grants: (connId) => {
      const cl = retirementCleanerGrants(SPACE, EP, [POOL_A], connId);
      const se = barrierExecutorSettlementGrants(SPACE, EP, [POOL_A]);
      return { publish: [...cl.publish, ...se.publish], subscribe: cl.subscribe };
    },
    log: quiet,
  });
  const jsapi = (s: string) => `$JS.API.${s}`;
  // reach: own op-pool durable bind + the EPF fencing read
  c("the cleaner BINDS its own op-pool durable (CONSUMER.INFO on pool_<e>_pa replies)",
    (await reaches(clean.nc, jsapi(`CONSUMER.INFO.${epwStreamName(SPACE)}.${poolDurable(EP, POOL_A)}`))) === "allowed");
  c("the cleaner reaches the EPF fencing read (STREAM.MSG.GET on EPF replies)",
    (await reaches(clean.nc, jsapi(`STREAM.MSG.GET.${epfStreamName(SPACE)}`), enc.encode(JSON.stringify({ last_by_subj: `cotal.${SPACE}.epf.${EP}.nonesuch` })))) === "allowed");
  // confinement: foreign pool, foreign endpoint, and consumer CREATE all DENIED
  c("DENIED: a FOREIGN pool durable not in the op's list (pool_<e>_pb)",
    (await reaches(clean.nc, jsapi(`CONSUMER.INFO.${epwStreamName(SPACE)}.${poolDurable(EP, POOL_B)}`))) === "denied");
  c("DENIED: a FOREIGN endpoint's pool durable (pool_<e2>_pa)",
    (await reaches(clean.nc, jsapi(`CONSUMER.INFO.${epwStreamName(SPACE)}.${poolDurable(EP2, POOL_A)}`))) === "denied");
  c("DENIED: creating a NEW consumer on EPW (a cleaner binds pre-created durables, never creates)",
    (await reaches(clean.nc, jsapi(`CONSUMER.CREATE.${epwStreamName(SPACE)}`), enc.encode(JSON.stringify({ stream_name: epwStreamName(SPACE), config: { ack_policy: "none" } })))) === "denied");
  c("DENIED: a STREAM.PURGE on EPW (a cleaner never destroys stored work)",
    (await reaches(clean.nc, jsapi(`STREAM.PURGE.${epwStreamName(SPACE)}`))) === "denied");
  await clean.close();

  await god.close();
} finally {
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => { srv.once("exit", () => resolve()); srv.once("error", () => resolve()); });
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nRETIREMENT CLEANER CONFINEMENT ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
