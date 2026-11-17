/** Space discovery stays in the daemon, next to the sign-in that authorizes it. */
import { prepareCatalogTargets } from "@cotal-ai/cli";
import { readMeshRegistry } from "@cotal-ai/workspace";
import { listIdpAccounts } from "@cotal-ai/auth";
import { isDaemonSpaceName, type DaemonSpaces } from "./protocol.js";

export async function desktopSpaces(sessionDir: string, refresh: boolean): Promise<DaemonSpaces> {
  let outcome: DaemonSpaces["refresh"] = "not-requested";
  let collisions = 0;
  let failedProviders: string[] = [];
  if (refresh) {
    const { results, diffs } = await prepareCatalogTargets({ sessionDir, force: true });
    failedProviders = results.filter((result) => result.state === "failed").map(result => result.account.idpUrl);
    const failures = failedProviders.length;
    collisions = diffs.reduce((count, diff) => count + diff.collisions.length, 0);
    if (results.length === 0) outcome = "not-signed-in";
    else outcome = failures === 0 ? (collisions ? "partial" : "complete") : failures === results.length ? "failed" : "partial";
  }
  const { entries, unusable } = readMeshRegistry();
  const addressable = entries.filter((entry) => isDaemonSpaceName(entry.space));
  return {
    kind: "spaces",
    refresh: outcome,
    unreadable: unusable.length + entries.length - addressable.length,
    collisions,
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
