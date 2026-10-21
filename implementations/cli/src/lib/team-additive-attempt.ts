import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DEV_OWNER, assertValidChannel, isConcreteChannel, realDirNoSymlink, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { canonicalRoot, protectedLocalDirectory } from "@cotal-ai/workspace";
import { z } from "zod";
import { readAgentTeamRemovals, type AgentRemovalInventory } from "./team-agent-removal.js";
import { readChannelTeamRemovals, type ChannelRemovalInventory } from "./team-channel-removal.js";

const ID = /^[a-f0-9]{16}$/;
const MAX_BYTES = 256 * 1024;
const text = z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const Attempt = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("additive-team-attempt"),
  deploymentId: z.string().regex(ID),
  root: text.refine(isAbsolute),
  space: text.refine((value) => value.length <= 200),
  server: text,
  manifestPath: text.refine(isAbsolute),
  manifestHash: z.string().regex(ID),
  authMode: z.enum(["open", "auth", "user"]),
  tlsRequired: z.boolean(),
  declaredChannels: z.array(z.string().min(1)).max(10_000),
  requestedAgents: z.array(z.string().min(1)).max(10_000),
  agentHashes: z.array(z.strictObject({ name: z.string().min(1), hash: z.string().regex(ID) })).max(10_000).optional(),
  managerInstanceId: z.string().regex(/^[a-z0-9]{26,32}$/).optional(),
  createdAt: z.iso.datetime(),
});

export type AdditiveTeamAttempt = z.infer<typeof Attempt>;
const nameFor = (id: string) => `team-deploy-attempt-${id}.json`;
const stepName = (id: string, ordinal: number, phase: "submitted" | "accepted") => `team-deploy-step-${id}-${ordinal}-${phase}.json`;
const STEP_NAME = /^team-deploy-step-([a-f0-9]{16})-(0|[1-9][0-9]{0,3})-(submitted|accepted)\.json$/;
const Step = z.discriminatedUnion("phase", [
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("additive-channel-step"), deploymentId: z.string().regex(ID), ordinal: z.number().int().min(0).max(9_999), name: z.string().min(1), phase: z.literal("submitted"), recordedAt: z.iso.datetime() }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("additive-channel-step"), deploymentId: z.string().regex(ID), ordinal: z.number().int().min(0).max(9_999), name: z.string().min(1), phase: z.literal("accepted"), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), recordedAt: z.iso.datetime() }),
]);
export type AdditiveChannelStep = z.infer<typeof Step>;
const ChannelReceipt = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("additive-channel-receipt"), deploymentId: z.string().regex(ID),
  root: text.refine(isAbsolute), space: text.refine((value) => value.length <= 200), server: text,
  manifestPath: text.refine(isAbsolute), manifestHash: z.string().regex(ID), authMode: z.enum(["open", "auth", "user"]), tlsRequired: z.boolean(),
  createdChannels: z.array(z.strictObject({ name: z.string().min(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).max(10_000),
  recordedAt: z.iso.datetime(),
});
export type AdditiveChannelReceipt = z.infer<typeof ChannelReceipt>;
const RequestReceipt = z.strictObject({
  requestId: z.uuid(), managerInstanceId: z.string().regex(/^[a-z0-9]{26,32}$/), managerEpoch: z.number().int().nonnegative(),
  goalId: z.string().min(1).max(512), fingerprint: z.string().min(1).max(512),
  allocation: z.strictObject({ name: z.string().regex(/^[A-Za-z0-9_-]+$/), owner: z.string().regex(/^[A-Za-z0-9_-]+$/), actor: z.string().regex(/^[A-Za-z0-9_-]+$/), lifecycleUid: z.string().regex(/^[a-z0-9]{26,32}$/) }),
});
const CreatedAgent = z.strictObject({ requested: z.string().min(1), hash: z.string().regex(ID), name: z.string().regex(/^[A-Za-z0-9_-]+$/), id: z.string().min(1).max(512), lifecycleUid: z.string().regex(/^[a-z0-9]{26,32}$/), agent: z.string().min(1).max(200), runtime: z.string().min(1).max(200), request: RequestReceipt });
const AgentReceipt = ChannelReceipt.extend({ kind: z.enum(["additive-agent-receipt", "additive-team-receipt"]), createdAgents: z.array(CreatedAgent).min(1).max(10_000) });
const Receipt = z.discriminatedUnion("kind", [ChannelReceipt, AgentReceipt]);
export type AdditiveAgentReceipt = z.infer<typeof AgentReceipt>;
export const additiveAgentRequestReceipt = (value: unknown) => RequestReceipt.parse(value);
export type AdditiveTeamReceipt = z.infer<typeof Receipt>;
const AgentStep = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("additive-agent-step"), deploymentId: z.string().regex(ID), ordinal: z.number().int().min(0).max(9_999), name: z.string().min(1), hash: z.string().regex(ID),
  phase: z.enum(["submitted", "accepted", "joined"]), requestId: z.uuid(), managerInstanceId: z.string().regex(/^[a-z0-9]{26,32}$/),
  request: RequestReceipt.optional(), joined: CreatedAgent.optional(), recordedAt: z.iso.datetime(),
});
export type AdditiveAgentStep = z.infer<typeof AgentStep>;
const agentStepName = (id: string, ordinal: number, phase: AdditiveAgentStep["phase"]) => `team-deploy-agent-step-${id}-${ordinal}-${phase}.json`;
const AGENT_STEP_NAME = /^team-deploy-agent-step-([a-f0-9]{16})-(0|[1-9][0-9]{0,3})-(submitted|accepted|joined)\.json$/;
const RETURN_SUFFIX = "-returned.json";
const receiptName = (id: string) => `team-deploy-attempt-${id}${RETURN_SUFFIX}`;

