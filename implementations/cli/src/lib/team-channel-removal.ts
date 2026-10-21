import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { JetStreamApiCodes } from "@nats-io/jetstream";
import {
  CHANNEL_DEFAULTS_KEY, MEMBERSHIP_FEED_KEY, assertValidChannel, channelBucket, contractDigest, decodeChannelEntry, dialerFor,
  isConcreteChannel, isJetStreamMissing, liveKvEntries, membershipBucket, standaloneConnectOpts, subjectMatches,
  type ChannelConfig, type ChannelDefaults,
} from "@cotal-ai/core";
import { canonicalRoot } from "@cotal-ai/workspace";
import { z } from "zod";
import type { AdditiveAgentReceipt, AdditiveChannelReceipt, AdditiveTeamAttempt, AdditiveTeamReceipt } from "./team-additive-attempt.js";
import { publishRemovalRecord, readRemovalRecord, removalRecordDirectory } from "./team-removal-record.js";

/** A channel-only receipt, or a mixed team receipt whose original agents are fully retired. */
export type CardReceipt = AdditiveChannelReceipt | (AdditiveAgentReceipt & { kind: "additive-team-receipt" });

const ID = /^[a-f0-9]{16}$/;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Channel = z.strictObject({ name: z.string().min(1).max(4096), createdRevision: revision });
const Common = {
  schemaVersion: z.literal(1), deploymentId: z.string().regex(ID), root: z.string().min(1), space: z.string().min(1),
  server: z.string().min(1), authMode: z.enum(["open", "auth", "user"]), tlsRequired: z.boolean(),
  originalReceiptDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
};
/** The registry stream the intent's deletes were issued against: its name and creation time. A
 * reconciliation observation binds to it, so a recreated or swapped registry cannot settle a card. */
const Registry = z.strictObject({ stream: z.string().min(1).max(256), created: z.string().min(1).max(64) });
const Intent = z.strictObject({ ...Common, kind: z.literal("additive-channel-removal-attempt"), channels: z.array(Channel).min(1).max(100), registry: Registry.optional(), createdAt: z.iso.datetime() });
const stepBase = { schemaVersion: z.literal(1), deploymentId: z.string().regex(ID), ordinal: z.number().int().min(0).max(99), name: z.string().min(1).max(4096), createdRevision: revision, recordedAt: z.iso.datetime() };
const Step = z.discriminatedUnion("phase", [
  /** Written before the revision-conditioned delete is published. */
  z.strictObject({ ...stepBase, phase: z.literal("submitted") }),
  /** The delete was acknowledged and the read-back marker follows the created revision. */
  z.strictObject({ ...stepBase, phase: z.literal("deleted"), markerRevision: revision }),
  /** The card was already gone before any delete was submitted; who removed it is not known. */
  z.strictObject({ ...stepBase, phase: z.literal("absent"), markerRevision: revision.nullable() }),
  /** The broker refused the conditioned delete because the card moved; nothing was deleted. */
  z.strictObject({ ...stepBase, phase: z.literal("conflict") }),
  /** Reconciliation only, after an unconfirmed `submitted`: in the intent's registry stream the
   * card's last message is a removal marker after the created revision, or the key holds no message.
   * Who removed it is unknown; this never claims the submitted delete executed. */
  z.strictObject({ ...stepBase, phase: z.literal("observed-removed"), markerRevision: revision.nullable(), markerOperation: z.enum(["DEL", "PURGE"]).nullable(), registryCreated: Registry.shape.created }),
  /** Reconciliation only, after an unconfirmed `submitted`: a later value replaced the created
   * revision. That value is not owned, so the deployment stays blocking, as after `conflict`. */
  z.strictObject({ ...stepBase, phase: z.literal("observed-superseded"), currentRevision: revision, registryCreated: Registry.shape.created }),
]);
const Removed = z.strictObject({ name: z.string().min(1).max(4096), createdRevision: revision, outcome: z.enum(["deleted", "absent", "observed-removed"]), markerRevision: revision.nullable() });
const Receipt = z.strictObject({ ...Common, kind: z.literal("additive-channel-removal-receipt"), removedChannels: z.array(Removed).min(1).max(100), recordedAt: z.iso.datetime() });
export type ChannelRemovalAttempt = z.infer<typeof Intent>;
export type ChannelRemovalStep = z.infer<typeof Step>;
export type ChannelRemovalReceipt = z.infer<typeof Receipt>;
export type RemovedChannel = z.infer<typeof Removed>;
export interface ChannelRemovalInventory { attempts: ChannelRemovalAttempt[]; steps: ChannelRemovalStep[]; returned: ChannelRemovalReceipt[]; refused: { path: string; why: string }[] }

