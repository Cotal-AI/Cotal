/**
 * GUARDED DEREGISTRATION of a service instance whose host is gone (SPEC 13.5: a deleted `svc` spec
 * IS the deregistration).
 *
 * THE STATE THIS REPAIRS. The service registry records REGISTRATION, not liveness, and no part of
 * the model expires a row. An instance registers, its host dies without writing anything, and the
 * record goes on claiming a live instance for as long as the bucket exists. Every class scatter in
 * that space then freezes the dead slot in, and a gather that ends only when every slot has answered
 * pays its whole deadline waiting for a machine that is never coming back — on every `cotal ps`,
 * `stop` and `attach`, forever. A registration whose holder cooperates removes itself on a clean
 * stop; this is the exit for the one that cannot, and it exists so that state can never be permanent
 * on someone's laptop again.
 *
 * IT IS AN EXPLICIT VERB AND NEVER A SWEEP. Nothing here scans for candidates or acts on an age
 * threshold: silence is not death, and a rule that deleted rows on silence would eventually delete a
 * live instance that was merely slow. An operator names one instance, and the guard's job is to make
 * sure they did not name a live one:
 *
 *   1. ASK THE INSTANCE. A pinned `describe` is the one question every endpoint must answer (§13.7),
 *      so an answer is proof of life and REFUSES, unconditionally.
 *   2. REPORT WHAT THE BROKER SAYS, without letting it decide. The broker's no-responders verdict on
 *      the instance's own rail is affirmative evidence of absence and is printed, but it does not
 *      authorize anything on its own: the operator's naming of the instance is the authority here,
 *      and the probe is what shows them they are right.
 *   3. REFUSE LOUD, BY CONDITION. "Refused" without a reason sends an operator to the wrong repair.
 *
 * A PROBE THAT COULD NOT RUN IS NOT A DEAD INSTANCE. Only "asked, nothing came back" passes the
 * guard; a refused publish, an unreadable store, or any other failure of the probe itself refuses,
 * because none of them establish anything about the instance.
 *
 * THIS IS NOT A ONE-WAY DOOR, which is what makes the guard a proportionate one rather than an
 * absolute one. The §13.1 issuance gate is untouched: the same instance re-registers on its next
 * start, over the tombstone, under the same identity. Deregistering a live-but-wedged instance costs
 * it its rows until it restarts; leaving a dead one costs every operator in the space a full deadline
 * on every command, permanently.
 */
