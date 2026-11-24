/** Space discovery stays in the daemon, next to the sign-in that authorizes it. */
import { prepareCatalogTargets } from "@cotal-ai/cli";
import { meshFile, readMeshRegistry } from "@cotal-ai/workspace";
import { listIdpAccounts } from "@cotal-ai/auth";
import { isDaemonSpaceName, type DaemonSpaces } from "./protocol.js";

export async function desktopSpaces(sessionDir: string, refresh: boolean): Promise<DaemonSpaces> {
  const prepared = refresh ? await prepareCatalogTargets({ sessionDir, force: true }) : undefined;
  const { entries, unusable } = readMeshRegistry();
  const byName = new Map(entries.map(entry => [entry.space, entry]));
  const unreadableFiles = new Set(unusable.map(error => error.file));
  const collisionDetails: NonNullable<DaemonSpaces["collisionDetails"]> = prepared?.results.flatMap(({ account }, i) =>
    prepared.diffs[i]!.collisionDetails.flatMap(collision => {
      const held = byName.get(collision.space);
      if (held?.origin === "catalog" && held.catalogOwner === account.ownerKey) return [];
      const origin = unreadableFiles.has(meshFile(collision.space)) ? "unreadable" : held ? held.origin ?? "up" : "free";
      return [{ ...collision, origin, idp: account.idpUrl }];
    })) ?? [];
  const failedProviders = prepared?.results.filter(result => result.state === "failed").map(result => result.account.idpUrl) ?? [];
  const outcome = !prepared ? "not-requested" : !prepared.results.length ? "not-signed-in" :
    failedProviders.length === prepared.results.length ? "failed" : failedProviders.length || collisionDetails.length ? "partial" : "complete";
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
