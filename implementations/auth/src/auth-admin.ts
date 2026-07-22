/**
 * The AUTH service's CONTROL RAIL listener (#29 piece 3, SPEC 13.2 `CONTROL_AUTH_ADMIN`): the
 * GENERIC "retire a lifecycle (owner, actor, lifecycleUid)" operation, served by the auth plane
 * itself — the despawn→retirement trigger's serve side, and the D5 split's other half
 * (retirement is the AUTH plane's operation; it never rides the DELIVERY daemon's rail).
 *
 * AUTHZ (the panel-confirmed RAIL-TIME rule, never mint-only):
 *  - Caller attribution is SUBJECT-derived and broker-enforced: the request subject is
 *    `ctl.auth-admin.<owner>.<actor>`, and only a credential minted with THAT principal's
 *    request-publish grant can reach it ({@link retirementRequesterGrants}); the body's claims
 *    never authorize (the reply-rail discipline).
 *  - The SPACE-MANAGER LEASE holder-check runs FRESH per request: a leader-served
 *    `STREAM.MSG.GET` read of the ONE `lease` key in the manager bucket, requiring
 *    `lease.holder == principalKey(subjectOwner, subjectActor).key` (the lease holder IS the
 *    manager endpoint's principal dot-form). This closes the post-lease-loss window: a manager
 *    that lost its lease after minting a requester credential is refused AT THE RAIL. Absent
 *    lease (TTL-expired, no manager) refuses fail-closed — never guesses.
 *  - The GENERIC surface never names a caller class (a manager despawn is ONE caller); the
 *    lease check is this service's serve-time authz, not subject grammar.
 *
 * IDEMPOTENCE (the confirmed four-outcome table, surfaced as OPERATOR results): already-retired
 * (uid match) → success; a frozen gate under the SAME opId → the barrier resumes it; a FOREIGN
 * operation holding the gate → refuse naming the operation; a different current uid → refuse
 * (stale trigger). The requester sends a STABLE opId across retries, so an epCall retry never
 * mints a second operation.
 *
 * UX (the piece-3 faces): every refusal is WHAT/WHY/NEXT in operator vocabulary — the lease-loss
 * refusal states the despawn was a FULL NO-OP (the target is unchanged and still running,
 * nothing was applied) with `cotal supervise` → retry as the NEXT; the vocabulary bridge
 * ("despawn started this agent's retirement") lives at the CLI surface that renders these.
 *
 * SEAL COMPOSITION (critic's three checks): the listener holds NO scanner/plane authority — the
 * retirement runs through the injected {@link RetirementDeps}, whose drain rides the plane's ONE
 * sealed records scanner exactly like the boot resume; the lease read is a leader read, no
 * consumer-create anywhere; the requester credential is request + reply-inbox ONLY.
 */
import type { Subscription } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  CONTROL_AUTH_ADMIN,
  EpEnvelopeError,
  assertBoundedOwner,
  assertLifecycleToken,
  endpointToken,
  epAuthBucket,
  principalKey,
  retirementFrontierStreams,
  serveIssuanceGateKv,
  spacePrefix,
} from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import { runAgentRetirementBarrier, type RetirementDeps } from "./retirement-barrier.js";
import { observeGate, readLifecycleHeadForOperation, type LifecycleRegistry } from "./lifecycle-registry.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The LISTENER profile (SPEC 13.9 "Auth control rail" row): serve + bounded replies on the
 *  auth-admin control subtree, plus the ONE leader-served lease read the holder-check performs.
 *  No store writes, no consumer authority, no scanner reach. */
export function authAdminListenerGrants(space: string, connId: string): { publish: string[]; subscribe: string[] } {
  return {
    publish: [
      // REPLIES ONLY. The handler only ever `msg.respond`s to `<request-subject>.reply.…` (boundReply,
      // below), so the listener never needs to publish a bare REQUEST subject. Granting the request
      // subtree (`…auth-admin.>`) would let a compromised listener credential self-publish a
      // `retireLifecycle` as the lease holder and pass its own subject-derived lease check (self-forge);
      // scoping to `*.*.reply.>` closes that. The requester credential (provision.ts) is already
      // broker-bound to publish only its OWN `<owner>.<actor>` request subject.
      `${spacePrefix(space)}.ctl.${CONTROL_AUTH_ADMIN}.*.*.reply.>`,
      "$JS.API.INFO",
      // The ONE leader-served read the holder-check performs: the serve-issuance GATE (P2 item 3
      // 3b-3), a point-get of `epgate.<endpoint>.<instanceId>` proving the requesting manager
      // instance's serve grant is CURRENT (registration-record-derived, replacing the old
      // name-derived manager-lease read). No consumer authority, no store writes.
      `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`,
    ],
    subscribe: [`${spacePrefix(space)}.ctl.${CONTROL_AUTH_ADMIN}.*.*`, `_INBOX_${connId}.>`],
  };
}

