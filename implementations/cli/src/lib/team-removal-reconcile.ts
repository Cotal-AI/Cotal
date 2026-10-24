import type { CardMessage, ChannelRemovalAttempt, ChannelRemovalStep, ObservedCardStep, RegistryIdentity } from "./team-channel-removal.js";
import type { AgentRemovalStep, AgentRetirementObservation } from "./team-agent-removal.js";

/** Reconciliation of an unsettled removal intent: pure classification of each original member from
 * its journal and one native observation. A settlement records only what the native state proves.
 * It never authorizes a delete or a stop. A member whose submission has no confirmed outcome stays
 * unknown unless the observation rules out every outcome but one. A member that was never
 * submitted is reported unattempted and is not continued in this phase. */

export type CardSettlement =
  | { ordinal: number; name: string; createdRevision: number; state: "settled"; step: Extract<ChannelRemovalStep, { phase: "deleted" | "absent" | "conflict" | "observed-removed" | "observed-superseded" }> }
  | { ordinal: number; name: string; createdRevision: number; state: "record"; record: ObservedCardStep }
  | { ordinal: number; name: string; createdRevision: number; state: "unknown"; reason: "created-revision-still-current" | "intent-has-no-registry-binding" }
  | { ordinal: number; name: string; createdRevision: number; state: "unattempted" }
  | { ordinal: number; name: string; createdRevision: number; state: "contradiction"; reason: string };

/** The registry the observation came from must be the stream the intent's deletes were issued to. */
export function sameRegistry(intent: ChannelRemovalAttempt, observed: RegistryIdentity): boolean {
  return intent.registry !== undefined && intent.registry.stream === observed.stream && intent.registry.created === observed.created;
}

/** Classify one original card. `message` is the card key's last message, read between two reads of
 * `registry` that named the same stream incarnation; `registry` is the later of the two. */
export function classifyCard(intent: ChannelRemovalAttempt, steps: readonly ChannelRemovalStep[], ordinal: number, message: CardMessage | undefined, registry: RegistryIdentity | undefined): CardSettlement {
  const channel = intent.channels[ordinal]!;
  const base = { ordinal, name: channel.name, createdRevision: channel.createdRevision };
  const own = steps.filter((row) => row.deploymentId === intent.deploymentId && row.ordinal === ordinal);
  const terminal = own.find((row) => row.phase !== "submitted");
  if (terminal) return { ...base, state: "settled", step: terminal as Extract<ChannelRemovalStep, { phase: "deleted" | "absent" | "conflict" | "observed-removed" | "observed-superseded" }> };
  if (!own.some((row) => row.phase === "submitted")) return { ...base, state: "unattempted" };
  // An intent written before registry binding cannot tie any observation to the stream its
  // delete was issued to, so its unconfirmed submissions stay unknown.
  if (!intent.registry) return { ...base, state: "unknown", reason: "intent-has-no-registry-binding" };
  if (!message || !registry) return { ...base, state: "contradiction", reason: "a submitted card has no registry observation" };
  if (!sameRegistry(intent, registry)) return { ...base, state: "contradiction", reason: "the registry stream was recreated or replaced after the intent" };
  // A revision past the stream's last sequence cannot come from this stream incarnation.
  if (message.kind !== "none" && message.revision > registry.lastSeq) return { ...base, state: "contradiction", reason: "the card revision is beyond the registry stream's last sequence" };
  if (message.kind === "put") {
    if (message.revision === channel.createdRevision) return { ...base, state: "unknown", reason: "created-revision-still-current" };
    if (message.revision < channel.createdRevision) return { ...base, state: "contradiction", reason: "the card's last value is older than its returned create revision" };
    return { ...base, state: "record", record: { phase: "observed-superseded", currentRevision: message.revision } };
  }
  if (message.kind === "marker") {
    if (message.revision <= channel.createdRevision) return { ...base, state: "contradiction", reason: "the removal marker does not follow the returned create revision" };
    return { ...base, state: "record", record: { phase: "observed-removed", markerRevision: message.revision, markerOperation: message.operation } };
  }
  // No message at all: the created value was purged or rolled up. Delete markers do not age out of
  // this stream (no marker TTL), so this is never an expired marker.
  return { ...base, state: "record", record: { phase: "observed-removed", markerRevision: null, markerOperation: null } };
}

/** The receipt row for a settled card, or null when the card does not count as removed. */
export function removedCard(settlement: CardSettlement): { name: string; createdRevision: number; outcome: "deleted" | "absent" | "observed-removed"; markerRevision: number | null } | null {
  const step = settlement.state === "settled" ? settlement.step : null;
  if (!step) return null;
  if (step.phase === "deleted") return { name: step.name, createdRevision: step.createdRevision, outcome: "deleted", markerRevision: step.markerRevision };
  if (step.phase === "absent") return { name: step.name, createdRevision: step.createdRevision, outcome: "absent", markerRevision: step.markerRevision };
  if (step.phase === "observed-removed") return { name: step.name, createdRevision: step.createdRevision, outcome: "observed-removed", markerRevision: step.markerRevision };
  return null;
}