function publishSynced(dir: string, path: string, body: string): void {
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("additive record exceeds its size limit");
  writeSecretFileCreateOnly(path, body);
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(dir, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function validate(input: unknown): AdditiveTeamAttempt {
  const value = Attempt.parse(input);
  if (new Set(value.declaredChannels).size !== value.declaredChannels.length || new Set(value.requestedAgents).size !== value.requestedAgents.length) throw new Error("duplicate additive attempt resource name");
  for (const name of value.declaredChannels) {
    assertValidChannel(name);
    if (!isConcreteChannel(name)) throw new Error("additive attempt channel is not concrete");
  }
  if (value.requestedAgents.some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error("additive attempt agent name is not a safe token");
  if (value.requestedAgents.length && (!value.managerInstanceId || value.agentHashes?.length !== value.requestedAgents.length || !value.agentHashes.every((row, index) => row.name === value.requestedAgents[index]))) throw new Error("agent attempt needs the exact manager and ordered resolved hashes");
  return value;
}

/** An immutable root-local intent before any additive native effect. It is not an ownership ledger
 * or permission to resume an uncertain operation. */
export function writeAdditiveTeamAttempt(root: string, attempt: AdditiveTeamAttempt): void {
  const valid = validate(attempt);
  if (canonicalRoot(valid.root) !== canonicalRoot(root)) throw new Error("additive attempt root changed before recording");
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) throw new Error("additive attempt requires a real prepared control directory");
  protectedLocalDirectory(dir);
  publishSynced(dir, join(dir, nameFor(valid.deploymentId)), JSON.stringify(valid, null, 2) + "\n");
}

function readPrivate(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error("not an owned private bounded regular additive record");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw new Error("additive record changed or exceeds its size limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function readAttempt(path: string, id: string, root: string): AdditiveTeamAttempt {
  const parsed = validate(readPrivate(path));
  if (parsed.deploymentId !== id || canonicalRoot(parsed.root) !== canonicalRoot(root)) throw new Error("additive attempt schema, root or full ID differs from its file");
  return parsed;
}

function readStep(path: string, attempt: AdditiveTeamAttempt, ordinal: number, phase: "submitted" | "accepted"): AdditiveChannelStep {
  const step = Step.parse(readPrivate(path));
  if (step.deploymentId !== attempt.deploymentId || step.ordinal !== ordinal || step.phase !== phase || attempt.declaredChannels[ordinal] !== step.name) throw new Error("additive step differs from its original intent or filename");
  return step;
}

/** Persist each channel submission before its native request and its acknowledged revision
 * immediately after a returned create. A missing acceptance remains unknown, never retryable. */
export function writeAdditiveChannelStep(root: string, attempt: AdditiveTeamAttempt, ordinal: number, phase: "submitted" | "accepted", revision?: number): void {
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) throw new Error("additive step requires a real prepared control directory");
  protectedLocalDirectory(dir);
  const original = readAttempt(join(dir, nameFor(attempt.deploymentId)), attempt.deploymentId, root);
  if (JSON.stringify(original) !== JSON.stringify(validate(attempt)) || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= original.declaredChannels.length) throw new Error("additive step does not match a published channel intent");
  if (phase === "accepted") readStep(join(dir, stepName(original.deploymentId, ordinal, "submitted")), original, ordinal, "submitted");
  const input = { schemaVersion: 1 as const, kind: "additive-channel-step" as const, deploymentId: original.deploymentId, ordinal, name: original.declaredChannels[ordinal], phase, ...(phase === "accepted" ? { revision } : {}), recordedAt: new Date().toISOString() };
  const step = Step.parse(input);
  publishSynced(dir, join(dir, stepName(original.deploymentId, ordinal, phase)), JSON.stringify(step, null, 2) + "\n");
}

function readReceipt(path: string, id: string, root: string): AdditiveTeamReceipt {
  const receipt = Receipt.parse(readPrivate(path));
  if (receipt.deploymentId !== id || canonicalRoot(receipt.root) !== canonicalRoot(root)) throw new Error("additive receipt root or full ID differs from its file");
  return receipt;
}

/** Settlement records the returned create revisions, never current channel state. The full
 * submission/acceptance sequence must match one channel-only intent in original order. */
export function additiveChannelAttemptSettled(attempt: AdditiveTeamAttempt, receipt: AdditiveTeamReceipt | undefined, steps: readonly AdditiveChannelStep[]): boolean {
  if (!receipt || receipt.kind !== "additive-channel-receipt" || attempt.requestedAgents.length || receipt.deploymentId !== attempt.deploymentId || receipt.root !== attempt.root || receipt.space !== attempt.space || receipt.server !== attempt.server || receipt.manifestPath !== attempt.manifestPath || receipt.manifestHash !== attempt.manifestHash || receipt.authMode !== attempt.authMode || receipt.tlsRequired !== attempt.tlsRequired || receipt.createdChannels.length !== attempt.declaredChannels.length || steps.length !== attempt.declaredChannels.length * 2) return false;
  return channelStepsMatch(attempt, receipt.createdChannels, steps);
}

function channelStepsMatch(attempt: AdditiveTeamAttempt, createdChannels: AdditiveChannelReceipt["createdChannels"], steps: readonly AdditiveChannelStep[]): boolean {
  if (createdChannels.length !== attempt.declaredChannels.length || steps.length !== attempt.declaredChannels.length * 2) return false;
  const byOrdinal = new Map<number, { submitted?: Extract<AdditiveChannelStep, { phase: "submitted" }>; accepted?: Extract<AdditiveChannelStep, { phase: "accepted" }> }>();
  for (const step of steps) {
    if (step.deploymentId !== attempt.deploymentId) return false;
    const row: { submitted?: Extract<AdditiveChannelStep, { phase: "submitted" }>; accepted?: Extract<AdditiveChannelStep, { phase: "accepted" }> } = byOrdinal.get(step.ordinal) ?? {};
    if (step.phase === "submitted") {
      if (row.submitted) return false;
      row.submitted = step;
    } else {
      if (row.accepted) return false;
      row.accepted = step;
    }
    byOrdinal.set(step.ordinal, row);
  }
  return attempt.declaredChannels.every((name, ordinal) => createdChannels[ordinal]?.name === name
    && byOrdinal.get(ordinal)?.submitted?.name === name
    && byOrdinal.get(ordinal)?.accepted?.name === name
    && byOrdinal.get(ordinal)?.accepted?.revision === createdChannels[ordinal]?.revision);
}

export function writeAdditiveChannelReceipt(root: string, attempt: AdditiveTeamAttempt, createdChannels: AdditiveChannelReceipt["createdChannels"]): void {
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) throw new Error("additive receipt requires a real prepared control directory");
  protectedLocalDirectory(dir);
  const original = readAttempt(join(dir, nameFor(attempt.deploymentId)), attempt.deploymentId, root);
  if (JSON.stringify(original) !== JSON.stringify(validate(attempt))) throw new Error("additive receipt does not match its original intent");
  const inventory = listAdditiveTeamAttempts(root);
  if (inventory.refused.length) throw new Error("additive attempt or step inventory is unreadable");
  const receipt = ChannelReceipt.parse({ schemaVersion: 1, kind: "additive-channel-receipt", deploymentId: original.deploymentId, root: original.root, space: original.space, server: original.server, manifestPath: original.manifestPath, manifestHash: original.manifestHash, authMode: original.authMode, tlsRequired: original.tlsRequired, createdChannels, recordedAt: new Date().toISOString() });
  if (!additiveChannelAttemptSettled(original, receipt, inventory.steps.filter((step) => step.deploymentId === original.deploymentId))) throw new Error("additive channel steps do not settle the original intent");
  publishSynced(dir, join(dir, receiptName(original.deploymentId)), JSON.stringify(receipt, null, 2) + "\n");
}

function readAgentStep(path: string, attempt: AdditiveTeamAttempt, ordinal: number, phase: AdditiveAgentStep["phase"]): AdditiveAgentStep {
  const step = AgentStep.parse(readPrivate(path));
  if (step.deploymentId !== attempt.deploymentId || step.ordinal !== ordinal || step.phase !== phase || step.name !== attempt.requestedAgents[ordinal] || step.hash !== attempt.agentHashes?.[ordinal]?.hash || step.managerInstanceId !== attempt.managerInstanceId) throw new Error("agent step differs from its original intent");
  if (phase === "submitted" ? step.request !== undefined || step.joined !== undefined : !step.request || step.request.requestId !== step.requestId || step.request.managerInstanceId !== step.managerInstanceId) throw new Error("agent step has no matching native request");
  if (phase === "accepted" && step.joined !== undefined) throw new Error("an acceptance cannot assert a joined terminal");
  if (phase === "joined") {
    const allocation = step.request?.allocation;
    const id = allocation?.owner === DEV_OWNER ? allocation.actor : allocation ? `${allocation.owner}.${allocation.actor}` : undefined;
    if (!step.joined || !allocation || JSON.stringify(step.joined.request) !== JSON.stringify(step.request) || step.joined.requested !== step.name || step.joined.hash !== step.hash || step.joined.name !== allocation.name || step.joined.id !== id || step.joined.lifecycleUid !== allocation.lifecycleUid) throw new Error("joined agent differs from its acceptance");
  }
  return step;
}

/** Immutable native request/allocation/join observations. A missing phase never authorizes replay. */
export function writeAdditiveAgentStep(root: string, attempt: AdditiveTeamAttempt, ordinal: number, value: Omit<AdditiveAgentStep, "schemaVersion" | "kind" | "deploymentId" | "ordinal" | "name" | "hash" | "recordedAt">): void {
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) throw new Error("agent step has no prepared control directory");
  protectedLocalDirectory(dir);
  const original = readAttempt(join(dir, nameFor(attempt.deploymentId)), attempt.deploymentId, root);
  if (JSON.stringify(original) !== JSON.stringify(validate(attempt)) || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= original.requestedAgents.length) throw new Error("agent step has no matching published intent");
  if (value.phase !== "submitted") {
    const submitted = readAgentStep(join(dir, agentStepName(attempt.deploymentId, ordinal, "submitted")), original, ordinal, "submitted");
    if (submitted.requestId !== value.requestId) throw new Error("agent request changed after submission marker");
  }
  if (value.phase === "joined") {
    const accepted = readAgentStep(join(dir, agentStepName(attempt.deploymentId, ordinal, "accepted")), original, ordinal, "accepted");
    if (JSON.stringify(accepted.request) !== JSON.stringify(value.request)) throw new Error("agent acceptance changed before join receipt");
  }
  const input = AgentStep.parse({ schemaVersion: 1, kind: "additive-agent-step", deploymentId: original.deploymentId, ordinal, name: original.requestedAgents[ordinal], hash: original.agentHashes![ordinal]!.hash, ...value, recordedAt: new Date().toISOString() });
  const path = join(dir, agentStepName(attempt.deploymentId, ordinal, value.phase));
  publishSynced(dir, path, JSON.stringify(input, null, 2) + "\n");
  readAgentStep(path, original, ordinal, value.phase);
}

