/**
 * The daemon's connection readiness for one space (A2b.1). It answers whether this machine's daemon
 * could register with the space as its own service, and if not, exactly why. It never registers,
 * holds no bearer and starts nothing.
 *
 * Every input is stock: the mesh registry entry (`findMesh`), the machine's stock IdP session
 * (`loadIdpSession`), and the registered auth provider's `serviceEndpointInfo`, which reads the
 * space's stock service authority route (GET only, no redirects, closed parser). A 404 there means the
 * space does not host service endpoints (stock `serviceEndpoints` is off by default); the daemon
 * reports that, and never falls back to a Manager view, `manager.vitals` or static credentials.
 *
 * The daemon's identity is its own, separate from the stock Manager identity: one record per
 * (machine home, space) under `<COTAL_HOME>/daemon/<space segment>/service-identity.json`, created
 * once through stock `claimIdentityRecord` (exclusive create, one winner). It pins the space's
 * DATA account on first sight; a later different account is a mismatch, never a silent repin. It
 * holds no credential, owner, hostname or hardware id.
 */
import { join } from "node:path";
import { assertLifecycleToken, isAccountNkey, mintLifecycleUid, resolveAuthProvider } from "@cotal-ai/core";
import { claimIdentityRecord, findMesh, homeCotalDir, spaceSegment, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { loadIdpSession } from "@cotal-ai/auth";
import type { ConnectCheckResult } from "./protocol.js";

/** The service name the daemon proposes for itself. Single-label names are reserved for reference
 *  endpoints and a third-party name must be reverse-DNS, so this is the reverse-DNS of cotal.ai.
 *  Binding it still needs the space operator's `name-bind`; the daemon never claims it. */
export const DAEMON_ENDPOINT = "ai.cotal.machine";

const KIND = "cotal-daemon-service-identity";

export interface DaemonServiceIdentity {
  readonly v: 1;
  readonly kind: typeof KIND;
  readonly space: string;
  readonly endpoint: typeof DAEMON_ENDPOINT;
  readonly instanceId: string;
  readonly accountPublicKey: string;
}

/** Where this machine's daemon keeps its identity for `space`. */
export function daemonIdentityFile(space: string, home: string = homeCotalDir()): string {
  return join(home, "daemon", spaceSegment(space), "service-identity.json");
}

function parseIdentity(space: string) {
  return (raw: unknown): DaemonServiceIdentity | undefined => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    const keys = Object.keys(o).sort().join(",");
    if (keys !== "accountPublicKey,endpoint,instanceId,kind,space,v") return undefined;
    if (o.v !== 1 || o.kind !== KIND || o.space !== space || o.endpoint !== DAEMON_ENDPOINT || !isAccountNkey(o.accountPublicKey)) return undefined;
    if (typeof o.instanceId !== "string") return undefined;
    try { assertLifecycleToken(o.instanceId, "instanceId"); } catch { return undefined; }
    return o as unknown as DaemonServiceIdentity;
  };
}

/** The fixed sentence per failure. Nothing from the remote side is quoted. */
const SENTENCE = {
  "not-registered": "this space is not registered on this machine; add it with `cotal meshes add`",
  "not-user-auth": "this space does not use user sign-in, so the daemon cannot connect to it as its own service",
  "not-signed-in": "this machine is not signed in to the space's provider; run `cotal daemon login --idp <url>`",
  "unsupported-by-space": "the space's auth service does not host service endpoints, so the daemon cannot register with it",
  unreachable: "the space's auth service could not be reached",
  refused: "the space's auth service gave an answer the daemon cannot use",
} as const;

/** Check readiness for `space`. `home` is the machine home where the stock session and the daemon's
 *  own state live. */
export async function connectCheck(space: string, home: string = homeCotalDir()): Promise<ConnectCheckResult> {
  const entry = findMesh(space);
  if (!entry) return { outcome: "not-registered", space, message: SENTENCE["not-registered"] };
  const ua = entry.mode === "user" ? entry.userAuth : undefined;
  if (!ua) return { outcome: "not-user-auth", space, message: SENTENCE["not-user-auth"] };
  let session;
  try { session = loadIdpSession(home, ua.idp.url); } catch { session = undefined; }
  if (!session) return { outcome: "not-signed-in", space, message: SENTENCE["not-signed-in"] };

  let accountPublicKey: string;
  try {
    const provider = resolveAuthProvider();
    if (!provider.serviceEndpointInfo) return { outcome: "unsupported-by-space", space, message: SENTENCE["unsupported-by-space"] };
    const info = await provider.serviceEndpointInfo({ store: workspaceSecretStore(entry.root), dir: userAuthStateDir(entry.root, space, { readOnly: true }), space });
    accountPublicKey = info.accountPublicKey;
  } catch (e) {
    const status = (e as { httpStatus?: number }).httpStatus;
    if (status === 404) return { outcome: "unsupported-by-space", space, message: SENTENCE["unsupported-by-space"] };
    if (status === undefined && (e as { outcome?: string }).outcome === "not-executed" && /did not return a response/.test((e as Error).message))
      return { outcome: "unreachable", space, message: SENTENCE.unreachable };
    return { outcome: "refused", space, message: SENTENCE.refused };
  }

  const identity = claimIdentityRecord(daemonIdentityFile(space, home), "daemon service identity", parseIdentity(space), () => ({
    v: 1, kind: KIND, space, endpoint: DAEMON_ENDPOINT, instanceId: mintLifecycleUid(), accountPublicKey,
  }));
  if (identity.accountPublicKey !== accountPublicKey)
    return { outcome: "account-mismatch", space, pinnedAccountPublicKey: identity.accountPublicKey, observedAccountPublicKey: accountPublicKey,
      message: "the space now answers with a different account than this daemon pinned; nothing was changed. Confirm the space was not replaced before removing the daemon's identity for it by hand" };
  return { outcome: "ready-to-register", space, endpoint: DAEMON_ENDPOINT, instanceId: identity.instanceId, accountPublicKey,
    message: "this daemon can ask the space to register it; the space owner must still approve it, and nothing has been registered" };
}