const PREFIX = "team-channel-remove-";
const intentName = (id: string) => `${PREFIX}attempt-${id}.json`;
const receiptName = (id: string) => `${PREFIX}returned-${id}.json`;
const stepName = (id: string, ordinal: number, phase: ChannelRemovalStep["phase"]) => `${PREFIX}step-${id}-${ordinal}-${phase}.json`;
const STEP_NAME = /^team-channel-remove-step-([a-f0-9]{16})-(0|[1-9][0-9]?)-(submitted|deleted|absent|conflict|observed-removed|observed-superseded)\.json$/;
/** Every phase that ends one card's removal. At most one may exist per card. */
export const CARD_TERMINAL_PHASES = ["deleted", "absent", "conflict", "observed-removed", "observed-superseded"] as const;

/** Mixed card removal is valid only after a complete matched agent-retirement receipt, so a card
 * phase can never precede or replace the retirement phase. Static auth only, like retirement. */
function originalFor(root: string, id: string, attempts: readonly AdditiveTeamAttempt[], receipts: readonly AdditiveTeamReceipt[], retired: ReadonlySet<string>): { attempt: AdditiveTeamAttempt; receipt: CardReceipt } {
  const attempt = attempts.find((row) => row.deploymentId === id), receipt = receipts.find((row) => row.deploymentId === id);
  const shape = receipt?.kind === "additive-channel-receipt" ? !attempt?.requestedAgents.length
    : receipt?.kind === "additive-team-receipt" && receipt.authMode === "auth" && attempt?.requestedAgents.length === receipt.createdAgents.length && retired.has(id);
  if (!attempt || !receipt || !shape || !receipt.createdChannels.length || receipt.createdChannels.length > 100 || canonicalRoot(attempt.root) !== canonicalRoot(root)) throw new Error("removal has no matching channel-only or retired mixed returned deployment");
  return { attempt, receipt: receipt as CardReceipt };
}
function matches(value: ChannelRemovalAttempt | ChannelRemovalReceipt, original: ReturnType<typeof originalFor>): boolean {
  const { attempt, receipt } = original;
  return value.root === attempt.root && value.space === attempt.space && value.server === attempt.server && value.authMode === attempt.authMode && value.tlsRequired === attempt.tlsRequired && value.originalReceiptDigest === contractDigest(receipt);
}
function sameChannels(intent: ChannelRemovalAttempt, receipt: CardReceipt): boolean {
  return intent.channels.length === receipt.createdChannels.length && intent.channels.every((row, ordinal) => row.name === receipt.createdChannels[ordinal]?.name && row.createdRevision === receipt.createdChannels[ordinal]?.revision);
}

/** A removal record is history, never authority to delete a name. Only a complete sequence bound to
 * the original channel receipt releases the root's known additive blocker; anything else blocks. */
