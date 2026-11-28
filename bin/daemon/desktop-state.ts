/** Space discovery stays in the daemon, next to the sign-in that authorizes it. */
import { resolve } from "node:path";
import type { AuthSpaceCatalogResult } from "@cotal-ai/core";
import { forgetLocalSpaceRegistration, prepareCatalogTargets, type SpaceCatalogSnapshot } from "@cotal-ai/cli";
import { CommandFailure, homeCotalDir, isCommandFailure, readMeshRegistry, resolveNativeMigration, withProjectTrustMigration, type MeshEntry } from "@cotal-ai/workspace";
import { listIdpAccounts, normalizeIdpUrl } from "@cotal-ai/auth";
import { isDaemonSpaceName, type DaemonSpaces, type EndorsedMigration, type SpaceCollision } from "./protocol.js";

function originOf(entry: MeshEntry): "manual" | "catalog" | "up" {
  return entry.origin === "manual" || entry.origin === "catalog" ? entry.origin : "up";
}

function collectCollisions(results: readonly AuthSpaceCatalogResult[], entries: readonly MeshEntry[]): SpaceCollision[] {
  const bySpace = new Map(entries.map((entry) => [entry.space, entry]));
  const details: SpaceCollision[] = [];
  for (const r of results) {
    const spaces = (r.snapshot as SpaceCatalogSnapshot | undefined)?.spaces ?? [];
    for (const s of spaces) {
      if (!isDaemonSpaceName(s.slug)) continue;
      const existing = bySpace.get(s.slug);
      if (!existing) continue;
      if (existing.origin === "catalog" && existing.catalogOwner === r.account.ownerKey) continue;
      details.push({
        space: s.slug,
        catalogLabel: s.name,
        catalogIdp: r.account.idpUrl,
        existingOrigin: originOf(existing),
        ...(existing.userAuth?.idp.url ? { existingIdp: existing.userAuth.idp.url } : {}),
      });
    }
  }
  return details.sort((a, b) => a.space.localeCompare(b.space) || a.catalogIdp.localeCompare(b.catalogIdp));
}

async function detectEndorsedMigration(collisionDetails: readonly SpaceCollision[], entries: readonly MeshEntry[]): Promise<EndorsedMigration | undefined> {
  const pair = collisionDetails.find((c) => c.existingOrigin === "catalog" && c.existingIdp && c.existingIdp !== c.catalogIdp && c.existingIdp.startsWith("https://") && c.catalogIdp.startsWith("https://"));
  if (!pair?.existingIdp) return undefined;
  const fromIdp = pair.existingIdp;
  const toIdp = pair.catalogIdp;
  const endorsement = await readEndorsedTarget(fromIdp, entries);
  if (!endorsement || endorsement !== normalizeIdpUrl(toIdp)) return undefined;
  const spaces = collisionDetails.filter((c) => c.existingOrigin === "catalog" && c.existingIdp === fromIdp && c.catalogIdp === toIdp).map((c) => c.space);
  return spaces.length ? { fromIdp: normalizeIdpUrl(fromIdp), toIdp: endorsement, spaces } : undefined;
}

async function readEndorsedTarget(fromIdp: string, entries: readonly MeshEntry[]): Promise<string | undefined> {
  const oldEntries = entries.filter((entry) => entry.origin === "catalog" && entry.userAuth && entry.userAuth.idp.url === fromIdp);
  const pins = new Map(oldEntries.map((entry) => [JSON.stringify([entry.userAuth!.idp.issuer, entry.userAuth!.idp.audience]), entry.userAuth!.idp]));
  if (!oldEntries.length || pins.size !== 1) return undefined;
  const trusted = [...pins.values()][0]!;
  try {
    const resolution = await resolveNativeMigration({ url: normalizeIdpUrl(fromIdp), issuer: trusted.issuer, audience: trusted.audience });
    return normalizeIdpUrl(resolution.bundle.userAuth.idp.url);
  } catch { return undefined; }
}

async function filterSupersededAccounts(results: readonly AuthSpaceCatalogResult[], diffs: readonly { collisions: string[] }[], entries: readonly MeshEntry[]) {
  if (results.length < 2) return { results, diffs };
  const bySpace = new Map(entries.map((entry) => [entry.space, entry]));
  const superseded = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const fromUrl = normalizeIdpUrl(r.account.idpUrl);
    if (!fromUrl.startsWith("https://") || entries.some((e) => e.origin === "catalog" && e.catalogOwner === r.account.ownerKey)) continue;
    const collidingOwners = diffs[i]!.collisions.map((slug) => bySpace.get(slug)).filter((e): e is MeshEntry => e?.origin === "catalog" && Boolean(e.userAuth?.idp.url));
    if (!collidingOwners.length || collidingOwners.length !== diffs[i]!.collisions.length) continue;
    const targetIdps = new Set(collidingOwners.map((e) => normalizeIdpUrl(e.userAuth!.idp.url)));
    const pins = new Map(collidingOwners.map((e) => [JSON.stringify([e.userAuth!.idp.issuer, e.userAuth!.idp.audience]), e.userAuth!.idp]));
    if (targetIdps.size !== 1 || pins.size !== 1) continue;
    const targetIdp = [...targetIdps][0]!;
    const trusted = [...pins.values()][0]!;
    if (!results.some((other) => normalizeIdpUrl(other.account.idpUrl) === targetIdp && other.account.sub === r.account.sub)) continue;
    try {
      const resolution = await resolveNativeMigration({ url: fromUrl, issuer: trusted.issuer, audience: trusted.audience });
      if (normalizeIdpUrl(resolution.bundle.userAuth.idp.url) === targetIdp) superseded.add(fromUrl);
    } catch { /* not endorsed */ }
  }
  if (!superseded.size) return { results, diffs };
  return {
    results: results.filter((r) => !superseded.has(normalizeIdpUrl(r.account.idpUrl))),
    diffs: diffs.filter((_, i) => !superseded.has(normalizeIdpUrl(results[i]!.account.idpUrl))),
  };
}

