/**
 * ONE-SHOT reconciler for a manager issuance gate left FROZEN by a crashed re-registration
 * (SPEC 13.1 "the gate is left frozen for reconciliation").
 *
 * Scenario it repairs, and the ONLY one it accepts: the re-registration barrier froze the gate,
 * eviction failed (no delivery-daemon oracle), the holder process died — so the freeze token's
 * owner can never resume. This script completes the DEAD op's own §13.1 obligation using the
 * SHIPPED composition (endpointRegistrationBarrier + makeManagerEndpointEvictor), never raw
 * writes: enumerate the family → revoke active rows → VERIFY-evict every holder → token-pinned
 * abort-reopen at the UNCHANGED coordinate (generation+1, same processEpoch/registrationRevision/
 * nameAuthorityRevision). The manager's next start then runs its normal takeover end-to-end.
 *
 * Preconditions checked loudly: gate exists, state === "frozen", op.kind === "registration".
 * The delivery daemon MUST be up (the evictor asks it; fail-closed otherwise).
 *
 * Usage: pnpm exec tsx bin/reconcile-manager-gate.mts   (from the mesh root, e.g. ~/Cotal)
 */
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  mintCreds, newIdentity, standaloneConnectOpts,
  endpointRegistrationBarrier, epAuthBucket, epgateKey,
} from "@cotal-ai/core";
import { getSpaceAuth, workspaceSecretStore, loadManagerInstanceIdentity } from "@cotal-ai/workspace";
import { makeManagerEndpointEvictor } from "./src/endpoint-evict.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), "Cotal");
const SPACE = "main";
const SERVERS = process.env.COTAL_SERVER ?? "nats://broker.cotal.ai:4222";
const ENDPOINT = "manager";

const die = (msg: string): never => { console.error(`✗ ${msg}`); process.exit(2); };

const persisted = loadManagerInstanceIdentity(ROOT, SPACE);
if (!persisted?.instanceId) die(`no persisted manager instance identity under ${ROOT} for space ${SPACE}`);
const iid = persisted!.instanceId;
console.error(`• reconciling gate for ${ENDPOINT}/${iid} on ${SERVERS}`);

const secrets = workspaceSecretStore(ROOT);
const auth = await getSpaceAuth(secrets, SPACE);
if (!auth) die("no space auth here (this must run on the seedful mesh root)");

const identity = newIdentity();
const creds = await mintCreds(auth!, identity, "endpoint-serve-executor", {
  endpointServeExecutor: { endpoint: ENDPOINT, instanceId: iid },
});
const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
try {
  const kvm = new Kvm(nc);
  const authKv = await kvm.open(epAuthBucket(SPACE));

  // Raw read of the gate row: recover the dead op's id and the freeze token (= the row revision).
  const key = epgateKey(ENDPOINT, iid);
  const entry = await authKv.get(key);
  if (!entry) die(`no gate row at ${key}`);
  const row = JSON.parse(new TextDecoder().decode(entry!.value));
  const token = entry!.revision;
  console.error(`• gate state=${row.state} gen=${row.generation} epoch=${row.processEpoch} regRev=${row.registrationRevision} op=${JSON.stringify(row.op)} rev=${token}`);
  if (row.state !== "frozen") die(`gate is "${row.state}", not "frozen" — nothing to reconcile (refusing)`);
  if (row.op?.kind !== "registration" || !row.op?.opId) die(`frozen op is ${JSON.stringify(row.op)}, not a registration — refusing`);

  const barrier = endpointRegistrationBarrier(authKv, SPACE, {
    endpoint: ENDPOINT, instanceId: iid, opId: row.op.opId,
    evict: makeManagerEndpointEvictor({ space: SPACE, servers: SERVERS, auth: auth!, log: (l: string) => console.error(l) }),
  });

  // §13.1 in shipped order: enumerate → revoke actives → verify-evict every holder.
  const rows = await barrier.enumerate();
  console.error(`• family: ${rows.length} ledger row(s)`);
  for (const r of rows) {
    if (r.state === "active") { await barrier.revoke(r); console.error(`  revoked ${r.credentialId} (${r.holderPrincipal})`); }
    else console.error(`  ${r.state}: ${r.credentialId} (${r.holderPrincipal})`);
  }
  const holders = [...new Set(rows.map((r: { holderPrincipal: string }) => r.holderPrincipal))];
  for (const h of holders) {
    const gone = await barrier.evict(h);
    if (!gone) die(`eviction of ${h} NOT verified gone — gate stays frozen (fail-closed, SPEC 13.1)`);
    console.error(`  verified evicted: ${h}`);
  }

  // Token-pinned abort-reopen at the UNCHANGED coordinate (the dead op wrote nothing forward).
  const ok = await barrier.reopen(token, {
    generation: row.generation + 1, processEpoch: row.processEpoch,
    registrationRevision: row.registrationRevision, nameAuthorityRevision: row.nameAuthorityRevision,
  });
  if (!ok) die("reopen CAS lost — a newer barrier moved the gate (re-observe before retrying anything)");
  console.error(`✓ gate ${ENDPOINT}/${iid} reopened at gen=${row.generation + 1}, epoch unchanged (${row.processEpoch}); family revoked+verified-evicted (${holders.length} holder(s))`);
} finally {
  await nc.drain().catch(() => nc.close());
}
