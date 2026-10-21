import { canonicalRoot } from "./mesh-registry.js";
import { resolveMeshTarget, type MeshTarget } from "./mesh-target.js";
import { CommandFailure } from "./output.js";

/** Public coordinates only. Do not put resolved signer material in a server handler's closure. */
export type NativeServiceTarget = Pick<MeshTarget, "root" | "space" | "server" | "tlsRequired" | "mode">;

export function resolveNativeServiceTarget(root: string, space: string, server?: string, allowBrokerOverride = false): NativeServiceTarget {
  const target = resolveMeshTarget(root, { space, ...(allowBrokerOverride && server !== undefined ? { server } : {}), readOnly: true });
  if (canonicalRoot(target.root) !== canonicalRoot(root) || target.space !== space || !allowBrokerOverride && server !== undefined && server !== target.server) throw new CommandFailure("refused", "CONFLICT", "the service root, registered space and broker do not resolve to one target; no different target was substituted");
  let url: URL;
  try { url = new URL(target.server.includes("://") ? target.server : `nats://${target.server}`); }
  catch { throw new CommandFailure("refused", "UNSUPPORTED", "the native service preset requires one supported broker URL; no server list or credential-bearing URL was placed on argv"); }
  if (!["nats:", "tls:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash || url.search || target.server.includes(",")) throw new CommandFailure("refused", "UNSUPPORTED", "the native service preset requires one broker URL without credentials, query or fragment");
  return { root: target.root, space: target.space, server: target.server, tlsRequired: target.tlsRequired, mode: target.mode };
}
