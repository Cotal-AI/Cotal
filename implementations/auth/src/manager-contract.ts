import {
  authorizeTrustedServeSnapshot,
  contractDigest,
  EpEnvelopeError,
  parseClusterDocument,
  type ClusterDocument,
  type EpCommandAuthority,
  type EpGateState,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";

/** A manager cluster document as core parsed it, with its root digest and the raw document a
 * descriptor inlines. */
export interface ManagerCluster {
  digest: string;
  document: ClusterDocument;
  raw: unknown;
}

/** The activation entry: derives the serve grant from the `ai.cotal.manager` document among the
 * request's submitted contract artifacts, through remoteManagerServeGrantFromCluster. */
export function reconstructRemoteManagerServeGrant(
  request: RemoteManagerAuthorityRequest,
  owner: string,
  observed: EpGateState,
) {
  const raw = (request.contractArtifacts ?? []).find((value) => value && typeof value === "object" && (value as { urn?: unknown }).urn === "ai.cotal.manager");
  if (raw === undefined) throw new EpEnvelopeError("bad-request", "the activation request submits no ai.cotal.manager cluster document");
  return remoteManagerServeGrantFromCluster(request, owner, { document: parseClusterDocument(raw), digest: contractDigest(raw), raw }, observed);
}

/** The command declarations of the manager cluster, in the shape a serve grant pins. */
export function remoteManagerSurface({ digest, document }: ManagerCluster): Record<string, EpCommandAuthority> {
  const surface: Record<string, EpCommandAuthority> = Object.create(null);
  for (const command of document.commands) {
    if (command.class !== "ephemeral")
      throw new EpEnvelopeError("failed-precondition", `the manager cluster declares ${command.class}-class command ${command.name}; every manager command is ephemeral`);
    surface[command.name] = {
      clusterDigest: digest,
      class: command.class,
      targeted: command.targeted,
      modes: command.modes ?? [],
      capability: command.capability,
      inputDigest: command.inputDigest,
      outputDigest: command.outputDigest,
      traits: command.traits ?? [],
    };
  }
  return surface;
}

/** One grant derivation for activation (the submitted canonical document) and standing renewal
 * (the document the registered service spec names in the content store). Renewal carries no
 * artifacts, so the same surface is re-derived from registered state rather than from the request. */
export function remoteManagerServeGrantFromCluster(
  request: Pick<RemoteManagerAuthorityRequest, "space" | "instanceId">,
  owner: string,
  cluster: ManagerCluster,
  observed: EpGateState,
) {
  const surface = remoteManagerSurface(cluster);
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
      clusters: [{ digest: cluster.digest, commands: Object.keys(surface), document: cluster.raw as Record<string, unknown> }],
      protocol: { v: 1 },
    },
  });
}