export function readChannelTeamRemovals(root: string, attempts: readonly AdditiveTeamAttempt[], receipts: readonly AdditiveTeamReceipt[], retired: ReadonlySet<string> = new Set()): ChannelRemovalInventory {
  const inventory: ChannelRemovalInventory = { attempts: [], steps: [], returned: [], refused: [] };
  const dir = removalRecordDirectory(root), files = readdirSync(dir).filter((name) => name.startsWith(PREFIX)).sort();
  for (const name of files.filter((name) => name.startsWith(`${PREFIX}attempt-`))) {
    const path = join(dir, name);
    try {
      const value = Intent.parse(readRemovalRecord(path)), original = originalFor(root, value.deploymentId, attempts, receipts, retired);
      if (name !== intentName(value.deploymentId) || !matches(value, original) || !sameChannels(value, original.receipt)) throw new Error("channel removal intent differs from its original deployment");
      inventory.attempts.push(value);
    } catch { inventory.refused.push({ path, why: "the channel removal intent or its original deployment is unreadable" }); }
  }
  const stepFiles = files.filter((name) => name.startsWith(`${PREFIX}step-`));
  for (const name of stepFiles) {
    const path = join(dir, name);
    try {
      const value = Step.parse(readRemovalRecord(path)), intent = inventory.attempts.find((row) => row.deploymentId === value.deploymentId);
      const channel = intent?.channels[value.ordinal];
      if (!STEP_NAME.test(name) || name !== stepName(value.deploymentId, value.ordinal, value.phase) || !intent || !channel || channel.name !== value.name || channel.createdRevision !== value.createdRevision) throw new Error("channel removal step differs from its intent");
      const submitted = stepFiles.includes(stepName(value.deploymentId, value.ordinal, "submitted"));
      const terminals = CARD_TERMINAL_PHASES.filter((phase) => stepFiles.includes(stepName(value.deploymentId, value.ordinal, phase)));
      if (terminals.length > 1 || value.phase !== "submitted" && value.phase !== "absent" && !submitted || value.phase === "absent" && submitted) throw new Error("channel removal step has no consistent submission");
      if (value.phase === "deleted" && value.markerRevision <= value.createdRevision || value.phase === "absent" && value.markerRevision !== null && value.markerRevision <= value.createdRevision) throw new Error("removal marker does not follow the created revision");
      if ((value.phase === "observed-removed" || value.phase === "observed-superseded") && value.registryCreated !== intent.registry?.created) throw new Error("a reconciled observation names another registry stream than its intent");
      if (value.phase === "observed-removed" && ((value.markerRevision === null) !== (value.markerOperation === null) || value.markerRevision !== null && value.markerRevision <= value.createdRevision)) throw new Error("an observed removal marker does not follow the created revision");
      if (value.phase === "observed-superseded" && value.currentRevision <= value.createdRevision) throw new Error("an observed replacement does not follow the created revision");
      inventory.steps.push(value);
    } catch { inventory.refused.push({ path, why: "the channel removal step or its registry observation is unreadable" }); }
  }
  for (const name of files.filter((name) => name.startsWith(`${PREFIX}returned-`))) {
    const path = join(dir, name);
    try {
      const value = Receipt.parse(readRemovalRecord(path)), original = originalFor(root, value.deploymentId, attempts, receipts, retired);
      const intent = inventory.attempts.find((row) => row.deploymentId === value.deploymentId);
      if (name !== receiptName(value.deploymentId) || !intent || !matches(value, original) || inventory.refused.some((row) => row.path.includes(value.deploymentId)) || value.removedChannels.length !== intent.channels.length || !value.removedChannels.every((row, ordinal) => {
        const step = inventory.steps.find((step) => step.deploymentId === value.deploymentId && step.ordinal === ordinal && step.phase === row.outcome);
        return row.name === intent.channels[ordinal]!.name && row.createdRevision === intent.channels[ordinal]!.createdRevision && step !== undefined && "markerRevision" in step && step.markerRevision === row.markerRevision;
      })) throw new Error("channel removal receipt does not settle its original cards");
      inventory.returned.push(value);
    } catch { inventory.refused.push({ path, why: "the channel removal receipt does not settle the original deployment" }); }
  }
  for (const name of files.filter((name) => !name.startsWith(`${PREFIX}attempt-`) && !name.startsWith(`${PREFIX}step-`) && !name.startsWith(`${PREFIX}returned-`))) inventory.refused.push({ path: join(dir, name), why: "the channel removal record name is unsupported" });
  return inventory;
}

