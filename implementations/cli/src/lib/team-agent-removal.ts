import { readdirSync } from "node:fs";
import { join } from "node:path";
import { contractDigest } from "@cotal-ai/core";
import { canonicalRoot } from "@cotal-ai/workspace";
import { z } from "zod";
import type { AdditiveAgentReceipt, AdditiveTeamAttempt, AdditiveTeamReceipt } from "./team-additive-attempt.js";
import { publishRemovalRecord as publish, readRemovalRecord as read, removalRecordDirectory as directory } from "./team-removal-record.js";

const ID = /^[a-f0-9]{16}$/;
const uid = z.string().regex(/^[a-z0-9]{26,32}$/);
const Intent = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("additive-agent-removal-attempt"), deploymentId: z.string().regex(ID),
  root: z.string().min(1), space: z.string().min(1), managerInstanceId: uid,
  originalReceiptDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), createdAt: z.iso.datetime(),
});
const Retired = z.strictObject({
  name: z.string().min(1), id: z.string().min(1), lifecycleUid: uid, managerInstanceId: uid,
  managerEpoch: z.number().int().nonnegative(), slotRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  headRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), cleanupComplete: z.literal(true),
  slotPhase: z.literal("retired"), headState: z.literal("retired"), observedAt: z.iso.datetime(),
});
export type AgentRetirementObservation = z.infer<typeof Retired>;
const Step = z.discriminatedUnion("phase", [
  z.strictObject({ schemaVersion: z.literal(1), deploymentId: z.string().regex(ID), ordinal: z.number().int().min(0).max(99), phase: z.literal("submitted"), requestId: z.uuid(), recordedAt: z.iso.datetime() }),
  z.strictObject({ schemaVersion: z.literal(1), deploymentId: z.string().regex(ID), ordinal: z.number().int().min(0).max(99), phase: z.literal("retired"), requestId: z.uuid().optional(), observation: Retired, recordedAt: z.iso.datetime() }),
]);
const Receipt = Intent.omit({ kind: true, createdAt: true }).extend({ kind: z.literal("additive-agent-removal-receipt"), retiredAgents: z.array(Retired).min(1).max(100), recordedAt: z.iso.datetime() });
export type AgentRemovalAttempt = z.infer<typeof Intent>;
export type AgentRemovalStep = z.infer<typeof Step>;
export type AgentRemovalReceipt = z.infer<typeof Receipt>;
export interface AgentRemovalInventory { attempts: AgentRemovalAttempt[]; steps: AgentRemovalStep[]; returned: AgentRemovalReceipt[]; refused: { path: string; why: string }[] }
const intentName = (id: string) => `team-remove-attempt-${id}.json`;
const receiptName = (id: string) => `team-remove-returned-${id}.json`;
const stepName = (id: string, ordinal: number, phase: AgentRemovalStep["phase"]) => `team-remove-step-${id}-${ordinal}-${phase}.json`;
const STEP_NAME = /^team-remove-step-([a-f0-9]{16})-(0|[1-9][0-9]?)-(submitted|retired)\.json$/;

function originalFor(root: string, id: string, attempts: readonly AdditiveTeamAttempt[], receipts: readonly AdditiveTeamReceipt[]): { attempt: AdditiveTeamAttempt; receipt: AdditiveAgentReceipt } {
  const attempt = attempts.find((row) => row.deploymentId === id), receipt = receipts.find((row) => row.deploymentId === id);
  // Agent-only, or mixed with its full returned card list; the mixed card phase has its own journal.
  const shape = receipt?.kind === "additive-agent-receipt" ? !receipt.createdChannels.length && !attempt?.declaredChannels.length
    : receipt?.kind === "additive-team-receipt" && receipt.createdChannels.length > 0 && receipt.createdChannels.length <= 100 && receipt.createdChannels.length === attempt?.declaredChannels.length;
  if (!attempt || !receipt || receipt.kind === "additive-channel-receipt" || !shape || receipt.authMode !== "auth" || !attempt.managerInstanceId || receipt.createdAgents.length > 100 || canonicalRoot(attempt.root) !== canonicalRoot(root)) throw new Error("removal has no matching static agent-only or mixed returned deployment");
  return { attempt, receipt };
}
function matches(intent: AgentRemovalAttempt | AgentRemovalReceipt, original: ReturnType<typeof originalFor>): boolean {
  return intent.root === original.attempt.root && intent.space === original.attempt.space && intent.managerInstanceId === original.attempt.managerInstanceId && intent.originalReceiptDigest === contractDigest(original.receipt);
}
function matchesAgent(observation: AgentRetirementObservation, agent: AdditiveAgentReceipt["createdAgents"][number], manager: string): boolean {
  return observation.name === agent.name && observation.id === agent.id && observation.lifecycleUid === agent.lifecycleUid && observation.managerInstanceId === manager;
}

/** Removal history is never authority to stop a name. Only a full original-receipt-bound sequence
 * can release the root's known additive blocker; malformed and orphan records stay blocking. */
