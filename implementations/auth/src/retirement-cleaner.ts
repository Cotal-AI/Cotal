/**
 * The per-op EXACT-POOL CLEANER and RETIREMENT SETTLEMENT EXECUTOR credential lifecycles
 * (SPEC 13.9 "Terminal pool cleanup" + "Retirement settlement"; #29 piece 2, the credential
 * split the piece-1 union deferred). The retirement barrier's {@link RetirementDeps} needs four
 * credential seams (`openCleaner`/`retireCleanerCredential` and `openExecutor`/
 * `retireExecutorCredential`) wired to REAL bounded credentials, not the static-conf users the
 * smokes fake.
 *
 * TWO clients per (op x endpoint), never one. SPEC 13.9 SPLITS the authority: the cleaner holds
 * NO write grant at all (its explicit residual is terminal-free ACK suppression), while the
 * op-bounded settlement executor owns the lease-record CAS and the lease-derived `wrk` terminal
 * publish (the relocated, effective-inventory-confined forge residual). Piece 1 unioned both grant sets onto
 * the one cleaner credential, which (a) collapsed the split's confinement, a compromised
 * cleaner could both suppress ACKs and forge terminals, and (b) left the settlement CODE
 * running on the barrier's STANDING connection, which holds no settlement grant at all (masked
 * by the super-user smoke broker). This module mints them separately and hands the barrier an
 * executor-owned {@link WorkPoolContext}, so the rights and the code sit on the SAME connection.
 *
 * The panel-agreed shape (distsys #29 piece-1 vote (2)), now per CLIENT:
 *  - ONE distinct principal PER OP per role: `local.epcln_<opId-hash>` (cleaner) and
 *    `local.epexe_<opId-hash>` (executor). Kill-live is by CONNZ principal TAG, so a shared
 *    principal would let one op's evict collateral-kill another's client; and the barrier
 *    verified-evicts BOTH principals at the fence, so the two roles must be two principals.
 *  - grants from the DURABLE INTENT's (endpoint, pools) only: the cleaner gets exactly
 *    `retirementCleanerGrants` (bind-only pool reads + the EPF fencing read + scoped inbox,
 *    ZERO writes); the executor gets exactly {@link retirementExecutorClientGrants}. Nothing
 *    standing, short-lived, both CONNZ principal-tagged so the barrier can verified-evict them.
 *  - acquisition is ATOMIC and failure-transactional (the a559d9c freelance round): the
 *    principal is reserved SYNCHRONOUSLY before the first await (two concurrent same-op opens
 *    cannot both pass a check-then-await gap), the handles are built INSIDE the transaction,
 *    the client is published to the live map only on full success, and every post-connect
 *    failure closes the connection and releases the reservation (no infinite-reconnect leak,
 *    no poisoned entry).
 *  - `retire*Credential` closes the connection (the deny-new half). The barrier then runs its
 *    OWN `evictPrincipal` (the kill-live half); this module never evicts, so the delivery-admin
 *    KICK authority stays out of this seam.
 *  - fail-closed: a mint failure throws, so the barrier leaves the gate frozen (no frontiers,
 *    no head terminal) rather than proceeding without a credential.
 */