export function writeChannelRemovalAttempt(root: string, attempt: AdditiveTeamAttempt, receipt: CardReceipt, retired: ReadonlySet<string>, registry: RegistryIdentity): ChannelRemovalAttempt {
  const original = originalFor(root, attempt.deploymentId, [attempt], [receipt], retired);
  const value = Intent.parse({ schemaVersion: 1, kind: "additive-channel-removal-attempt", deploymentId: attempt.deploymentId, root: attempt.root, space: attempt.space, server: attempt.server, authMode: attempt.authMode, tlsRequired: attempt.tlsRequired, originalReceiptDigest: contractDigest(original.receipt), channels: receipt.createdChannels.map((row) => ({ name: row.name, createdRevision: row.revision })), registry: { stream: registry.stream, created: registry.created }, createdAt: new Date().toISOString() });
  publishRemovalRecord(root, intentName(value.deploymentId), value);
  return value;
}
export type ObservedCardStep = { phase: "observed-removed"; markerRevision: number | null; markerOperation: "DEL" | "PURGE" | null } | { phase: "observed-superseded"; currentRevision: number };
export function writeChannelRemovalStep(root: string, intent: ChannelRemovalAttempt, ordinal: number, value: { phase: "submitted" | "conflict" } | { phase: "deleted"; markerRevision: number } | { phase: "absent"; markerRevision: number | null } | ObservedCardStep): void {
  if (JSON.stringify(Intent.parse(readRemovalRecord(join(removalRecordDirectory(root), intentName(intent.deploymentId))))) !== JSON.stringify(intent)) throw new Error("channel removal intent changed");
  const channel = intent.channels[ordinal];
  if (!channel) throw new Error("channel removal step has no intended card");
  const observed = value.phase === "observed-removed" || value.phase === "observed-superseded";
  if (observed && !intent.registry) throw new Error("a reconciled observation needs the intent's registry stream");
  const step = Step.parse({ schemaVersion: 1, deploymentId: intent.deploymentId, ordinal, name: channel.name, createdRevision: channel.createdRevision, ...value, ...(observed ? { registryCreated: intent.registry!.created } : {}), recordedAt: new Date().toISOString() });
  publishRemovalRecord(root, stepName(intent.deploymentId, ordinal, step.phase), step);
}
export function writeChannelRemovalReceipt(root: string, intent: ChannelRemovalAttempt, removedChannels: readonly RemovedChannel[]): void {
  const { kind: _kind, createdAt: _created, channels: _channels, registry: _registry, ...common } = intent;
  publishRemovalRecord(root, receiptName(intent.deploymentId), Receipt.parse({ ...common, kind: "additive-channel-removal-receipt", removedChannels, recordedAt: new Date().toISOString() }));
}

type Auth = { creds?: string; bearer?: string; sentinelCreds?: string };
export type CardObservation = { name: string; state: "same-revision" | "changed" | "absent"; revision: number | null; config: ChannelConfig | null };
/** One registry stream incarnation, read from the broker's stream info. */
export interface RegistryIdentity { stream: string; created: string; lastSeq: number }
/** The last message on one card key. `none` is only the broker's explicit "message not found". */
export type CardMessage = { kind: "put"; revision: number } | { kind: "marker"; operation: "DEL" | "PURGE"; revision: number } | { kind: "none" };

/** One non-reconnecting registry connection. `deleteAt` is the native revision-conditioned delete
 * (`Nats-Expected-Last-Subject-Sequence`): it removes only the card still at the created revision. */