// The per-despawn REQUESTER profile lives in core (`mintCreds` profile "retirement-requester",
// the ONE grants source the D32 audit pins): publish exactly its own control subject + subscribe
// its own reply subtree and inbox - request + reply ONLY.

/** One rail request's CLOSED argument shape. `serve*` (P2 item 3 3b-3) declares the REQUESTING
 *  manager instance's current serve identity so the holder check is registration-record-derived. */
interface RetireArgs {
  owner: string;
  actor: string;
  lifecycleUid: string;
  opId: string;
  serveEndpoint: string;
  serveInstanceId: string;
  serveEpoch: number;
}

function parseRetireArgs(raw: unknown): RetireArgs {
  const shape = "{ owner, actor, lifecycleUid, opId, serveEndpoint, serveInstanceId, serveEpoch }";
  if (raw === null || typeof raw !== "object")
    throw new EpEnvelopeError("failed-precondition", `retireLifecycle requires args ${shape}`);
  const a = raw as Record<string, unknown>;
  for (const k of Object.keys(a)) if (!["owner", "actor", "lifecycleUid", "opId", "serveEndpoint", "serveInstanceId", "serveEpoch"].includes(k))
    throw new EpEnvelopeError("failed-precondition", `retireLifecycle args carry the unknown field "${k}" (closed shape)`);
  if (typeof a.owner !== "string" || typeof a.actor !== "string" || typeof a.lifecycleUid !== "string" || typeof a.opId !== "string" ||
      typeof a.serveEndpoint !== "string" || typeof a.serveInstanceId !== "string" ||
      typeof a.serveEpoch !== "number" || !Number.isInteger(a.serveEpoch) || a.serveEpoch < 0)
    throw new EpEnvelopeError("failed-precondition", `retireLifecycle requires args ${shape} (serveEpoch a non-negative integer)`);
  return {
    owner: assertBoundedOwner(a.owner, "owner"),
    actor: assertBoundedOwner(a.actor, "actor"),
    lifecycleUid: assertLifecycleToken(a.lifecycleUid, "lifecycleUid"),
    opId: assertLifecycleToken(a.opId, "opId"),
    serveEndpoint: endpointToken(a.serveEndpoint),
    serveInstanceId: assertLifecycleToken(a.serveInstanceId, "serveInstanceId"),
    serveEpoch: a.serveEpoch,
  };
}

export interface AuthAdminListener {
  close(): Promise<void>;
}

/**
 * Open the rail: subscribe the auth-admin control subtree on a dedicated minimal listener
 * credential and serve `retireLifecycle`. Every executing right stays with the injected
 * registry + {@link RetirementDeps} (the plane's own, sealed-scanner-threaded mechanics).
 */