export function readAgentTeamRemovals(root: string, attempts: readonly AdditiveTeamAttempt[], receipts: readonly AdditiveTeamReceipt[]): AgentRemovalInventory {
  const inventory: AgentRemovalInventory = { attempts: [], steps: [], returned: [], refused: [] };
  // `team-channel-remove-*` records belong to the channel removal reader, not this prefix.
  const dir = directory(root), files = readdirSync(dir).filter((name) => name.startsWith("team-remove-") && name.endsWith(".json")).sort();
  for (const name of files.filter((name) => name.startsWith("team-remove-attempt-"))) {
    const path = join(dir, name);
    try {
      const value = Intent.parse(read(path));
      if (name !== intentName(value.deploymentId) || !matches(value, originalFor(root, value.deploymentId, attempts, receipts))) throw new Error("removal intent differs from original deployment");
      inventory.attempts.push(value);
    } catch { inventory.refused.push({ path, why: "the removal intent or its original deployment is unreadable" }); }
  }
  for (const name of files.filter((name) => name.startsWith("team-remove-step-"))) {
    const path = join(dir, name);
    try {
      const filename = STEP_NAME.exec(name), value = Step.parse(read(path));
      const intent = inventory.attempts.find((row) => row.deploymentId === value.deploymentId);
      const original = originalFor(root, value.deploymentId, attempts, receipts), agent = original.receipt.createdAgents[value.ordinal];
      if (!filename || name !== stepName(value.deploymentId, value.ordinal, value.phase) || !intent || !agent || value.phase === "retired" && !matchesAgent(value.observation, agent, intent.managerInstanceId)) throw new Error("removal step differs from intent");
      if (value.phase === "retired") {
        const submitted = inventory.steps.find((row) => row.deploymentId === value.deploymentId && row.ordinal === value.ordinal && row.phase === "submitted");
        // The sorted file list puts retired before submitted, so read a named submission directly.
        if (value.requestId !== undefined) {
          const prior = submitted ?? Step.parse(read(join(dir, stepName(value.deploymentId, value.ordinal, "submitted"))));
          if (prior.phase !== "submitted" || prior.deploymentId !== value.deploymentId || prior.ordinal !== value.ordinal || prior.requestId !== value.requestId) throw new Error("retirement has no original stop request");
        } else if (files.includes(stepName(value.deploymentId, value.ordinal, "submitted"))) throw new Error("retirement omitted a recorded stop request");
      }
      inventory.steps.push(value);
    } catch { inventory.refused.push({ path, why: "the removal step or native retirement coordinates are unreadable" }); }
  }
  for (const name of files.filter((name) => name.startsWith("team-remove-returned-"))) {
    const path = join(dir, name);
    try {
      const value = Receipt.parse(read(path)), original = originalFor(root, value.deploymentId, attempts, receipts);
      const intent = inventory.attempts.find((row) => row.deploymentId === value.deploymentId);
      const steps = inventory.steps.filter((row) => row.deploymentId === value.deploymentId && row.phase === "retired");
      if (name !== receiptName(value.deploymentId) || !intent || !matches(value, original) || value.retiredAgents.length !== original.receipt.createdAgents.length || steps.length !== value.retiredAgents.length || inventory.refused.some((row) => row.path.includes(value.deploymentId)) || !value.retiredAgents.every((row, ordinal) => matchesAgent(row, original.receipt.createdAgents[ordinal]!, value.managerInstanceId) && steps.filter((step) => step.ordinal === ordinal && step.phase === "retired" && JSON.stringify(step.observation) === JSON.stringify(row)).length === 1)) throw new Error("removal receipt does not settle the original incarnations");
      inventory.returned.push(value);
    } catch { inventory.refused.push({ path, why: "the removal receipt does not settle the original deployment" }); }
  }
  for (const name of files.filter((name) => !name.startsWith("team-remove-attempt-") && !name.startsWith("team-remove-step-") && !name.startsWith("team-remove-returned-"))) inventory.refused.push({ path: join(dir, name), why: "the removal record name is unsupported" });
  return inventory;
}

export function writeAgentRemovalAttempt(root: string, attempt: AdditiveTeamAttempt, receipt: AdditiveAgentReceipt): AgentRemovalAttempt {
  const original = originalFor(root, attempt.deploymentId, [attempt], [receipt]);
  const value = Intent.parse({ schemaVersion: 1, kind: "additive-agent-removal-attempt", deploymentId: attempt.deploymentId, root: attempt.root, space: attempt.space, managerInstanceId: original.attempt.managerInstanceId, originalReceiptDigest: contractDigest(receipt), createdAt: new Date().toISOString() });
  publish(root, intentName(value.deploymentId), value);
  return value;
}
export function writeAgentRemovalStep(root: string, intent: AgentRemovalAttempt, ordinal: number, value: { phase: "submitted"; requestId: string } | { phase: "retired"; requestId?: string; observation: AgentRetirementObservation }): void {
  if (JSON.stringify(Intent.parse(read(join(directory(root), intentName(intent.deploymentId))))) !== JSON.stringify(intent)) throw new Error("removal intent changed");
  const step = Step.parse({ schemaVersion: 1, deploymentId: intent.deploymentId, ordinal, ...value, recordedAt: new Date().toISOString() });
  publish(root, stepName(intent.deploymentId, ordinal, step.phase), step);
}
export function writeAgentRemovalReceipt(root: string, intent: AgentRemovalAttempt, retiredAgents: readonly AgentRetirementObservation[]): void {
  const { kind: _kind, createdAt: _created, ...common } = intent;
  publish(root, receiptName(intent.deploymentId), Receipt.parse({ ...common, kind: "additive-agent-removal-receipt", retiredAgents, recordedAt: new Date().toISOString() }));
}