export function additiveAgentAttemptSettled(attempt: AdditiveTeamAttempt, receipt: AdditiveTeamReceipt | undefined, steps: readonly AdditiveAgentStep[], channelSteps: readonly AdditiveChannelStep[] = []): boolean {
  if (!receipt || receipt.kind === "additive-channel-receipt" || !attempt.requestedAgents.length || receipt.deploymentId !== attempt.deploymentId || receipt.root !== attempt.root || receipt.space !== attempt.space || receipt.server !== attempt.server || receipt.manifestPath !== attempt.manifestPath || receipt.manifestHash !== attempt.manifestHash || receipt.authMode !== attempt.authMode || receipt.tlsRequired !== attempt.tlsRequired || receipt.createdAgents.length !== attempt.requestedAgents.length || steps.length !== attempt.requestedAgents.length * 3) return false;
  if ((receipt.kind === "additive-team-receipt") !== (attempt.declaredChannels.length > 0) || !channelStepsMatch(attempt, receipt.createdChannels, channelSteps)) return false;
  return attempt.requestedAgents.every((name, ordinal) => {
    const phases = steps.filter((step) => step.ordinal === ordinal && step.name === name && step.deploymentId === attempt.deploymentId);
    const submitted = phases.filter((step) => step.phase === "submitted"), accepted = phases.filter((step) => step.phase === "accepted"), joined = phases.filter((step) => step.phase === "joined");
    const row = receipt.createdAgents[ordinal];
    return phases.length === 3 && submitted.length === 1 && accepted.length === 1 && joined.length === 1 && row?.requested === name && row.hash === attempt.agentHashes?.[ordinal]?.hash && row.request.managerInstanceId === attempt.managerInstanceId && row.request.requestId === submitted[0]!.requestId && JSON.stringify(accepted[0]!.request) === JSON.stringify(row.request) && JSON.stringify(joined[0]!.joined) === JSON.stringify(row);
  });
}

