/**
 * ENDPOINT-SERVE GATE smoke (control-surface P2 item 1, 1a-gate) — the FIRST production wiring of
 * the endpoint-serve credential subsystem (fact H3), proven over a REAL broker + real auth KV:
 * the endpoint issuance-gate lifecycle `epgate.<endpoint>.<instanceId>` and its `epcred.<…>` serve
 * ledger family, driven by the core primitives (`provisionEndpointGateOpen`,
 * `endpointRegistrationBarrier`, `serveIssuanceGateKv`) the auth session ledger and the manager
 * both share.
 *
 * Proves the panel's 1a-gate musts:
 *  - GATE-CAS TRAVERSAL, NO SEED SHORTCUT: the registration barrier observes -> freezes (open ->
 *    frozen under a registration op) -> reopens (frozen -> open at the successor generation). The
 *    gate is a real revision-pinned CAS; serve authority moves ONLY through it.
 *  - MINT FENCE: `serveIssuanceGateKv` stages an `epcred` row then commits a revision-pinned TOUCH;
 *    a mint whose observed revision was moved by a barrier LOSES (releases nothing).
 *  - REAL REVOKE PATH (not a stub): a takeover barrier enumerates the prior serve family and CASes
 *    every active row `active -> revoked`, so a superseded serve credential's ledger row is
 *    revoked and non-reissuable under the old generation.
 *  - LOSS NEGATIVES: freeze of a non-open gate loses; a stale-token reopen loses; a same-name
 *    re-provision with a DIFFERENT principal conflicts (an instance token is never re-bound).
 *
 * NOT in scope here (1a-serve): the `mintCreds(endpoint-serve)` -> `serveEndpoint` -> `epCall`
 * composition (a minted serve cred serving a real command) — that is where the MANAGER consumes
 * this subsystem; the serve/describe/invoke SURFACE is proven with fake gates in
 * endpoint-serve.smoke.ts. This smoke isolates the net-new real-KV credential LIFECYCLE.
 *
 * Run: pnpm smoke:ep-serve-gate   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams,
  epAuthBucket,
  epgateKey,
  epcredRowKey,
  parseEndpointGate,
  parseLedgerRow,
  mintLifecycleUid,
  provisionEndpointGateOpen,
  endpointRegistrationBarrier,
  serveIssuanceGateKv,
  type EpServeLedgerRow,
} from "../src/index.js";
import type { KV } from "@nats-io/kv";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown>, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dec = new TextDecoder();

const SPACE = "epservegate";
const ENDPOINT = "throwaway";
const IID = "i".repeat(26);
const PRINCIPAL = `u_${"c".repeat(26)}.term`; // the serving instance's CONNZ-attributable principal
const gateState = async (kv: KV) => parseEndpointGate((await kv.get(epgateKey(ENDPOINT, IID)))!.value, epgateKey(ENDPOINT, IID));
const gateRevision = async (kv: KV) => (await kv.get(epgateKey(ENDPOINT, IID)))!.revision;
const mkServeRow = (credentialId: string): EpServeLedgerRow => ({
  credentialId, credentialKey: "unused-by-fence", holderPrincipal: PRINCIPAL,
  endpoint: ENDPOINT, lifecycleUid: IID, sourceChain: ["session.abc"], state: "active", exp: 1_900_000_000,
  generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
});

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epservegate-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  const kv = await new Kvm(nc).open(epAuthBucket(SPACE));

  console.log("A. provision the endpoint gate OPEN (the §13.1 pre-registration)");
  await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId: IID, principal: PRINCIPAL });
  const born = await gateState(kv);
  c("the gate is born OPEN at generation 0, no op intent", born.state === "open" && born.generation === 0 && born.op === undefined, born);
  c("the gate carries the serving principal", born.principal === PRINCIPAL);
  await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId: IID, principal: PRINCIPAL }); // idempotent
  c("re-provision with the SAME principal is idempotent (still open@gen0)", (await gateState(kv)).generation === 0);
  await rejects("re-provision with a DIFFERENT principal CONFLICTS (an instance token is never re-bound)",
    () => provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId: IID, principal: `u_${"d".repeat(26)}.term` }), "conflict");

  console.log("B. the registration barrier: observe -> freeze -> reopen (the gate-CAS traversal, NO seed shortcut)");
  const op1 = mintLifecycleUid();
  const bar1 = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: op1 });
  const obs1 = await bar1.observe();
  c("observe reads the open gate at its revision", obs1 !== null && obs1.state === "open" && obs1.space === SPACE && obs1.endpoint === ENDPOINT && obs1.lifecycleUid === IID, obs1);
  const token1 = await bar1.freeze(obs1!.revision);
  c("freeze returns a fencing TOKEN and leaves the gate FROZEN under the registration op", token1 !== null && (await gateState(kv)).state === "frozen" && (await gateState(kv)).op?.opId === op1 && (await gateState(kv)).op?.kind === "registration", { token1 });
  c("a mint FENCE cannot commit while the gate is frozen (observe sees frozen, commit refuses open-only)",
    (await serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID }).observe())!.state === "frozen");
  const reopened1 = await bar1.reopen(token1!, { generation: obs1!.generation + 1, processEpoch: obs1!.processEpoch, registrationRevision: 1, nameAuthorityRevision: obs1!.nameAuthorityRevision });
  const g1 = await gateState(kv);
  c("reopen advances the gate to OPEN at generation 1, op cleared, registrationRevision stamped", reopened1 === true && g1.state === "open" && g1.generation === 1 && g1.registrationRevision === 1 && g1.op === undefined, g1);

  console.log("C. the mint FENCE: stage an epcred row + commit a revision-pinned touch");
  const gate = serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID });
  const obsMint = await gate.observe();
  c("the mint observes the reopened open gate at gen1", obsMint !== null && obsMint.state === "open" && obsMint.generation === 1);
  const CRED_A = "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await gate.stage(mkServeRow(CRED_A));
  const stagedRow = parseLedgerRow((await kv.get(epcredRowKey(ENDPOINT, IID, CRED_A)))!.value, epcredRowKey(ENDPOINT, IID, CRED_A));
  c("stage writes an ACTIVE epcred ledger row for this instance, holder = the serving principal", stagedRow.state === "active" && stagedRow.holderPrincipal === PRINCIPAL && stagedRow.endpoint === ENDPOINT && stagedRow.lifecycleUid === IID, stagedRow);
  c("commit at the OBSERVED revision WINS (the mint released its credential)", (await gate.commit(obsMint!.revision)) === true);
  c("commit at a STALE revision LOSES (a barrier moved the gate since observation)", (await gate.commit(obsMint!.revision - 1)) === false);

  console.log("D. the REAL revoke path: a takeover barrier enumerates + revokes the prior serve family");
  const op2 = mintLifecycleUid();
  const bar2 = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: op2 });
  const obs2 = await bar2.observe();
  const token2 = await bar2.freeze(obs2!.revision);
  c("the takeover freeze wins the now-open gate", token2 !== null);
  const family = await bar2.enumerate();
  c("enumerate finds the prior ACTIVE epcred row (a REAL prefix scan, not an empty stub)", family.length === 1 && family[0].credentialId === CRED_A && family[0].state === "active" && family[0].holderPrincipal === PRINCIPAL, family);
  for (const row of family) if (row.state === "active") await bar2.revoke(row);
  const revoked = parseLedgerRow((await kv.get(epcredRowKey(ENDPOINT, IID, CRED_A)))!.value, epcredRowKey(ENDPOINT, IID, CRED_A));
  c("revoke CASes the prior serve credential's ledger row active -> REVOKED", revoked.state === "revoked", revoked);
  c("evict verifies GONE (fresh-registration trivial evictor — NAMED RESIDUAL: no live predecessor)", (await bar2.evict(PRINCIPAL)) === true);
  const reopened2 = await bar2.reopen(token2!, { generation: obs2!.generation + 1, processEpoch: obs2!.processEpoch, registrationRevision: 2, nameAuthorityRevision: obs2!.nameAuthorityRevision });
  c("the takeover reopens at generation 2 (the successor advanced past the revoked family)", reopened2 === true && (await gateState(kv)).generation === 2);
  c("re-enumerate now sees the row as REVOKED (non-reissuable under the old generation)", (await bar2.enumerate())[0].state === "revoked");

  console.log("E. loss negatives (fail-closed)");
  const op3 = mintLifecycleUid();
  const bar3 = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: op3 });
  const obs3 = await bar3.observe();
  const token3 = await bar3.freeze(obs3!.revision);
  c("freeze wins the open gate", token3 !== null);
  const op4 = mintLifecycleUid();
  const bar4 = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: op4 });
  c("a SECOND freeze of the now-frozen gate LOSES (another barrier holds it)", (await bar4.freeze(await gateRevision(kv))) === null);
  c("a reopen with a STALE token LOSES (only the holder of the current freeze reopens)", (await bar3.reopen(token3! - 1, { generation: 99, processEpoch: 0, registrationRevision: 9, nameAuthorityRevision: 0 })) === false);
  c("the rightful holder still reopens at its token", (await bar3.reopen(token3!, { generation: obs3!.generation + 1, processEpoch: obs3!.processEpoch, registrationRevision: 3, nameAuthorityRevision: obs3!.nameAuthorityRevision })) === true);

  await nc.drain();
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ENDPOINT-SERVE GATE SMOKE OK ✅" : "ENDPOINT-SERVE GATE SMOKE FAILED"}  (${ok} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
