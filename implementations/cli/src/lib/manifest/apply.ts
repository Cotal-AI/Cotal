/**
 * Apply helpers shared by `up -f` / `spawn -f`: turn a {@link PreparedManifest} into the artifacts
 * the launch needs — the channel-registry seed, the resolved launch spec (written for the manager's
 * `supervise --launch`), and the connector-availability preflight. No broker lifecycle here (that's
 * the command), so this stays reusable across both verbs.
 */
import { renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureDirNoSymlink, registry, type ChannelConfig, type ChannelRegistryFile, type Connector, type MeshLaunchAgent, type MeshLaunchSpec } from "@cotal-ai/core";
import { resolveOnPath } from "@cotal-ai/workspace";
import type { PreparedManifest } from "./preflight.js";
import type { PreparedAgent } from "./prepare.js";
import type { ResolvedChannel } from "./model.js";

/** A path-safe run id naming the transient `.cotal/run/<runId>/` dir and tying to the ledger. */
export function genRunId(): string {
  return randomBytes(8).toString("hex");
}

/** Stable content hash of the resolved launch fields — connector + behavior + ACLs. A change here
 *  means a re-declared running agent is stale/restart-required (drift detection). */
export function hashAgent(a: PreparedAgent): string {
  const stable = JSON.stringify({
    agent: a.agentType,
    model: a.model ?? null,
    role: a.role ?? null,
    body: a.body ?? null,
    capabilities: [...a.capabilities].sort(),
    subscribe: [...a.policy.subscribe].sort(),
    allowSubscribe: [...a.policy.allowSubscribe].sort(),
    allowPublish: [...a.policy.allowPublish].sort(),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

/** Project a prepared agent into the resolved launch-spec form the manager consumes. */
function toLaunchAgent(a: PreparedAgent): MeshLaunchAgent {
  return {
    name: a.name,
    agent: a.agentType,
    role: a.role,
    model: a.model,
    description: a.description,
    body: a.body,
    capabilities: a.capabilities.length ? a.capabilities : undefined,
    subscribe: a.policy.subscribe,
    allowSubscribe: a.policy.allowSubscribe,
    allowPublish: a.policy.allowPublish,
    personaPath: a.persona,
    hash: hashAgent(a),
  };
}

/** Build the launch spec the manager boots from. */
export function buildLaunchSpec(prepared: PreparedManifest, runId: string): MeshLaunchSpec {
  return {
    apiVersion: "cotal-launch/v1",
    space: prepared.manifest.space,
    runId,
    agents: prepared.agents.map(toLaunchAgent),
  };
}

/** Write the launch spec to `<root>/.cotal/run/<runId>.json` (0600 — it carries persona text +
 *  policy) and return its path. A fresh run is exclusive-create (`wx`); a `spawn -f` re-apply reuses
 *  the runId, so `update` rewrites it atomically (temp-then-rename, exclusive temp — never follows a
 *  pre-planted symlink). Both refuse a symlinked `.cotal`/`run` parent. */
export function writeLaunchSpec(root: string, spec: MeshLaunchSpec, opts: { update?: boolean } = {}): string {
  const dir = ensureDirNoSymlink(root, ".cotal", "run");
  const path = join(dir, `${spec.runId}.json`);
  const body = JSON.stringify(spec, null, 2);
  if (opts.update) {
    const tmp = join(dir, `.${spec.runId}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } else {
    writeFileSync(path, body, { mode: 0o600, flag: "wx" });
  }
  return path;
}

/** A channel's registry card (description/instructions/replay…) in the shape `seedChannelRegistry`
 *  writes. Oversize description/instructions are rejected at the write path. */
function cardOf(ch: ResolvedChannel): ChannelConfig {
  return {
    ...(ch.description !== undefined ? { description: ch.description } : {}),
    ...(ch.instructions !== undefined ? { instructions: ch.instructions } : {}),
    ...(ch.replay !== undefined ? { replay: ch.replay } : {}),
    ...(ch.replayWindow !== undefined ? { replayWindow: ch.replayWindow } : {}),
    ...(ch.deliveryClass !== undefined ? { deliveryClass: ch.deliveryClass } : {}),
  };
}

/** The channel-registry seed (defaults + every per-channel card) — used by `up -f`, which owns the
 *  whole space. */
export function manifestToChannels(prepared: PreparedManifest): ChannelRegistryFile {
  const channels: Record<string, ChannelConfig> = {};
  for (const ch of prepared.manifest.channels) channels[ch.name] = cardOf(ch);
  return { ...(prepared.manifest.defaults ? { defaults: prepared.manifest.defaults } : {}), channels };
}

/** A seed of ONLY the given channels and NO defaults — for `spawn -f`, which seeds the brand-new
 *  keys it creates onto a shared mesh and must never rewrite the mesh-wide defaults or a pre-existing
 *  (unmanaged) card. */
export function channelsSeed(channels: ResolvedChannel[]): ChannelRegistryFile {
  const out: Record<string, ChannelConfig> = {};
  for (const ch of channels) out[ch.name] = cardOf(ch);
  return { channels: out };
}

/** Preflight the connectors: every distinct connector type must be registered and have its required
 *  binaries on PATH — fail before any mutation (no fallback). Returns an error sentence, or "". */
export function preflightConnectors(prepared: PreparedManifest): string {
  const types = [...new Set(prepared.agents.map((a) => a.agentType))];
  const problems: string[] = [];
  for (const type of types) {
    let connector: Connector;
    try {
      connector = registry.resolve<Connector>("connector", type);
    } catch {
      problems.push(`unknown connector "${type}" (no such agent type registered)`);
      continue;
    }
    const missing = (connector.requires ?? []).filter((bin) => !resolveOnPath(bin));
    if (missing.length) problems.push(`${type} needs ${missing.join(", ")} on PATH`);
  }
  return problems.join("; ");
}