import {
  deregisterServiceInstance, describeEndpoint, epProbeInstanceInterest, unansweredRequest,
  type EpCaller, type ServiceDeregistration,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";

/** Which guard refused. Printed verbatim by the command and asserted on by the smoke, so one
 *  refusal can never be mistaken for another. */
export type InstanceDeregisterCondition =
  /** The instance ANSWERED a pinned describe: it is alive and this is never run against a live one. */
  | "instance-answered"
  /** The probe itself failed (refused, unreadable, or any non-silence error) — nothing established. */
  | "liveness-unestablishable"
  /** No live spec key at the coordinate: never registered, or already deregistered. */
  | "not-registered"
  /** A key moved between the read and its revision-pinned delete: a live writer owns this record. */
  | "superseded";

/** A refusal carrying its condition as DATA, not only as prose. */
export class InstanceDeregisterRefused extends Error {
  constructor(
    readonly condition: InstanceDeregisterCondition,
    message: string,
  ) {
    super(message);
    this.name = "InstanceDeregisterRefused";
  }
}

/** What the instance probe established. `answered` is the only value that refuses; `detail` is
 *  printed either way so the operator sees the evidence the decision rested on. */
export type InstanceProbe =
  | { state: "answered"; detail: string }
  | { state: "silent"; detail: string }
  | { state: "unestablishable"; detail: string };

/**
 * THE GUARD'S PROBE, built once and used by both the command and its suite — a test that rebuilt
 * this by hand would be grading a copy while the shipped one drifted.
 *
 * `nc` must carry a credential PINNED to this instance: both questions ride its own `inst` rails.
 *
 * Two questions, one verdict. The describe is the DECIDING one, because §13.7 makes every endpoint
 * serve it, so an answer is proof of life. The broker's rail check is REPORTED and decides nothing:
 * it is affirmative evidence of absence and an operator should see it, but the authority to remove
 * a record is the operator naming the instance, not a 503.
 *
 * ONLY SILENCE PASSES. `unansweredRequest` is core's marker for "no responder, or the deadline
 * elapsed with nothing attributed"; every other failure — a refused publish, an unreadable contract
 * store, an error reply — established nothing about the instance and must not read as death.
 */
export function makeInstanceProbe(
  nc: NatsConnection,
  args: { space: string; endpoint: string; instanceId: string; caller: EpCaller; describeDeadlineMs?: number; interestDeadlineMs?: number },
): () => Promise<InstanceProbe> {
  const describeMs = args.describeDeadlineMs ?? 5_000;
  const interestMs = args.interestDeadlineMs ?? 2_000;
  return async (): Promise<InstanceProbe> => {
    try {
      const { responder } = await describeEndpoint(nc, args.space, args.endpoint, args.caller, { deadlineMs: describeMs, instanceId: args.instanceId });
      return { state: "answered", detail: `it answered a pinned describe at epoch ${responder.epoch}` };
    } catch (e) {
      if (!unansweredRequest(e)) return { state: "unestablishable", detail: `the probe itself failed: ${(e as Error).message}` };
      const interest = await epProbeInstanceInterest(nc, args.space, args.endpoint, args.instanceId, args.caller, { deadlineMs: interestMs })
        .catch((err: unknown) => `probe failed: ${(err as Error).message}`);
      const said =
        interest === "gone"
          ? "and the broker reports nothing subscribed on its rail"
          : interest === "unknown"
            ? "and the broker did not answer about its rail either"
            : `and the broker's rail check was inconclusive (${String(interest)})`;
      return { state: "silent", detail: `no answer to a pinned describe within ${describeMs}ms, ${said}` };
    }
  };
}

/** What was removed. Returned on success and printed by the command. */
export interface InstanceDeregisterReport {
  endpoint: string;
  instanceId: string;
  probe: InstanceProbe;
  /** Present when the record had a status key; absent when only a spec existed. */
  removedStatusRevision?: number;
  removedSpecRevision: number;
}

/**
 * Deregister ONE instance. Every seam is injected so the command wires the real ones and the smoke
 * drives the real records KV against an ephemeral broker.
 *
 * `probeInstance` runs BEFORE the KV is touched, and that ordering is structural rather than
 * conventional: nothing below is reachable until it has returned `silent`.
 */
export async function deregisterEndpointInstance(opts: {
  kv: KV;
  endpoint: string;
  instanceId: string;
  probeInstance: () => Promise<InstanceProbe>;
  log: (line: string) => void;
}): Promise<InstanceDeregisterReport> {
  const { kv, endpoint, instanceId, log } = opts;

  // ---- 1. THE GUARD. Read-only, and nothing is mutated until it passes.
  const probe = await opts.probeInstance();
  log(`instance ${endpoint}/${instanceId}: ${probe.state} - ${probe.detail}`);
  if (probe.state === "answered")
    throw new InstanceDeregisterRefused(
      "instance-answered",
      `${endpoint}/${instanceId} ANSWERED (${probe.detail}) - it is alive, and a live instance is never deregistered. If it is wedged rather than gone, stop the process first; its record is then removed by its own clean stop, or by re-running this once it is down.`,
    );
  if (probe.state === "unestablishable")
    throw new InstanceDeregisterRefused(
      "liveness-unestablishable",
      `the liveness of ${endpoint}/${instanceId} could not be established (${probe.detail}) - the probe failed rather than went unanswered, so nothing was learned about the instance. Refusing: this removes a record only on "asked, and nothing came back".`,
    );

  // ---- 2. The §13.5 delete, revision-pinned inside (status first, then spec).
  const outcome: ServiceDeregistration = await deregisterServiceInstance(kv, { endpoint, instanceId });
  if (!outcome.removed && outcome.reason === "absent")
    throw new InstanceDeregisterRefused(
      "not-registered",
      `${endpoint}/${instanceId} has no registration to remove - it never registered, or it was already deregistered. Check the instance id: \`cotal ps\` prints the whole id, and this takes nothing shorter.`,
    );
  if (!outcome.removed)
    throw new InstanceDeregisterRefused(
      "superseded",
      `the registration for ${endpoint}/${instanceId} MOVED while this ran, so the record inspected is not the record now stored - something is writing to it. Nothing was removed. Re-observe before retrying.`,
    );

  log(`✓ removed the ${endpoint} registration for ${instanceId} (spec revision ${outcome.specRevision}${outcome.statusRevision !== undefined ? `, status revision ${outcome.statusRevision}` : ", no status key"})`);
  return {
    endpoint, instanceId, probe,
    removedSpecRevision: outcome.specRevision,
    ...(outcome.statusRevision !== undefined ? { removedStatusRevision: outcome.statusRevision } : {}),
  };
}
