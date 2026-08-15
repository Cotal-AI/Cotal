/**
 * The caller the delivery row asks THROUGH — an agent-class endpoint, chosen by measurement.
 *
 * WHICH PROFILE, AND WHY IT IS NOT THE CONVENIENT ONE. `delivery-row.ts` deliberately left the
 * credential class as a required parameter rather than a default, because an under-granted caller
 * does not fail loudly on this surface: it renders `no-responder` — *the daemon did not answer* —
 * when the truth is *I was never permitted to ask*. The arms that settled it ran against a real
 * broker with a real daemon, and are recorded in `.lane/window-result-2026-08-15.md`:
 *
 *     agent                            -> SERVING
 *     probe (connect-only)             -> refused
 *     control-caller-privileged        -> refused      <- what the MANAGER row mints
 *     agent, vs a SIGKILLed daemon     -> no-responder
 *
 * `control-caller-privileged` — the tempting reuse, since the manager row already mints it — is
 * DENIED AT THE BROKER on the delivery-lease KV read. Had this row reused it, it would have reported
 * the daemon as unreachable on a perfectly healthy mesh, which is this lane's own defect class
 * arriving through the credential layer. `refused` and `no-responder` were confirmed to be DISTINCT
 * conditions in the same run under load, so the row can tell "denied" from "absent".
 *
 * THE ERROR LISTENER IS NOT DEFENSIVE BOILERPLATE. A denied read surfaces on TWO paths: the
 * assessment returns a refusal AND the endpoint emits an `'error'` event. An unhandled `'error'` on
 * an EventEmitter is fatal to the process — measured, not argued: it killed the arms harness before
 * its teardown ran and orphaned a broker. A health surface that dies while reporting a refusal is
 * strictly worse than one that reports nothing, so the listener is attached BEFORE `start()` — a
 * denial can arrive during connect.
 */
import { CotalEndpoint, idFromCreds, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { getSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { deliverySeams, type CallerUnavailable } from "./delivery-row.js";
import type { GuardSeams } from "./delivery-guard.js";

/** How long the affirmative round-trip may take before it is a refusal. Deliberately short: this is
 *  a card rendered while an operator waits, and a slow answer that arrives is still not "right now".
 *  A timeout here is reported as a named refusal, never as health. */
const PROBE_DEADLINE_MS = 1_500;
/** The lease shard the row reads. Shard 0 is the only shard a single-daemon deployment writes. */
const SHARD = 0;

/** A live caller plus the handle that closes it. `close` is separate because the row must not leak a
 *  broker connection into a CLI process that is about to print one line and exit. */
export interface DeliveryCaller {
  check: Pick<GuardSeams, "check">["check"];
  close: () => Promise<void>;
  /** Async denials seen on this endpoint. Captured so a caller CAN report them; never thrown. */
  asyncErrors: string[];
  /** The RAW lease, separate from the assessment. Exposed because "the lease still looks healthy
   *  while the daemon is dead" is the residue the origin incident produced, and a cell that cannot
   *  read the lease independently cannot tell a refusal earned by the round-trip from one that a
   *  plain age check would also have caught. The row itself never reads this — it is the evidence
   *  that the round-trip is doing the work. */
  leaseNow: () => Promise<{ holder: string; since: number; ready: boolean } | undefined>;
}

/**
 * Mint an agent-class caller for one delivery health read.
 *
 * Returns a {@link CallerUnavailable} when no caller could be built, NAMING which of the two
 * failures occurred: `no-credential` (we could not mint) or `unreachable` (we minted and could not
 * reach the broker). Both are facts about US, never about the daemon — but they are different facts,
 * and collapsing them was a reproduced defect, not a hypothetical one.
 */
export async function mintDeliveryCaller(o: {
  root: string;
  space: string;
  servers: string;
  ttlMs: number;
  now: () => number;
}): Promise<DeliveryCaller | CallerUnavailable> {
  // PHASE 1 — MINT. Only credential failures can happen here, so only credential failures can be
  // reported from here. Wrapping the mint and the connect in ONE try is what made an unreachable
  // broker describe itself as a missing credential; measured against a dead port before this split.
  let creds: string | undefined;
  let uid: string;
  try {
    const auth = await getSpaceAuth(workspaceSecretStore(o.root), o.space);
    // No space auth on disk means an OPEN mesh. Unlike the manager row, there is nothing to ask
    // there: the delivery lease bucket is part of the auth-mode delivery plane, so a read will
    // refuse and the row will say so by name. We still build the caller rather than short-circuit,
    // because `no-auth` means "could not build a caller" and that is not what happened.
    uid = mintLifecycleUid();
    creds = auth === undefined
      ? undefined
      : await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: uid });
  } catch (e) {
    return {
      condition: "no-credential",
      detail: `no caller credential could be built (${(e as Error).message})`,
    };
  }

  // PHASE 2 — CONNECT. A failure here is about the broker or the network, and it is specifically NOT
  // about the delivery daemon: we never got close enough to ask it anything.
  let ep: CotalEndpoint | undefined;
  try {
    ep = new CotalEndpoint({
      space: o.space,
      servers: o.servers,
      ...(creds !== undefined ? { creds } : {}),
      lifecycleUid: uid,
      // Read-only instrument: it subscribes to nothing, consumes nothing, and does not register
      // presence. A health reader that advertises itself in the roster would add a peer to the mesh
      // every time an operator ran `setup`.
      channels: [], consume: false, registerPresence: false, watchPresence: false,
      card: {
        ...(creds !== undefined ? { id: idFromCreds(creds) } : {}),
        name: "delivery-health-reader", role: "instrument", kind: "endpoint",
      },
    });
    const asyncErrors: string[] = [];
    // BEFORE start(): see the header. A denial can arrive during connect.
    ep.on("error", (e: Error) => asyncErrors.push(e.message));
    await ep.start();

    const bound = ep;
    return {
      ...deliverySeams(bound, { shard: SHARD, ttlMs: o.ttlMs, deadlineMs: PROBE_DEADLINE_MS, now: o.now }),
      asyncErrors,
      leaseNow: () => bound.readDeliveryLease(SHARD),
      close: async () => { try { await bound.stop(); } catch { /* already closing */ } },
    };
  } catch (e) {
    if (ep) { try { await ep.stop(); } catch { /* already closing */ } }
    return {
      condition: "unreachable",
      detail: `the broker at ${o.servers} could not be reached (${(e as Error).message})`,
    };
  }
}
