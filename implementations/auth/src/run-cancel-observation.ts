import { createHash } from "node:crypto";
import {
  EpEnvelopeError, canonicalJson, parseEpSubject, parseEndpointRequest, checkRequestSubjectAgreement,
  isIssuedCaller, readRunCancelInput, RUN_CANCEL_MAX_DEADLINE_MS,
} from "@cotal-ai/core";

export interface RunCancelObservation {
  readonly subject: string;
  readonly id: string;
  readonly runId: string;
  readonly reason: string;
  readonly class: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly instanceId: string;
  readonly processEpoch: number;
  readonly requestEndsAt: number;
}
export interface RunCancelLimits { caller: number; owner: number; total: number }
type State = "available" | "claimed" | "consumed" | "expired" | "conflicted";
type Entry = {
  readonly fingerprint: string;
  readonly requestEndsAt: number;
  state: State;
  observation?: RunCancelObservation;
  claim?: symbol;
  mayHaveDispatched: boolean;
};
export interface RunCancelClaim {
  readonly observation: RunCancelObservation;
  /** Validate custody without making a dispatch claim, including when a marker already exists. */
  assertCurrent(): void;
  /** Last synchronous guard, invoked at the actual marker writer's dispatch boundary. */
  dispatch(): void;
  /** Consume a claim that refused or completed. A conflicting redelivery stays poisoned. */
  finish(): void;
}

/** Process-lifetime observation custody, not cross-restart deduplication. Tombstones count against
 *  finite caller/owner/global quotas and are never evicted or made available again. */
export class RunCancelObservations {
  private readonly entries = new Map<string, Entry>();
  private readonly callers = new Map<string, number>();
  private readonly owners = new Map<string, number>();
  private readonly limits: Readonly<RunCancelLimits>;

  constructor(private readonly space: string, limits: RunCancelLimits = { caller: 64, owner: 256, total: 10_000 }, private readonly now = () => performance.now()) {
    if (![limits.caller, limits.owner, limits.total].every(n => Number.isSafeInteger(n) && n > 0)
      || limits.caller > limits.owner || limits.owner >= limits.total)
      throw new Error("run-cancel custody limits require 0 < caller <= owner < total");
    this.limits = Object.freeze({ ...limits });
  }

  private coordinates(subject: string): { caller: string; owner: string; instanceId: string } | undefined {
    const parsed = parseEpSubject(subject);
    if (!subject.startsWith(`cotal.${this.space}.`) || !parsed || parsed.plane !== "request" || parsed.rail !== "v1"
      || parsed.route !== "inst" || parsed.endpoint !== "manager" || parsed.command !== "run-cancel"
      || parsed.target !== null || !isIssuedCaller(parsed.caller)) return undefined;
    return { caller: canonicalJson([parsed.caller.owner, parsed.caller.actor, parsed.caller.uid]), owner: parsed.caller.owner, instanceId: parsed.instanceId! };
  }

  /** Decode the same JSON/string shape as the serving seam. Invalid input grants no observation. */
  observe(subject: string, data: Uint8Array): void {
    const coordinates = this.coordinates(subject);
    if (!coordinates) return;
    let observation: RunCancelObservation;
    let fingerprint: string;
    try {
      const parsed = parseEpSubject(subject)!;
      if (parsed.plane !== "request") return;
      const envelope = parseEndpointRequest(JSON.parse(new TextDecoder().decode(data)));
      checkRequestSubjectAgreement(envelope, parsed);
      const input = readRunCancelInput(envelope.args);
      if (!Number.isSafeInteger(envelope.deadlineMs) || envelope.deadlineMs! <= 0 || envelope.deadlineMs! > RUN_CANCEL_MAX_DEADLINE_MS
        || !envelope.bind || envelope.bind.instanceId !== coordinates.instanceId
        || envelope.class !== "ephemeral" || typeof envelope.op.inputDigest !== "string" || typeof envelope.op.outputDigest !== "string") return;
      fingerprint = createHash("sha256").update(canonicalJson({ id: envelope.id, args: input, class: envelope.class,
        op: envelope.op, bind: envelope.bind, deadlineMs: envelope.deadlineMs })).digest("hex");
      observation = Object.freeze({ subject, id: envelope.id, ...input, class: envelope.class,
        inputDigest: envelope.op.inputDigest, outputDigest: envelope.op.outputDigest,
        instanceId: envelope.bind.instanceId, processEpoch: envelope.bind.epoch,
        requestEndsAt: this.now() + envelope.deadlineMs! });
    } catch { return; }
    const prior = this.entries.get(subject);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        prior.state = "conflicted";
        delete prior.observation;
      } else this.expire(prior);
      return;
    }
    if (this.full(coordinates)) return;
    this.entries.set(subject, { fingerprint, requestEndsAt: observation.requestEndsAt, state: "available", observation, mayHaveDispatched: false });
    this.callers.set(coordinates.caller, (this.callers.get(coordinates.caller) ?? 0) + 1);
    this.owners.set(coordinates.owner, (this.owners.get(coordinates.owner) ?? 0) + 1);
  }

  private full(coordinates: { caller: string; owner: string }): boolean {
    return this.entries.size >= this.limits.total || (this.callers.get(coordinates.caller) ?? 0) >= this.limits.caller
      || (this.owners.get(coordinates.owner) ?? 0) >= this.limits.owner;
  }

  private expire(entry: Entry): void {
    if (entry.state === "available" && this.now() >= entry.requestEndsAt) {
      entry.state = "expired";
      delete entry.observation;
    }
  }

  refusal(subject: string): { kind: "refused-before-dispatch" | "outcome-unknown"; code: "permission-denied" | "resource-exhausted" | "failed-precondition" | "deadline-exceeded" } {
    const entry = this.entries.get(subject);
    if (entry) {
      this.expire(entry);
      return { kind: entry.mayHaveDispatched || entry.state === "claimed" || entry.claim !== undefined ? "outcome-unknown" : "refused-before-dispatch",
        code: entry.state === "expired" ? "deadline-exceeded" : "failed-precondition" };
    }
    const coordinates = this.coordinates(subject);
    return { kind: "refused-before-dispatch", code: coordinates && this.full(coordinates) ? "resource-exhausted" : "permission-denied" };
  }

  inspect(subject: string): RunCancelObservation {
    const entry = this.entries.get(subject);
    if (entry) this.expire(entry);
    if (!entry || entry.state !== "available" || !entry.observation)
      throw new EpEnvelopeError(this.refusal(subject).code, "run-cancel observation is not available");
    return entry.observation;
  }

  claim(subject: string): RunCancelClaim {
    const observation = this.inspect(subject);
    const entry = this.entries.get(subject)!;
    const token = Symbol();
    entry.state = "claimed";
    entry.claim = token;
    const assertCurrent = (): void => {
      if (entry.state !== "claimed" || entry.claim !== token)
        throw new EpEnvelopeError("failed-precondition", "run-cancel observation was consumed or conflicted");
      if (this.now() >= entry.requestEndsAt) {
        entry.state = "expired";
        throw new EpEnvelopeError("deadline-exceeded", "run-cancel original observation deadline expired");
      }
    };
    return {
      observation,
      assertCurrent,
      dispatch: () => {
        assertCurrent();
        entry.state = "consumed";
        entry.mayHaveDispatched = true;
        delete entry.observation;
      },
      finish: () => {
        if (entry.claim !== token) return;
        delete entry.claim;
        if (entry.state === "claimed") entry.state = "consumed";
        delete entry.observation;
      },
    };
  }
}
