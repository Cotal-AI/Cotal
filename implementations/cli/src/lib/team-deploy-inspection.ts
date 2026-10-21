import { readFileSync } from "node:fs";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager, JetStreamApiCodes } from "@nats-io/jetstream";
import {
  CHANNEL_DEFAULTS_KEY, CotalEndpoint, channelBucket, decodeChannelEntry, dialerFor,
  isJetStreamMissing, liveKvEntries, presenceBucket, standaloneConnectOpts,
  type ChannelRegistryFile, type Presence,
} from "@cotal-ai/core";
import { canonicalRoot, CommandFailure, connectOrThrow, serviceMetadataDigest, userViewAuth } from "@cotal-ai/workspace";
import { hashManifestSource, listLedgers } from "./manifest/ledger.js";
import { classifyAgents, classifyChannels, detectUnmanagedActors } from "./manifest/spawn-plan.js";
import { loadManifest, type PreparedManifest } from "./manifest/index.js";

async function presenceSnapshot(server: string, space: string, tls: boolean, auth: { creds?: string; bearer?: string; sentinelCreds?: string }): Promise<Presence[]> {
  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ ...auth, tls }), timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
  try {
    const rows = await liveKvEntries(await new Kvm(nc).open(presenceBucket(space)));
    if (rows.length > 10_000) throw new Error("presence inventory exceeds the bounded read");
    return rows.map((row) => {
      const peer = row.json<Presence>();
      if (peer.card?.id !== row.key || typeof peer.card.name !== "string" || typeof peer.status !== "string" || !Number.isFinite(peer.ts)) throw new Error("presence identity or timestamp invalid");
      return peer;
    });
  } finally { await nc.close(); }
}

/** Ordinary inspection may use KV reads. Retained no-op verification requests the leader so a
 *  follower's older create revision cannot make a changed card look unchanged. */