/** One original incarnation's row from the pinned manager's exact-name `slots` read. */
export interface SlotRow {
  name: string; owner: string; actor: string; slotLifecycleUid: string; slotPhase: string; cleanupComplete?: boolean;
  slotRevision: number; headState?: string; headLifecycleUid?: string; headRevision?: number; live: boolean; managerInstanceId: string;
}
export interface OriginalAgent { name: string; id: string; lifecycleUid: string }

export type AgentSettlement =
  | { ordinal: number; agent: OriginalAgent; state: "settled" }
  | { ordinal: number; agent: OriginalAgent; state: "record"; requestId: string; observation: AgentRetirementObservation }
  | { ordinal: number; agent: OriginalAgent; state: "in-progress"; slotPhase: string; headState: string | null }
  | { ordinal: number; agent: OriginalAgent; state: "unknown"; reason: "original-incarnation-still-live" | "original-slot-active-without-live-process" | "retired-without-cleanup-proof" | "alias-names-a-successor" }
  | { ordinal: number; agent: OriginalAgent; state: "unattempted" }
  | { ordinal: number; agent: OriginalAgent; state: "contradiction"; reason: string };

/** Classify one original incarnation from its journal and the pinned manager's slot row.
 * `slot` is the exact-name row (`includeRetired`), or undefined when the bounded read returned no
 * row for that name. Process presence never settles anything; only the durable retired slot and
 * head of the original lifecycle UID, with cleanup complete, do. */
export function classifyAgent(input: { ordinal: number; agent: OriginalAgent; owner: string; manager: string; managerEpoch: number; steps: readonly AgentRemovalStep[]; deploymentId: string; slot: SlotRow | undefined; observedAt: string }): AgentSettlement {
  const { ordinal, agent, owner, manager, managerEpoch, slot } = input;
  const own = input.steps.filter((row) => row.deploymentId === input.deploymentId && row.ordinal === ordinal);
  if (own.some((row) => row.phase === "retired")) return { ordinal, agent, state: "settled" };
  const submitted = own.find((row): row is Extract<AgentRemovalStep, { phase: "submitted" }> => row.phase === "submitted");
  if (!submitted) return { ordinal, agent, state: "unattempted" };
  if (!slot) return { ordinal, agent, state: "contradiction", reason: "the original manager returned no durable slot for a submitted incarnation" };
  if (slot.name !== agent.name || slot.owner !== owner || slot.managerInstanceId !== manager) return { ordinal, agent, state: "contradiction", reason: "the slot row is foreign to the original manager or owner" };
  if (slot.slotLifecycleUid !== agent.lifecycleUid || slot.actor !== agent.id) {
    // A successor may only CAS over a retired slot, but this read cannot return the superseded
    // incarnation's head or revisions, so the original stays unknown: no native read returns them.
    return { ordinal, agent, state: "unknown", reason: "alias-names-a-successor" };
  }
  const retired = slot.slotPhase === "retired" && slot.cleanupComplete === true && slot.headState === "retired" && slot.headLifecycleUid === agent.lifecycleUid && slot.live === false
    && Number.isSafeInteger(slot.slotRevision) && slot.slotRevision > 0 && Number.isSafeInteger(slot.headRevision) && slot.headRevision! > 0;
  if (retired) return { ordinal, agent, state: "record", requestId: submitted.requestId, observation: { name: agent.name, id: agent.id, lifecycleUid: agent.lifecycleUid, managerInstanceId: manager, managerEpoch, slotRevision: slot.slotRevision, headRevision: slot.headRevision!, cleanupComplete: true, slotPhase: "retired", headState: "retired", observedAt: input.observedAt } };
  if (slot.slotPhase === "terminalizing" || slot.headState === "retiring") return { ordinal, agent, state: "in-progress", slotPhase: slot.slotPhase, headState: slot.headState ?? null };
  // A retired slot without cleanup or a matching retired head is not proof; it may never change.
  if (slot.slotPhase === "retired") return { ordinal, agent, state: "unknown", reason: "retired-without-cleanup-proof" };
  if (slot.slotPhase === "active") return { ordinal, agent, state: "unknown", reason: slot.live ? "original-incarnation-still-live" : "original-slot-active-without-live-process" };
  return { ordinal, agent, state: "contradiction", reason: `the original slot is ${slot.slotPhase}, which a submitted stop cannot explain` };
}
