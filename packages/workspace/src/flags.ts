import type { FlagSpec } from "@cotal-ai/core";

/**
 * The shared mesh-target flag bundle: which space, which broker, and (off-registry) which
 * credential. Every command that connects to a mesh spreads THIS bundle instead of declaring
 * its own copies, so the target vocabulary cannot drift between commands. Resolution order is
 * `resolveMeshTarget`'s: explicit flags > the folder's project > the registry/`current` mesh.
 */
export const targetFlags: readonly FlagSpec[] = [
  { name: "space", type: "string", value: "<s>", description: "target space (default: the resolved mesh)" },
  { name: "server", type: "string", value: "<url>", description: "broker URL (overrides the mesh registry entry)" },
  { name: "creds", type: "string", value: "<path>", description: "creds file for an off-registry connection" },
];