export function writeAdditiveAgentReceipt(root: string, attempt: AdditiveTeamAttempt, createdAgents: AdditiveAgentReceipt["createdAgents"], createdChannels: AdditiveChannelReceipt["createdChannels"] = []): void {
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) throw new Error("agent receipt has no prepared control directory");
  protectedLocalDirectory(dir);
  const original = readAttempt(join(dir, nameFor(attempt.deploymentId)), attempt.deploymentId, root);
  if (JSON.stringify(original) !== JSON.stringify(validate(attempt))) throw new Error("agent receipt differs from published intent");
  const inventory = listAdditiveTeamAttempts(root);
  if (inventory.refused.length) throw new Error("agent receipt inventory is unreadable");
  const { agentHashes: _hashes, managerInstanceId: _manager, declaredChannels: _channels, requestedAgents: _agents, createdAt: _time, kind: _kind, ...common } = original;
  const receipt = AgentReceipt.parse({ ...common, kind: original.declaredChannels.length ? "additive-team-receipt" : "additive-agent-receipt", createdChannels, createdAgents, recordedAt: new Date().toISOString() });
  if (!additiveAgentAttemptSettled(original, receipt, inventory.agentSteps.filter((step) => step.deploymentId === original.deploymentId), inventory.steps.filter((step) => step.deploymentId === original.deploymentId))) throw new Error("agent and channel steps do not settle the original intent");
  publishSynced(dir, join(dir, receiptName(original.deploymentId)), JSON.stringify(receipt, null, 2) + "\n");
}

