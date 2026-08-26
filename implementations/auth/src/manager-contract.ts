import {
  authorizeTrustedServeSnapshot,
  contractDigest,
  remoteManagerActors,
  type EpCommandAuthority,
  type EpGateState,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";

/** Canonical manager surface mirrored from @cotal-ai/manager's contract source. The activation
 * protocol verifies the submitted cluster document matches this exact security-relevant shape;
 * schemas remain content-addressed artifacts and their digests ride each command. */
export function reconstructRemoteManagerServeGrant(
  request: RemoteManagerAuthorityRequest,
  owner: string,
  _serveActor: string,
  observed: EpGateState,
) {
  const artifacts = request.contractArtifacts ?? [];
  const cluster = artifacts.find((value) => value && typeof value === "object" && (value as { urn?: unknown }).urn === "ai.cotal.manager") as {
    urn?: string;
    revision?: number;
    commands?: Array<{ name?: string; class?: string; targeted?: boolean; modes?: string[]; capability?: string; inputDigest?: string; outputDigest?: string; traits?: string[] }>;
  } | undefined;
  if (!cluster || !Number.isSafeInteger(cluster.revision) || !Array.isArray(cluster.commands) || cluster.commands.length === 0)
    throw new Error("manager-service activation did not carry the canonical manager cluster document");
  const surface: Record<string, EpCommandAuthority> = Object.create(null);
  for (const command of cluster.commands) {
    if (typeof command.name !== "string" || command.class !== "ephemeral" || typeof command.targeted !== "boolean" ||
        typeof command.capability !== "string" || typeof command.inputDigest !== "string" || typeof command.outputDigest !== "string")
      throw new Error("manager-service activation carried a malformed manager command declaration");
    if (surface[command.name]) throw new Error(`manager-service activation duplicates command ${command.name}`);
    surface[command.name] = {
      clusterDigest: contractDigest(cluster),
      class: "ephemeral",
      targeted: command.targeted,
      modes: (command.modes ?? []) as EpCommandAuthority["modes"],
      capability: command.capability,
      inputDigest: command.inputDigest,
      outputDigest: command.outputDigest,
      traits: command.traits ?? [],
    };
  }
  const actors = remoteManagerActors(request.instanceId);
  void actors;
  return authorizeTrustedServeSnapshot({
    space: request.space,
    endpoint: "manager",
    instanceId: request.instanceId,
    epoch: observed.processEpoch,
    owner,
    registrationRevision: observed.registrationRevision,
    nameAuthorityRevision: observed.nameAuthorityRevision,
    commands: Object.keys(surface),
    surface,
    descriptor: {
      endpoint: "manager",
      owner,
      clusters: [{ digest: contractDigest(cluster), commands: Object.keys(surface), document: cluster as Record<string, unknown> }],
      protocol: { v: 1 },
    },
  });
}