export async function readOwnedChannelRevisions(server: string, space: string, tls: boolean, auth: { creds?: string; bearer?: string; sentinelCreds?: string }, names: string[], options: { leader?: boolean } = {}): Promise<Array<{ name: string; revision: number | null; cardSha256?: string }>> {
  if (names.length > 10_000) throw new Error("owned channel inventory exceeds the bounded read");
  if (!names.length) return [];
  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ ...auth, tls }), timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
  try {
    const bucket = channelBucket(space);
    const leader = options.leader ? await jetstreamManager(nc) : undefined;
    const kv = leader ? undefined : await new Kvm(nc).open(bucket);
    const rows: Array<{ name: string; revision: number | null; cardSha256?: string }> = [];
    for (const name of names) {
      if (leader) {
        try {
          const entry = await leader.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${name}` });
          if (!entry) { rows.push({ name, revision: null }); continue; }
          const operation = entry.header?.get("KV-Operation");
          if (operation && !["PUT", "DEL", "PURGE"].includes(operation)) throw new Error("unknown channel operation");
          const removed = operation === "DEL" || operation === "PURGE";
          rows.push({ name, revision: removed ? null : entry.seq, ...(removed ? {} : { cardSha256: serviceMetadataDigest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.data))) }) });
        } catch (error) {
          if ((error as { code?: unknown }).code !== 10037) throw error;
          rows.push({ name, revision: null });
        }
      } else {
        const entry = await kv!.get(name);
        rows.push({ name, revision: entry && entry.operation === "PUT" ? entry.revision : null });
      }
    }
    return rows;
  } finally { await nc.close(); }
}

async function channelRegistrySnapshot(server: string, space: string, tls: boolean, auth: { creds?: string; bearer?: string; sentinelCreds?: string }): Promise<ChannelRegistryFile> {
  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ ...auth, tls }), timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
  try {
    const kv = await new Kvm(nc).open(channelBucket(space));
    const channels: NonNullable<ChannelRegistryFile["channels"]> = {};
    let defaults: ChannelRegistryFile["defaults"];
    let entries: Awaited<ReturnType<typeof liveKvEntries>>;
    try { entries = await liveKvEntries(kv); }
    catch (error) {
      if (isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) return { channels };
      throw error;
    }
    for (const entry of entries) {
      const value = decodeChannelEntry(entry);
      if (entry.key === CHANNEL_DEFAULTS_KEY) defaults = value;
      else Object.defineProperty(channels, entry.key, { value, enumerable: true, configurable: true, writable: true });
    }
    return { channels, ...(defaults ? { defaults } : {}) };
  } finally { await nc.close(); }
}

/** Read-only additive classification. The membership feed is display-only and never grants apply. */
export async function inspectTeamDeployment(root: string, path: string, prepared: PreparedManifest, runtime: string) {
  const space = prepared.manifest.space;
  const target = { space, root, path };
  const conn = await connectOrThrow({ space }, "deployer", { readOnly: true });
  if (!conn.root || canonicalRoot(conn.root) !== canonicalRoot(root))
    throw new CommandFailure("refused", "CONFLICT", "the registered broker belongs to another root; no additive deployment was classified", { target });
  if (prepared.manifest.broker?.servers && prepared.manifest.broker.servers !== conn.server)
    throw new CommandFailure("refused", "CONFLICT", "the manifest broker differs from the registered connection; no alternate broker was adopted", { target });
  let user: Awaited<ReturnType<typeof userViewAuth>> | undefined;
  if (conn.mode === "user") {
    try { user = await userViewAuth(conn, "deployer"); }
    catch { throw new CommandFailure("refused", "PERMISSION_DENIED", "the native deployer view was not issued; no other identity or credential was substituted", { target }); }
  }
  const ep = new CotalEndpoint({ space, servers: conn.server, tls: conn.tls,
    ...(user ? { bearer: user.source, sentinelCreds: user.sentinelCreds, lifecycleUid: user.lifecycleUid,
      card: { owner: user.owner, actor: user.actor, name: "team-deploy-preview", kind: "endpoint" as const } }
      : { creds: conn.creds, lifecycleUid: conn.epCaller?.uid, card: { name: "team-deploy-preview", kind: "endpoint" as const } }),
    channels: [], consume: false, registerPresence: false, watchPresence: false });
  ep.on("error", () => {});
  try {
    await ep.start();
    const readAuth = user ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds } : { creds: conn.creds };
    const roster = await presenceSnapshot(conn.server, space, conn.tls, readAuth);
    const channels = await channelRegistrySnapshot(conn.server, space, conn.tls, readAuth);
    const source = readFileSync(path, "utf8");
    const reloaded = loadManifest(path);
    if (source !== readFileSync(path, "utf8") || JSON.stringify(reloaded) !== JSON.stringify(prepared)) throw new CommandFailure("refused", "CONFLICT", "the manifest or referenced persona changed during native inspection; no prior ownership was selected", { target });
    const manifestHash = hashManifestSource(source);
    const priors = listLedgers(root).filter(({ ledger }) => ledger.manifestHash === manifestHash && ledger.space === space);
    if (priors.length > 1) throw new CommandFailure("refused", "CONFLICT", "several prior additive ledgers claim this manifest; no deployment ownership was selected", { target });
    const prior = priors[0]?.ledger;
    const channelPlan = classifyChannels(prepared.manifest.channels, channels, new Set(prior?.created.channels ?? []));
    const agentPlan = classifyAgents(prepared.agents, roster, prior);
    let membership: Awaited<ReturnType<typeof ep.readMembership>> | null = null;
    try { membership = await ep.readMembership(); } catch { /* only a lower bound on unmanaged readers */ }
    const unmanaged = detectUnmanagedActors(prepared.manifest.channels.map((channel) => channel.name), membership, roster,
      { ids: new Set((prior?.created.agents ?? []).map((agent) => agent.id)), names: new Set((prior?.created.agents ?? []).map((agent) => agent.name)) });
    return {
      kind: "native-additive-team-inspection" as const, space, root, runtime, priorDeploymentId: prior?.runId ?? null,
      roster: "complete-native-presence-scan" as const, registry: "complete-native-scan" as const,
      managerReadiness: "not-checked" as const, runtimeAvailability: "not-checked" as const,
      channels: {
        create: channelPlan.create.map((channel) => channel.name), owned: channelPlan.owned.map((channel) => channel.name),
        existsUnmanaged: channelPlan.existsUnmanaged.map(({ channel }) => channel.name),
        existsUnmanagedPolicy: channelPlan.existsUnmanaged.map(({ channel, live }) => ({ name: channel.name,
          differingDeclaredFields: (["description", "instructions", "replay", "replayWindow", "deliveryClass"] as const).filter((field) => channel[field] !== undefined && channel[field] !== live[field]),
        })),
      },
      agents: agentPlan.entries.map((entry) => ({ name: entry.agent.name, disposition: entry.disposition,
        recordedId: entry.prior?.id ?? null, recordedName: entry.prior?.name ?? null, runningByName: entry.running ?? null })),
      unmanaged: { feedAvailable: unmanaged.feedAvailable, asOf: unmanaged.asOf ?? null,
        perChannel: unmanaged.perChannel.map((entry) => ({ channel: entry.channel, actors: entry.actors.map((actor) => ({ id: actor.id, via: actor.via })) })),
        presentUnowned: unmanaged.presentUnowned.map((peer) => ({ id: peer.id, name: peer.name })) },
      effectAttempted: false as const,
    };
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the native registry, roster or prior ledger read did not finish; no additive effect was prepared", { target });
  } finally {
    try { await ep.stop(); }
    catch { throw new CommandFailure("failed", "OPERATION_FAILED", "the native additive inspection reader did not confirm closure; no agent or channel was added", { target }); }
  }
}
