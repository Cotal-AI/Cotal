/**
 * Apply helpers shared by `up -f` / `spawn -f`: turn a {@link PreparedManifest} into the artifacts
 * the launch needs — the channel-registry seed, the resolved launch spec (written for the manager's
 * `supervise --launch`), and the connector-availability preflight. No broker lifecycle here (that's
 * the command), so this stays reusable across both verbs.
 */
import { renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureDirNoSymlink, type ChannelConfig, type ChannelRegistryFile, type Connector, type MeshLaunchAgent, type MeshLaunchSpec } from "@cotal-ai/core";
import { resolveOnPath } from "@cotal-ai/workspace";
import { materializeExtension } from "../../ext-loader.js";
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
    variant: a.variant ?? null,
    // Sort keys so an identical option set hashes identically (map insertion order must not drift).
    launchOptions: a.launchOptions ? Object.fromEntries(Object.entries(a.launchOptions).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : null,
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
    variant: a.variant,
    launchOptions: a.launchOptions,
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

/** Build the launch spec the manager boots from. `owner` (user-auth meshes) is the logged-in
 *  operator every launched agent runs under — resolved by the caller at apply time. */
export function buildLaunchSpec(prepared: PreparedManifest, runId: string, owner?: string): MeshLaunchSpec {
  return {
    apiVersion: "cotal-launch/v1",
    space: prepared.manifest.space,
    runId,
    ...(owner ? { owner } : {}),
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

/** Preflight the connectors: MATERIALIZE every distinct connector type from the manifest (seeded or
 *  `ext add`ed — nothing static-imports them on the published binary) and require its binaries on
 *  PATH. Fail before any mutation (no fallback). Returns an error sentence, or "". */
export async function preflightConnectors(prepared: PreparedManifest): Promise<string> {
  const types = [...new Set(prepared.agents.map((a) => a.agentType))];
  const problems: string[] = [];
  for (const type of types) {
    let connector: Connector;
    try {
      connector = await materializeExtension<Connector>({ kind: "connector", name: type });
    } catch (e) {
      problems.push((e as Error).message);
      continue;
    }
    const missing = (connector.requires ?? []).filter((bin) => !resolveOnPath(bin));
    if (missing.length) problems.push(`${type} needs ${missing.join(", ")} on PATH`);
    const variantUsers = prepared.agents.filter((a) => a.agentType === type && a.variant);
    if (variantUsers.length && !connector.supportsModelVariant)
      problems.push(`${type} does not support model variants (used by ${variantUsers.map((a) => a.name).join(", ")})`);
  }
  return problems.join("; ");
}
