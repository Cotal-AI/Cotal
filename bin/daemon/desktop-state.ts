/** Space discovery stays in the daemon, next to the sign-in that authorizes it. */
import { prepareCatalogTargets } from "@cotal-ai/cli";
import { isCommandFailure, readMeshRegistry } from "@cotal-ai/workspace";
import { listIdpAccounts } from "@cotal-ai/auth";
import { DAEMON_PROTOCOL_VERSION } from "./endpoint.js";
import { encode, isDaemonSpaceName, type DaemonRequest, type DaemonResponse, type DaemonSpaces } from "./protocol.js";
import { spacesFrames } from "./spaces-frames.js";

export async function replyToSpaces(sessionDir: string, request: Extract<DaemonRequest, { op: "spaces" }>,
  counters: { spacesAnswered: number; requestsRefused: number }, write: (line: string) => Promise<void>, connected: () => boolean): Promise<void> {
  const header = { v: DAEMON_PROTOCOL_VERSION, id: request.id };
  let result: DaemonSpaces;
  try { result = await desktopSpaces(sessionDir, request.refresh === true); }
  catch (error) {
    counters.requestsRefused++;
    const refusal: Extract<DaemonResponse, { ok: false }>["error"] = isCommandFailure(error) && error.code === "DEPENDENCY_UNAVAILABLE"
      ? { code: error.native?.code === "CATALOG_SYNC_BUSY" ? "CATALOG_SYNC_BUSY" : error.code, message: error.message, remedy: error.remedy }
      : { code: "SPACES_UNAVAILABLE", message: "the daemon could not read its spaces" };
    await write(encode({ ...header, ok: false, error: refusal }));
    return;
  }
  counters.spacesAnswered++;
  if (!connected()) return;
  for (const line of spacesFrames({ ...header, ok: true, result }, request.multipart ? "socket" : "single")) {
    await write(line);
    if (!connected()) return;
  }
}

const refreshes = new Map<string, Promise<DaemonSpaces>>();

function desktopSpaces(sessionDir: string, refresh: boolean): Promise<DaemonSpaces> {
  if (!refresh) return collectSpaces(sessionDir, false);
  // Waiters share the registry diff and listing as well as the provider fetch.
  const current = refreshes.get(sessionDir);
  if (current) return current;
  const work = collectSpaces(sessionDir, true).finally(() => refreshes.delete(sessionDir));
  refreshes.set(sessionDir, work);
  return work;
}

async function collectSpaces(sessionDir: string, refresh: boolean): Promise<DaemonSpaces> {
  let outcome: DaemonSpaces["refresh"] = "not-requested";
  let collisionDetails: DaemonSpaces["collisionDetails"] = [];
  let failedProviders: string[] = [];
  if (refresh) {
    const { results, diffs } = await prepareCatalogTargets({ sessionDir, force: true });
    failedProviders = results.filter((result) => result.state === "failed").map(result => result.account.idpUrl);
    const failures = failedProviders.length;
    collisionDetails = results.flatMap(({ account }, i) =>
      diffs[i]!.collisionDetails.map((entry) => ({ ...entry, idp: account.idpUrl })));
    if (results.length === 0) outcome = "not-signed-in";
    else outcome = failures === 0 ? (collisionDetails.length ? "partial" : "complete") : failures === results.length ? "failed" : "partial";
  }
  const { entries, unusable } = readMeshRegistry();
  const addressable = entries.filter((entry) => isDaemonSpaceName(entry.space));
  return {
    kind: "spaces",
    refresh: outcome,
    unreadable: unusable.length + entries.length - addressable.length,
    collisions: collisionDetails.length,
    collisionDetails,
    failedProviders,
    signedInProviders: listIdpAccounts(sessionDir).filter((account) => account.expiresAt > Math.floor(Date.now() / 1000)).map((account) => account.idp),
    spaces: addressable.map((entry) => ({
      space: entry.space,
      label: entry.catalogName ?? entry.space,
      ...(entry.catalogId ? { catalogId: entry.catalogId } : {}),
      ...(entry.catalogKind ? { kind: entry.catalogKind } : {}),
      ...(entry.catalogRole ? { role: entry.catalogRole } : {}),
      mode: entry.mode,
      ...(entry.mode === "user" && entry.userAuth ? { idp: entry.userAuth.idp.url } : {}),
    })),
  };
}