async function detectSignedInMigration(signedInProviders: readonly string[], entries: readonly MeshEntry[]): Promise<EndorsedMigration | undefined> {
  if (signedInProviders.length < 2) return undefined;
  const signedInSet = new Set(signedInProviders.map((url) => normalizeIdpUrl(url)));
  for (const fromUrl of signedInSet) {
    if (!fromUrl.startsWith("https://")) continue;
    const oldSpaces = entries.filter((entry) => entry.origin === "catalog" && entry.userAuth && normalizeIdpUrl(entry.userAuth.idp.url) === fromUrl).map((entry) => entry.space);
    if (!oldSpaces.length) continue;
    const endorsement = await readEndorsedTarget(fromUrl, entries);
    if (endorsement && endorsement !== fromUrl && signedInSet.has(endorsement)) {
      return { fromIdp: fromUrl, toIdp: endorsement, spaces: oldSpaces.sort() };
    }
  }
  return undefined;
}

export async function desktopSpaces(sessionDir: string, refresh: boolean): Promise<DaemonSpaces> {
  let outcome: DaemonSpaces["refresh"] = "not-requested";
  let collisions = 0;
  let failedProviders: string[] = [];
  let refreshResults: readonly AuthSpaceCatalogResult[] = [];
  if (refresh) {
    const raw = await withProjectTrustMigration(true, false, () => prepareCatalogTargets({ sessionDir, force: true }));
    const afterRefresh = readMeshRegistry();
    const { results, diffs } = await filterSupersededAccounts(raw.results, raw.diffs, afterRefresh.entries);
    refreshResults = results;
    failedProviders = results.filter((result) => result.state === "failed").map(result => result.account.idpUrl);
    const failures = failedProviders.length;
    collisions = diffs.reduce((count, diff) => count + diff.collisions.length, 0);
    if (raw.results.length === 0) outcome = "not-signed-in";
    else outcome = failures === 0 ? (collisions ? "partial" : "complete") : failures === results.length ? "failed" : "partial";
  }
  const { entries, unusable } = readMeshRegistry();
  const signedInProviders = listIdpAccounts(sessionDir).filter((account) => account.expiresAt > Math.floor(Date.now() / 1000)).map((account) => account.idp);
  const collisionDetails = collisions ? collectCollisions(refreshResults, entries) : [];
  const migration = collisionDetails.length ? await detectEndorsedMigration(collisionDetails, entries) : await detectSignedInMigration(signedInProviders, entries);
  const addressable = entries.filter((entry) => isDaemonSpaceName(entry.space));
  return {
    kind: "spaces",
    refresh: outcome,
    unreadable: unusable.length + entries.length - addressable.length,
    collisions,
    ...(collisionDetails.length ? { collisionDetails } : {}),
    ...(migration ? { migration } : {}),
    failedProviders,
    signedInProviders,
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

/** Replace one non-catalog registration with a signed-in account's catalog entry when no local stack runs it. */
export async function resolveSpaceConflict(sessionDir: string, space: string, idp: string): Promise<DaemonSpaces> {
  if (resolve(sessionDir) !== resolve(homeCotalDir()))
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "Space registrations can only be changed in the default Cotal home.");
  const { entries } = readMeshRegistry();
  const existing = entries.find((entry) => entry.space === space);
  if (!existing) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `No space named "${space}" is registered on this computer.`);
  if (existing.origin === "catalog") {
    const source = existing.userAuth?.idp.url ?? "another signed-in account";
    throw new CommandFailure("refused", "CONFLICT", `"${space}" belongs to ${source}. Move or sign out of that account instead of replacing one space.`);
  }
  await withProjectTrustMigration(true, false, async () => {
    try {
      await forgetLocalSpaceRegistration(space);
    } catch (e) {
      if (isCommandFailure(e) && e.code === "LIFECYCLE_BLOCKED")
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `"${space}" is currently running on this computer. Stop that local space first, or keep the local registration.`);
      if (isCommandFailure(e)) throw e;
      throw e;
    }
    await prepareCatalogTargets({ sessionDir, idpUrl: idp, force: true });
  });
  return desktopSpaces(sessionDir, true);
}