/** All root-local attempts. Bad records remain visible rather than becoming absence. */
export function listAdditiveTeamAttempts(root: string): { valid: AdditiveTeamAttempt[]; steps: AdditiveChannelStep[]; agentSteps: AdditiveAgentStep[]; returned: AdditiveTeamReceipt[]; removal?: AgentRemovalInventory; channelRemoval?: ChannelRemovalInventory; refused: { path: string; why: string }[] } {
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) return { valid: [], steps: [], agentSteps: [], returned: [], refused: [] };
  protectedLocalDirectory(dir);
  const valid: AdditiveTeamAttempt[] = [], steps: AdditiveChannelStep[] = [], agentSteps: AdditiveAgentStep[] = [], returned: AdditiveTeamReceipt[] = [], refused: { path: string; why: string }[] = [];
  const names = readdirSync(dir).sort();
  for (const name of names.filter((file) => file.startsWith("team-deploy-attempt-") && file.endsWith(".json") && !file.endsWith("-returned.json"))) {
    const path = join(dir, name), id = name.slice("team-deploy-attempt-".length, -5);
    try {
      if (!ID.test(id)) throw new Error("not a full additive deployment ID");
      valid.push(readAttempt(path, id, root));
    } catch { refused.push({ path, why: "the additive attempt is unreadable or does not match this root" }); }
  }
  const byId = new Map(valid.map((attempt) => [attempt.deploymentId, attempt]));
  for (const name of names.filter((file) => file.startsWith("team-deploy-step-") && file.endsWith(".json"))) {
    const path = join(dir, name), matched = STEP_NAME.exec(name);
    try {
      if (!matched) throw new Error("not a full additive step filename");
      const attempt = byId.get(matched[1]!);
      if (!attempt) throw new Error("additive step has no readable original intent");
      const ordinal = Number(matched[2]), phase = matched[3] as "submitted" | "accepted";
      if (phase === "accepted") readStep(join(dir, stepName(attempt.deploymentId, ordinal, "submitted")), attempt, ordinal, "submitted");
      steps.push(readStep(path, attempt, ordinal, phase));
    } catch { refused.push({ path, why: "the additive channel step or its original submission is unreadable" }); }
  }
  for (const name of names.filter((file) => file.startsWith("team-deploy-agent-step-") && file.endsWith(".json"))) {
    const path = join(dir, name), matched = AGENT_STEP_NAME.exec(name);
    try {
      if (!matched) throw new Error("invalid native agent step filename");
      const attempt = byId.get(matched[1]!);
      if (!attempt) throw new Error("agent step has no readable original intent");
      const ordinal = Number(matched[2]), phase = matched[3] as AdditiveAgentStep["phase"];
      const step = readAgentStep(path, attempt, ordinal, phase);
      if (phase !== "submitted") {
        const submission = readAgentStep(join(dir, agentStepName(attempt.deploymentId, ordinal, "submitted")), attempt, ordinal, "submitted");
        if (step.requestId !== submission.requestId) throw new Error("agent request id changed");
      }
      if (phase === "joined") {
        const acceptance = readAgentStep(join(dir, agentStepName(attempt.deploymentId, ordinal, "accepted")), attempt, ordinal, "accepted");
        if (JSON.stringify(step.request) !== JSON.stringify(acceptance.request)) throw new Error("joined agent has no matching accepted request");
      }
      agentSteps.push(step);
    } catch { refused.push({ path, why: "the agent step or its original native request/allocation is unreadable" }); }
  }
  for (const name of names.filter((file) => file.startsWith("team-deploy-attempt-") && file.endsWith("-returned.json"))) {
    const path = join(dir, name), id = name.slice("team-deploy-attempt-".length, -RETURN_SUFFIX.length);
    try {
      if (!ID.test(id)) throw new Error("not a full returned additive ID");
      const attempt = byId.get(id);
      if (!attempt) throw new Error("returned additive receipt has no readable original intent");
      const receipt = readReceipt(path, id, root);
      const settled = receipt.kind === "additive-channel-receipt" ? additiveChannelAttemptSettled(attempt, receipt, steps.filter((step) => step.deploymentId === id)) : additiveAgentAttemptSettled(attempt, receipt, agentSteps.filter((step) => step.deploymentId === id), steps.filter((step) => step.deploymentId === id));
      if (!settled || refused.some((row) => row.path.startsWith(join(dir, `team-deploy-step-${id}-`)) || row.path.startsWith(join(dir, `team-deploy-agent-step-${id}-`)))) throw new Error("returned additive receipt has an unsettled or unreadable step");
      returned.push(receipt);
    } catch { refused.push({ path, why: "the returned additive receipt is unreadable or does not settle its original intent" }); }
  }
  const removal = readAgentTeamRemovals(root, valid, returned);
  const channelRemoval = readChannelTeamRemovals(root, valid, returned, new Set(removal.returned.map((row) => row.deploymentId)));
  return { valid, steps, agentSteps, returned, removal, channelRemoval, refused: [...refused, ...removal.refused, ...channelRemoval.refused] };
}

