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
 *   2. REQUIRE THE BROKER'S AFFIRMATIVE ABSENCE. Only a no-responders verdict on the instance's own
 *      rail — nothing subscribed there — passes the guard. It is the same evidence `cotal ps` acts
 *      on, and it is the whole difference between "gone" and "quiet".
 *   3. REFUSE LOUD, BY CONDITION. "Refused" without a reason sends an operator to the wrong repair.
 *
 * SILENCE IS NOT THE EVIDENCE. An unanswered describe is what a dead host, a wedged process and a
 * slow one all look like, and a process that is merely hung still HOLDS its subscriptions — so the
 * broker sees interest on its rail and cannot affirm it empty. That instance is refused, and the
 * operator is told what was observed. A dead process has no connection and therefore no
 * subscription, so every real corpse is still removed; a hung manager can never be deregistered out
 * from under itself by an operator who cannot see it.
 *
 * A PROBE THAT COULD NOT RUN IS NOT A DEAD INSTANCE either: a refused publish, an unreadable store,
 * or any other failure of the probe itself refuses, because none of them establish anything about
 * the instance.
 *
 * THIS IS NOT A ONE-WAY DOOR, which is what makes the guard a proportionate one rather than an
 * absolute one. The §13.1 issuance gate is untouched: the same instance re-registers on its next
 * start, over the tombstone, under the same identity. Deregistering a live-but-wedged instance costs
 * it its rows until it restarts; leaving a dead one costs every operator in the space a full deadline
 * on every command, permanently.
 */
import {
  deregisterServiceInstance, describeEndpoint, epProbeInstanceInterest, unansweredRequest,
  type EpCaller, type EpInstanceLiveness, type ServiceDeregistration,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";

/** Which guard refused. Printed verbatim by the command and asserted on by the smoke, so one
 *  refusal can never be mistaken for another. */
export type InstanceDeregisterCondition =
  /** The instance ANSWERED a pinned describe: it is alive and this is never run against a live one. */
  | "instance-answered"
  /** It did not answer, and the broker did NOT affirm its rail empty, which is what a held
   *  subscription looks like: a hung or slow instance rather than a departed host, and the one
   *  observation this command may not act on. Nothing is removed. */
  | "instance-not-affirmed-gone"
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

/** What the instance probe established. `gone` is the ONLY value that removes anything; `detail` is
 *  printed whichever it is, so the operator sees the evidence the decision rested on. */
export type InstanceProbe =
  /** It answered a pinned describe. Alive. */
  | { state: "answered"; detail: string }
  /** It did not answer AND the broker reports nothing subscribed on its rail. Affirmatively absent. */
  | { state: "gone"; detail: string }
  /** It did not answer, and the broker did not affirm the rail empty: quiet, not gone. */
  | { state: "unknown"; detail: string }
  /** The probe itself could not run, so nothing at all was established about the instance. */
  | { state: "unestablishable"; detail: string };

/**
 * THE GUARD'S PROBE, built once and used by both the command and its suite — a test that rebuilt
 * this by hand would be grading a copy while the shipped one drifted.
 *
 * `nc` must carry a credential PINNED to this instance: both questions ride its own `inst` rails.
 *
 * TWO QUESTIONS, AND BOTH MUST AGREE for the one verdict that licenses a delete. The describe is
 * the disqualifying one, because §13.7 makes every endpoint serve it, so an answer is proof of
 * life. The broker's rail check is the AUTHORIZING one: `gone` means the broker found nothing
 * subscribed on this instance's rail, which is the only affirmative evidence of absence anything
 * here can obtain without the instance's cooperation.
 *
 * A DESCRIBE THAT WENT UNANSWERED IS NOT A VERDICT BY ITSELF. `unansweredRequest` is core's marker
 * for "no responder, or the deadline elapsed with nothing attributed", and a wedged process
 * produces it while still holding every subscription it registered. So an unanswered describe whose
 * rail check comes back anything other than `gone` is `unknown` — quiet, not absent. Every other
 * failure — a refused publish, an unreadable contract store, an error reply, a rail check that
 * could not run — established nothing about the instance and must not read as death.
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
      const silence = `no answer to a pinned describe within ${describeMs}ms`;
      let interest: EpInstanceLiveness;
      try {
        interest = await epProbeInstanceInterest(nc, args.space, args.endpoint, args.instanceId, args.caller, { deadlineMs: interestMs });
      } catch (err) {
        // The rail check is what turns silence into a verdict, so a rail check that could not RUN
        // leaves the silence meaning exactly what it meant before it: nothing.
        return { state: "unestablishable", detail: `${silence}, and the broker's rail check could not run: ${(err as Error).message}` };
      }
      return interest === "gone"
        ? { state: "gone", detail: `${silence}, and the broker reports nothing subscribed on its rail` }
        : {
            state: "unknown",
            detail: `${silence}, and the broker did NOT report its rail empty within ${interestMs}ms - a subscription is exactly what withholds that no-responders answer, so this instance is quiet rather than absent`,
          };
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
 * conventional: nothing below is reachable until it has returned `gone`.
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
  if (probe.state === "unknown")
    throw new InstanceDeregisterRefused(
      "instance-not-affirmed-gone",
      `${endpoint}/${instanceId} did not answer, but the broker did not affirm that its rail is empty (${probe.detail}) - a process that is hung still holds its subscriptions, so this is slow or hung, not gone, and NOTHING WAS REMOVED. A registration is removed only on the broker reporting nothing subscribed on the instance's own rail. If the process is wedged, stop it: its record goes on its own clean stop, or by re-running this once it is down.`,
    );
  if (probe.state === "unestablishable")
    throw new InstanceDeregisterRefused(
      "liveness-unestablishable",
      `the liveness of ${endpoint}/${instanceId} could not be established (${probe.detail}) - the probe failed rather than went unanswered, so nothing was learned about the instance. Refusing: this removes a record only on the broker affirming its rail empty.`,
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