export async function openChannelCardRegistry(input: { server: string; space: string; tls: boolean; auth: Auth }) {
  const nc = await dialerFor(input.server)({ servers: input.server, ...standaloneConnectOpts({ ...input.auth, tls: input.tls }), timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
  let kv: Awaited<ReturnType<Kvm["open"]>>;
  try { kv = await new Kvm(nc).open(channelBucket(input.space)); }
  catch (error) { try { await nc.close(); } catch { /* No registry request was made. */ } throw error; }
  const key = (name: string) => {
    assertValidChannel(name);
    if (!isConcreteChannel(name) || name === CHANNEL_DEFAULTS_KEY) throw new Error("a team channel removal names one concrete channel card");
    return name;
  };
  return {
    async observe(name: string, createdRevision: number): Promise<CardObservation> {
      const entry = await kv.get(key(name));
      if (!entry || entry.operation !== "PUT") return { name, state: "absent", revision: entry?.revision ?? null, config: null };
      let config: ChannelConfig | null = null;
      try { config = decodeChannelEntry(entry) as ChannelConfig; } catch { /* An undecodable card still has a revision. */ }
      return { name, state: entry.revision === createdRevision ? "same-revision" : "changed", revision: entry.revision, config };
    },
    /** The registry stream's name, creation time and last sequence. A failed read throws. */
    async identity(): Promise<RegistryIdentity> {
      const info = (await kv.status()).streamInfo;
      if (typeof info.created !== "string" || !info.created || !Number.isSafeInteger(info.state.last_seq)) throw new Error("the registry stream info has no creation time or sequence");
      return { stream: info.config.name, created: info.created, lastSeq: info.state.last_seq };
    },
    /** The card key's last message. The client returns null only for the broker's "message not
     * found" answer; permission, stream and transport failures reject and are never absence. */
    async lastMessage(name: string): Promise<CardMessage> {
      const entry = await kv.get(key(name));
      if (!entry) return { kind: "none" };
      if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error("the card key's last message has no usable revision");
      if (entry.operation === "PUT") return { kind: "put", revision: entry.revision };
      if (entry.operation === "DEL" || entry.operation === "PURGE") return { kind: "marker", operation: entry.operation, revision: entry.revision };
      throw new Error("the card key's last message has an unknown operation");
    },
    async defaults(): Promise<ChannelDefaults | null> {
      const entry = await kv.get(CHANNEL_DEFAULTS_KEY);
      if (!entry || entry.operation !== "PUT") return null;
      return decodeChannelEntry(entry) as ChannelDefaults;
    },
    /** `not-executed` only for the broker's wrong-last-sequence refusal; every other failure throws. */
    async deleteAt(name: string, createdRevision: number): Promise<"acknowledged" | "not-executed"> {
      if (!Number.isSafeInteger(createdRevision) || createdRevision < 1) throw new Error("a conditioned delete needs the positive created revision");
      try { await kv.delete(key(name), { previousSeq: createdRevision }); return "acknowledged"; }
      catch (error) {
        if (isJetStreamMissing(error, JetStreamApiCodes.StreamWrongLastSequence)) return "not-executed";
        throw error;
      }
    },
    close: () => nc.close(),
  };
}

/** Display-only impact: the derived membership feed is never an authorization input. */
export async function readChannelMemberImpact(server: string, space: string, tls: boolean, auth: Auth, names: readonly string[]): Promise<{ asOf: number | null; channels: Array<{ name: string; observedMembers: string[] }> } | null> {
  try {
    const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ ...auth, tls }), timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
    try {
      const rows = await liveKvEntries(await new Kvm(nc).open(membershipBucket(space)));
      if (rows.length > 10_000) return null;
      let asOf: number | null = null;
      const members: Array<{ id: string; live: string[]; durable: string[] }> = [];
      for (const row of rows) {
        try {
          const value = row.json<{ observedAt?: unknown; live?: unknown; durable?: unknown }>();
          if (row.key === MEMBERSHIP_FEED_KEY) { asOf = typeof value.observedAt === "number" ? value.observedAt : null; continue; }
          members.push({ id: row.key, live: Array.isArray(value.live) ? value.live.filter((item): item is string => typeof item === "string") : [], durable: Array.isArray(value.durable) ? value.durable.filter((item): item is string => typeof item === "string") : [] });
        } catch { /* An undecodable row lowers the bound further. */ }
      }
      return { asOf, channels: names.map((name) => ({ name, observedMembers: members.filter((row) => row.durable.includes(name) || row.live.some((pattern) => subjectMatches(pattern, name))).map((row) => row.id).slice(0, 100) })) };
    } finally { await nc.close(); }
  } catch { return null; }
}