/** Deployments whose complete scoped removal matched their original returned receipt: the agent
 *  receipt for agent-only, the card receipt for channel-only, and both for a mixed team. */
export function removedAdditiveDeploymentIds(inventory: ReturnType<typeof listAdditiveTeamAttempts>): Set<string> {
  const agents = new Set(inventory.removal?.returned.map((row) => row.deploymentId) ?? []), cards = new Set(inventory.channelRemoval?.returned.map((row) => row.deploymentId) ?? []);
  return new Set(inventory.returned.filter((row) => row.kind === "additive-agent-receipt" ? agents.has(row.deploymentId) : row.kind === "additive-channel-receipt" ? cards.has(row.deploymentId) : agents.has(row.deploymentId) && cards.has(row.deploymentId)).map((row) => row.deploymentId));
}

/** Completed scoped removals release only their own known blocker: agent-only native retirements or
 * channel-only card deletes. The creation records stay in history; unreadable or incomplete removal
 * never releases custody. */
export function retainedAdditiveTeamAttempts(inventory: ReturnType<typeof listAdditiveTeamAttempts>): AdditiveTeamAttempt[] {
  const removed = removedAdditiveDeploymentIds(inventory);
  return inventory.valid.filter((row) => !removed.has(row.deploymentId));
}

export function additiveTeamRecordedState(attempt: AdditiveTeamAttempt, inventory: ReturnType<typeof listAdditiveTeamAttempts>): "removal-returned" | "channels-and-agents-returned" | "agent-joins-returned" | "channel-create-returned" | "unsettled" {
  if (removedAdditiveDeploymentIds(inventory).has(attempt.deploymentId)) return "removal-returned";
  if (!inventory.returned.some((row) => row.deploymentId === attempt.deploymentId)) return "unsettled";
  return attempt.requestedAgents.length ? attempt.declaredChannels.length ? "channels-and-agents-returned" : "agent-joins-returned" : "channel-create-returned";
}

export function findAdditiveTeamAttempt(root: string, id: string): AdditiveTeamAttempt | undefined {
  if (!ID.test(id)) throw new Error("an additive attempt requires its complete deployment ID");
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) return undefined;
  protectedLocalDirectory(dir);
  try { return readAttempt(join(dir, nameFor(id)), id, root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