import { createHash } from "node:crypto";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { barrierExecutorSettlementGrants, openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import {
  EpEnvelopeError,
  assertInboxConnId,
  principalKey,
  recordsKvStreamName,
  retirementCleanerGrants,
  workPoolContext,
} from "@cotal-ai/core";
import type { PoolCleanerBind, RetirementExecutorBind } from "./retirement-barrier.js";

/** The infra owner for cleaner/executor principals: CONNZ-attributable (`local` passes the
 *  delivery daemon's owner check, evict-exec.ts), reserved so it never collides with an agent
 *  principal. */
const INFRA_OWNER = "local";

/** `epcln_<16-hex-of-sha256(opId)>` / `epexe_<...>`: single `[a-z0-9_]` actor tokens (no `-`,
 *  bounded), UNIQUE per (op, role). Same digest, distinct prefixes, so the two roles are two
 *  CONNZ principals and an evict of one never touches the other. 64 bits of digest is
 *  collision-resistant across any realistic set of concurrent ops. */
function opActor(prefix: "epcln" | "epexe", opId: string): string {
  return `${prefix}_${createHash("sha256").update(opId).digest("hex").slice(0, 16)}`;
}

/**
 * The op-bounded SETTLEMENT EXECUTOR client's grant (SPEC 13.9 "Retirement settlement" row):
 * {@link barrierExecutorSettlementGrants} (per effective-inventory pool: the `lease.` CAS write and the
 * `epf.<e>.wrk.<pool>.>` create-only publish, plus the leader-served EPF fencing read) + the
 * reads the settlement's own code path performs on its own connection, derived from the code:
 *  - `STREAM.MSG.GET.KV_cotal_records_<space>`: the lease re-reads (`kv.get` on the no-direct
 *    records bucket is a leader-served MSG.GET).
 *  - `STREAM.INFO.KV_cotal_records_<space>`: the `workPoolContext` bind probe (`Kvm.open`
 *    reads the stream config to bind the bucket).
 *  - `$JS.API.INFO` (the `jetstreamManager` handshake) + the connection-scoped inbox.
 * NO `STREAM.MSG.GET.EPW_<space>` (security/distsys/engineer, b8803b2 re-verify): the EPW
 * live-entry read (`liveEntryExists`) is UNREACHABLE from this composition. `settlementForIntent`
 * only ever calls `reconcileWorkItem` after proving `clock >= workExpiry`, so reconcile always
 * returns through the terminal/settled-lease/`now >= workExpiry` branches BEFORE the
 * `liveEntryExists` probe; `retireWorkItem` uses the lease key + EPF terminal alone. A space-wide
 * EPW body read plus its caller-selected-reply injection class is therefore dead authority, not a
 * read this code performs, so it is not granted. NOT the barrier's standing profile: the executor
 * client carries the settlement forge residual op-bounded (the D14/13.9 residual notes on
 * {@link barrierExecutorSettlementGrants}), and the barrier's auth-store write authority never
 * rides this connection. The `epw.>` ENQUEUE row is likewise absent (the settlement seam refuses
 * `expired` before the horizon, so the re-enqueue repair branch is structurally unreachable).
 */
export function retirementExecutorClientGrants(space: string, endpoint: string, pools: string[], connId: string): { publish: string[]; subscribe: string[] } {
  const settlement = barrierExecutorSettlementGrants(space, endpoint, pools);
  return {
    publish: [
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${recordsKvStreamName(space)}`,
      `$JS.API.STREAM.MSG.GET.${recordsKvStreamName(space)}`,
      ...settlement.publish,
    ],
    subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`],
  };
}

/** ATOMIC acquire: reserve the principal key SYNCHRONOUSLY (before any await), build the client
 *  and its handles transactionally, publish to the live map only on success. On ANY failure the
 *  reservation is released and a connected client is closed (never leaked, never poisoned). */
async function acquire<B>(
  clients: Map<string, AuthorityClient | "opening">,
  key: string,
  what: string,
  openClient: () => Promise<AuthorityClient>,
  makeBind: (client: AuthorityClient) => Promise<B>,
): Promise<B> {
  if (clients.has(key))
    throw new EpEnvelopeError("failed-precondition", `${what} already open (or opening) for ${key}; retire it before re-opening`);
  clients.set(key, "opening"); // the SYNCHRONOUS reservation: a concurrent same-op open throws above
  let client: AuthorityClient | undefined;
  try {
    client = await openClient();
    const bind = await makeBind(client);
    clients.set(key, client);
    return bind;
  } catch (e) {
    clients.delete(key);
    if (client !== undefined) await client.close().catch(() => { /* already failing loud */ });
    throw e;
  }
}

/** Release: close the tracked client for the principal (the deny-new half). A still-opening
 *  reservation refuses (a retire never closes a half-built client under a concurrent open);
 *  an untracked principal is a no-op (a crash-resume retires what a dead process never held). */
async function release(clients: Map<string, AuthorityClient | "opening">, key: string, what: string): Promise<void> {
  const tracked = clients.get(key);
  if (tracked === "opening")
    throw new EpEnvelopeError("failed-precondition", `${what} for ${key} is still opening; a retire never closes a half-built client`);
  if (tracked !== undefined) {
    clients.delete(key);
    await tracked.close();
  }
}

/**
 * Build the retirement credential seams over the data-account seed (the same self-mint
 * substrate as the barrier evictor). Returns all four seams for a {@link RetirementDeps}.
 */
export function makeRetirementCleaners(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}): {
  openCleaner: (args: { opId: string; endpoint: string; pools: string[] }) => Promise<PoolCleanerBind>;
  retireCleanerCredential: (bind: PoolCleanerBind) => Promise<void>;
  openExecutor: (args: { opId: string; endpoint: string; pools: string[] }) => Promise<RetirementExecutorBind>;
  retireExecutorCredential: (bind: RetirementExecutorBind) => Promise<void>;
} {
  // principal -> the open (or opening) client, both roles in ONE map (the keys are disjoint by
  // the actor prefix), so retire closes exactly this op's connection for that role.
  const clients = new Map<string, AuthorityClient | "opening">();
  const openRole = <B>(
    role: "epcln" | "epexe",
    what: string,
    label: string,
    args: { opId: string; endpoint: string; pools: string[] },
    grants: (connId: string) => { publish: string[]; subscribe: string[] },
    makeBind: (client: AuthorityClient, principal: string) => Promise<B>,
  ): Promise<B> => {
    const actor = opActor(role, args.opId);
    const principal = principalKey(INFRA_OWNER, actor).key;
    return acquire(clients, principal, what, () => openAuthorityClient({
      server: opts.server,
      space: opts.space,
      dataAccount: opts.dataAccount,
      label: `cotal:ep-${label}:${opts.space}:${args.opId}`,
      principal: { owner: INFRA_OWNER, actor },
      grants,
      log: opts.log,
    }), (client) => makeBind(client, principal));
  };
  return {
    openCleaner: ({ opId, endpoint, pools }) =>
      openRole("epcln", "retirement cleaner", "cleaner", { opId, endpoint, pools },
        (connId) => retirementCleanerGrants(opts.space, endpoint, pools, connId),
        // Both JS handles are built INSIDE the transaction: `jetstreamManager` performs a
        // `$JS.API.INFO` that can reject AFTER the credential connected; a failure there closes
        // the connection instead of stranding a live, never-retired tracked client.
        async (client, principal) => ({ jsm: await jetstreamManager(client.nc), js: jetstream(client.nc), principal })),
    retireCleanerCredential: (bind) => release(clients, bind.principal, "retirement cleaner"),
    openExecutor: ({ opId, endpoint, pools }) =>
      openRole("epexe", "retirement settlement executor", "executor", { opId, endpoint, pools },
        (connId) => retirementExecutorClientGrants(opts.space, endpoint, pools, connId),
        // The executor-owned, space-bonded work context: the settlement seam's rights and code
        // sit on this ONE connection (the constructor derives kv/js/jsm from it, brands the
        // context, and probes the records bucket, all inside the transaction).
        async (client, principal) => ({ work: await workPoolContext(client.nc, opts.space), principal })),
    retireExecutorCredential: (bind) => release(clients, bind.principal, "retirement settlement executor"),
  };
}