export async function openAuthAdminListener(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  reg: LifecycleRegistry;
  retirement: RetirementDeps;
  log: (line: string) => void;
}): Promise<AuthAdminListener> {
  const { space, log } = opts;
  const client: AuthorityClient = await openAuthorityClient({
    server: opts.server, space, dataAccount: opts.dataAccount,
    label: `cotal:auth-admin:${space}`,
    grants: (id) => authAdminListenerGrants(space, id),
    log,
  });
  let epAuthKv: import("@nats-io/kv").KV;
  try {
    // Bind the endpoint-auth bucket once for the 3b-3 serve-issuance-gate holder check (point-get,
    // no consumer). Lazy bind (kvm.open) — the space's stores are pre-created at `cotal up`.
    epAuthKv = await new Kvm(client.nc).open(epAuthBucket(space));
  } catch (e) {
    await client.close();
    throw e;
  }
  const prefix = `${spacePrefix(space)}.ctl.${CONTROL_AUTH_ADMIN}.`;
  const sub: Subscription = client.nc.subscribe(`${prefix}*.*`, {
    callback: (err, msg) => {
      if (err) return;
      void (async () => {
        // boundReply (the serveControl discipline): the reply target must live under the
        // SENDER'S OWN request subject — the listener holds a subtree-wide reply grant, so a
        // caller-selected foreign reply target is refused here, never published to.
        if (msg.reply === undefined || !msg.reply.startsWith(`${msg.subject}.reply.`)) {
          log(`auth-admin: dropped a request on ${msg.subject} with an unbound reply target (${msg.reply ?? "none"})`);
          return;
        }
        let reply: { ok: boolean; data?: unknown; error?: string };
        try {
          reply = await handle(msg.subject.slice(prefix.length), msg.data);
        } catch (e) {
          reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        try {
          msg.respond(enc.encode(JSON.stringify(reply)));
        } catch (e) {
          log(`auth-admin: reply publish failed on ${msg.subject}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
  });

  // SINGLE-FLIGHT the barrier EXECUTION per opId (audit #1): each request still runs its OWN fresh
  // lease re-check + idempotence, but concurrent same-opId requests (a manager nudge + a retry, or a boot
  // resume racing the rail) share ONE runAgentRetirementBarrier, so the barrier body never dual-executes
  // (dual contain/drain mutating past a frontier the other task closes). A joiner awaits the same result.
  //
  // The flight is BOUND to its operation coordinates (owner, actor, lifecycleUid). opId is caller-supplied
  // at this generic rail (`retireOpId(uid)` is a manager convention, NOT a broker- or barrier-enforced
  // bind), so a coordinate-BLIND join would let an ACTIVE lifecycle B reuse A's in-flight opId, skip the
  // barrier's durable intent-coordinate check (retirement-barrier.ts), and receive A's `ok:true` naming B
  // — freeing B's alias over a still-live principal (the exact alias-reuse class #1 exists to close). So a
  // same-opId join whose coordinates differ is REFUSED as a full no-op; only a coordinate-IDENTICAL
  // request (the intended nudge/retry) joins the in-flight barrier.
  const barrierFlight = new Map<string, { owner: string; actor: string; lifecycleUid: string; promise: ReturnType<typeof runAgentRetirementBarrier> }>();

  const handle = async (principalTail: string, body: Uint8Array): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    const tokens = principalTail.split(".");
    if (tokens.length !== 2) return { ok: false, error: `auth-admin: the request subject must carry exactly <owner>.<actor>` };
    const requester = principalKey(tokens[0]!, tokens[1]!).key;
    let req: { op?: unknown; args?: unknown };
    try {
      req = JSON.parse(dec.decode(body)) as { op?: unknown; args?: unknown };
    } catch {
      return { ok: false, error: "auth-admin: the request body is not JSON" };
    }
    if (req.op !== "retireLifecycle")
      return { ok: false, error: `op "${String(req.op)}" not supported on the auth admin service` };
    const args = parseRetireArgs(req.args);

    // THE RAIL-TIME REGISTRATION RE-CHECK (fresh, leader-served, fail-closed) — P2 item 3 (3b-3):
    // the requesting manager instance's SERVE GRANT must be current. Read the serve-issuance gate
    // (registration-record-derived, REPLACING the old name-derived manager-lease holder check): the
    // requester declares its (serveEndpoint, serveInstanceId, serveEpoch); an absent/retired gate means
    // no registered instance, and a gate whose current processEpoch moved past the declared one means
    // the requester was SUPERSEDED (a deposed predecessor after a restart) — refused as a full no-op.
    // Every instance of one space shares the manager principal (the broker ACL already confines the
    // requester to it), so ANY current instance's gate authorizes (accept any registered instance with
    // a current serve grant — pin 5). The requester principal is still recorded on the audit line below.
    let serveGate: Awaited<ReturnType<ReturnType<typeof serveIssuanceGateKv>["observe"]>>;
    try {
      serveGate = await serveIssuanceGateKv(epAuthKv, space, { endpoint: args.serveEndpoint, instanceId: args.serveInstanceId }).observe();
    } catch (e) {
      return { ok: false, error: `the retirement request cannot be authorized right now: the manager serve-issuance gate could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was applied - the agent is unchanged. NEXT: check the broker and retry the despawn.` };
    }
    if (serveGate === null || serveGate.state === "retired")
      return { ok: false, error: `no manager instance currently holds a serve registration for "${space}" (instance ${args.serveInstanceId} is ${serveGate === null ? "unregistered" : "retired"}), so nothing may retire agents. The despawn was a FULL no-op - the agent is unchanged and still running. NEXT: start or recover the manager (\`cotal supervise\`), then retry the despawn.` };
    if (serveGate.processEpoch !== args.serveEpoch)
      return { ok: false, error: `the requesting manager instance ${args.serveInstanceId} was SUPERSEDED (it registered at epoch ${args.serveEpoch}, the current serve grant is epoch ${serveGate.processEpoch}), so this despawn was REFUSED as a FULL no-op - the agent is unchanged and still running, nothing was torn down. NEXT: recover the manager (\`cotal supervise\`), then retry the despawn under the current serving instance.` };

    // IDEMPOTENCE (the four-outcome table, in operator vocabulary).
    const head = await readLifecycleHeadForOperation(opts.reg, args.owner, args.actor);
    if (head === undefined)
      return { ok: false, error: `no lifecycle exists for "${args.owner}/${args.actor}"; there is nothing to retire.` };
    if (head.mapping.state === "retired" && head.mapping.lifecycleUid === args.lifecycleUid)
      return { ok: true, data: { alreadyRetired: true, lifecycleUid: args.lifecycleUid } };
    if (head.mapping.lifecycleUid !== args.lifecycleUid)
      return { ok: false, error: `the despawn names a stale incarnation of "${args.owner}/${args.actor}" (current is ${head.mapping.lifecycleUid}); nothing was retired. NEXT: refresh the agent list and retry against the current incarnation.` };
    const gate = await observeGate(opts.reg, args.lifecycleUid);
    if (gate !== undefined && gate.row.state === "frozen" && gate.row.op !== undefined && gate.row.op.opId !== args.opId)
      return { ok: false, error: `another operation (${gate.row.op.kind} ${gate.row.op.opId}) already holds "${args.owner}/${args.actor}"; this despawn did not start a second one. NEXT: wait for that operation to finish (or its resume on the next auth-service boot), then retry.` };

    // EXECUTE (create-or-resume: the barrier's own freeze CAS + durable intent make the same
    // opId resumable and a re-request idempotent). The drain, cleaner, and repair credentials
    // all come from the plane's reviewed deps - this listener holds none of those rights.
    const existing = barrierFlight.get(args.opId);
    if (existing !== undefined &&
        (existing.owner !== args.owner || existing.actor !== args.actor || existing.lifecycleUid !== args.lifecycleUid))
      return { ok: false, error: `operation id ${args.opId} is already in flight for a different lifecycle (${existing.owner}/${existing.actor} ${existing.lifecycleUid}); this despawn of "${args.owner}/${args.actor}" (${args.lifecycleUid}) was a FULL no-op - nothing was retired and it is still running. NEXT: retry the despawn (the manager derives a distinct operation id per lifecycle).` };
    let flight = existing?.promise;
    if (flight === undefined) {
      // A despawn cannot know the target's pool work, and the barrier never takes a pool hint: it
      // DISCOVERS the real (endpoint, pools) cleaner inventory from the target's own accepted pool
      // obligations (#F). Discovery is never a gap - the barrier never closes a frontier over
      // un-cleaned accepted pool work (SPEC 13.1/13.9).
      flight = runAgentRetirementBarrier(opts.reg, {
        owner: args.owner, actor: args.actor, lifecycleUid: args.lifecycleUid, opId: args.opId,
        frontierStreams: retirementFrontierStreams(space),
      }, opts.retirement);
      const settle = flight;
      void settle.catch(() => {}).finally(() => { if (barrierFlight.get(args.opId)?.promise === settle) barrierFlight.delete(args.opId); });
      barrierFlight.set(args.opId, { owner: args.owner, actor: args.actor, lifecycleUid: args.lifecycleUid, promise: flight });
    }
    const result = await flight;
    log(`auth-admin: retired ${args.owner}/${args.actor} (${args.lifecycleUid}) by despawn request from ${requester} (op ${args.opId})`);
    return { ok: true, data: { retired: true, lifecycleUid: args.lifecycleUid, opId: result.opId, evictedPrincipals: result.evictedPrincipals } };
  };

  return {
    close: async () => {
      try { sub.unsubscribe(); } catch { /* connection already down */ }
      await client.close();
    },
  };
}
