import { join } from "node:path";
import { mkSecretDir, registry, resolveAuthProvider, writeSecretFileAtomic, type AuthProvider, type AuthSpaceCatalogAccount, type AuthSpaceCatalogResult, type FlagSpec, type FlagValues, type ParsedArgs, type SpaceCatalogConsumer } from "@cotal-ai/core";
import {
  clearCurrent,
  findCotalRoot,
  findMesh,
  getCurrent,
  homeCotalDir,
  loadMeshes,
  meshesForRoot,
  recordMesh,
  removeMesh,
  userAuthStateDir,
  type MeshEntry,
} from "@cotal-ai/workspace";
import { checkUserBundle, type UserBundle } from "./meshes-add.js";
import { c } from "../ui.js";

export interface CatalogSpace {
  id: string;
  slug: string;
  name: string;
  kind: string;
  role: string;
  registration: UserBundle;
}

export interface SpaceCatalogSnapshot {
  v: 1;
  account: { idpUrl: string; issuer: string; sub: string };
  spaces: CatalogSpace[];
}

export interface CatalogDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
  collisions: string[];
  selectionInvalidated?: string;
}

const syncFlags = [
  { name: "idp", type: "string", value: "<auth base URL>", description: "refresh only this signed-in IdP account" },
] as const satisfies readonly FlagSpec[];
export { syncFlags };

type SyncValues = FlagValues<typeof syncFlags>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateCatalogSnapshot(value: unknown, account: AuthSpaceCatalogAccount): asserts value is SpaceCatalogSnapshot {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.account) || !Array.isArray(value.spaces))
    throw new Error("the space catalog is not a v1 snapshot");
  if (value.account.idpUrl !== account.idpUrl || value.account.issuer !== account.issuer || value.account.sub !== account.sub)
    throw new Error("the space catalog account does not match the proved login");
  const names = new Set<string>();
  for (let i = 0; i < value.spaces.length; i++) {
    const row = value.spaces[i];
    if (!isRecord(row)) throw new Error(`space catalog entry ${i + 1} is not an object`);
    for (const key of ["id", "slug", "name", "kind", "role"] as const)
      if (typeof row[key] !== "string" || row[key].length === 0)
        throw new Error(`space catalog entry ${i + 1} has no ${key}`);
    const checked = checkUserBundle(JSON.stringify(row.registration));
    if (!checked.ok) throw new Error(`space catalog entry "${row.name}": ${checked.message.replace(/^✗ /, "")}`);
    if (checked.value.space !== row.name)
      throw new Error(`space catalog entry "${row.name}" registration names space "${checked.value.space}"`);
    if (names.has(row.name)) throw new Error(`space catalog repeats the name "${row.name}"`);
    names.add(row.name);
    row.registration = checked.value;
  }
}

function catalogRoot(ownerKey: string, space: string): string {
  return join(homeCotalDir(), "catalog", ownerKey, encodeURIComponent(space));
}

function entryFor(account: AuthSpaceCatalogAccount, row: CatalogSpace, fetchedAt?: string, error?: string): MeshEntry {
  const root = catalogRoot(account.ownerKey, row.name);
  const dir = userAuthStateDir(root, row.name);
  const sentinelCredsPath = join(dir, "sentinel.creds");
  return {
    space: row.name,
    server: row.registration.server,
    root,
    mode: "user",
    origin: "catalog",
    catalogOwner: account.ownerKey,
    catalogId: row.id,
    catalogSlug: row.slug,
    catalogName: row.name,
    catalogKind: row.kind,
    catalogRole: row.role,
    ...(fetchedAt ? { catalogFetchedAt: fetchedAt } : {}),
    ...(error ? { catalogError: error } : {}),
    ...(row.registration.tlsRequired ? { tlsRequired: true } : {}),
    userAuth: { ...row.registration.userAuth, remote: true, sentinelCredsPath },
    ts: new Date().toISOString(),
  };
}

function writeCatalogCredential(entry: MeshEntry, row: CatalogSpace): void {
  const path = entry.userAuth?.sentinelCredsPath;
  if (!path) throw new Error(`catalog registration for "${entry.space}" has no sentinel credential path`);
  mkSecretDir(userAuthStateDir(entry.root, entry.space));
  writeSecretFileAtomic(path, row.registration.sentinelCreds);
}

function sameEntry(a: MeshEntry, b: MeshEntry): boolean {
  const clean = (m: MeshEntry) => ({ ...m, ts: undefined, catalogFetchedAt: undefined, catalogError: undefined });
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

function applyResult(result: AuthSpaceCatalogResult): CatalogDiff {
  const before = loadMeshes().filter((m) => m.origin === "catalog" && m.catalogOwner === result.account.ownerKey);
  const priorByName = new Map(before.map((m) => [m.space, m]));
  const diff: CatalogDiff = { added: [], changed: [], removed: [], unchanged: [], collisions: [] };
  if (result.state === "failed") {
    for (const old of before)
      recordMesh({ ...old, ...(result.fetchedAt ? { catalogFetchedAt: result.fetchedAt } : {}), catalogError: result.error ?? "refresh failed" });
    return diff;
  }
  if (result.snapshot === undefined) return diff;
  validateCatalogSnapshot(result.snapshot, result.account);
  const snapshot = result.snapshot;
  const nextNames = new Set(snapshot.spaces.map((s) => s.name));
  for (const old of before) {
    if (nextNames.has(old.space)) continue;
    removeMesh(old.space);
    diff.removed.push(old.space);
  }
  for (const row of snapshot.spaces) {
    const existing = findMesh(row.name);
    if (existing && (existing.origin !== "catalog" || existing.catalogOwner !== result.account.ownerKey)) {
      diff.collisions.push(row.name);
      continue;
    }
    const next = entryFor(result.account, row, result.fetchedAt);
    const prior = priorByName.get(row.name);
    writeCatalogCredential(next, row);
    recordMesh(next);
    if (!prior) diff.added.push(row.name);
    else if (sameEntry(prior, next)) diff.unchanged.push(row.name);
    else diff.changed.push(row.name);
  }
  const current = getCurrent();
  if (current && diff.removed.includes(current)) {
    clearCurrent();
    diff.selectionInvalidated = current;
  }
  for (const list of [diff.added, diff.changed, diff.removed, diff.unchanged, diff.collisions]) list.sort();
  return diff;
}

export async function prepareCatalogTargets(opts: { idpUrl?: string; force?: boolean } = {}): Promise<{ results: AuthSpaceCatalogResult[]; diffs: CatalogDiff[] }> {
  const provider = resolveAuthProvider();
  if (!provider.prepareSpaceCatalogs)
    throw new Error(`auth provider "${provider.name}" does not support space catalogs`);
  const results = await provider.prepareSpaceCatalogs({
    dir: homeCotalDir(),
    ...(opts.idpUrl ? { idpUrl: opts.idpUrl } : {}),
    ...(opts.force ? { force: true } : {}),
    validate: validateCatalogSnapshot,
  });
  if (results.every((r) => r.state === "no-catalog" && r.snapshot === undefined))
    return { results, diffs: results.map(() => ({ added: [], changed: [], removed: [], unchanged: [], collisions: [] })) };
  const diffs = results.map(applyResult);
  return { results, diffs };
}

/** Shared once-per-command preparation. A named manual/local entry never depends on discovery.
 * Unknown names force one refresh even inside the freshness window. `status` keeps a failed stale
 * snapshot only as timestamped diagnostics; operational commands refuse before target resolution. */
export async function prepareCatalogCommand(args: ParsedArgs, diagnostics = false): Promise<void> {
  const values = args.values as { space?: string };
  const named = values.space ? findMesh(values.space) : undefined;
  if (named && named.origin !== "catalog") return;
  if (!values.space) {
    const current = getCurrent();
    const selected = current ? findMesh(current) : undefined;
    if (selected && selected.origin !== "catalog") return;
    const local = meshesForRoot(findCotalRoot()).filter((m) => m.origin !== "catalog");
    if (local.length > 0) return;
    const registered = loadMeshes();
    if (registered.length === 1 && registered[0].origin !== "catalog") return;
  }
  const force = Boolean(values.space && !named);
  if (registry.all<AuthProvider>("auth-provider").length === 0) return;
  const provider = resolveAuthProvider();
  if (!provider.prepareSpaceCatalogs) return;
  const results = await provider.prepareSpaceCatalogs({
    dir: homeCotalDir(),
    ...(named?.origin === "catalog" && named.userAuth?.idp.url ? { idpUrl: named.userAuth.idp.url } : {}),
    ...(force ? { force: true } : {}),
    validate: validateCatalogSnapshot,
  });
  if (results.every((r) => r.state === "no-catalog" && r.snapshot === undefined)) return;
  const diffs = results.map(applyResult);
  const vanished = diffs.map((d) => d.selectionInvalidated).filter((s): s is string => Boolean(s));
  if (vanished.length) {
    const message = `selected space "${vanished.join("\", \"")}" vanished from its account catalog; no default mesh is selected`;
    if (diagnostics) console.error(c.yellow(message));
    else throw new Error(message);
  }
  if (diagnostics) return;
  const failures = results.filter((r) => r.state === "failed");
  if (failures.length)
    throw new Error(failures.map((r) => `space catalog for ${r.account.idpUrl} failed: ${r.error}`).join("; "));
}

export async function sync(args: ParsedArgs): Promise<void> {
  const values = args.values as SyncValues;
  const { results, diffs } = await prepareCatalogTargets({ idpUrl: values.idp, force: true });
  if (results.length === 0) {
    console.log(c.dim("no signed-in IdP accounts"));
    return;
  }
  results.forEach((result, i) => {
    const d = diffs[i];
    const catalog = result.account.catalogUrl ? result.account.catalogUrl : "no catalog advertised";
    console.log(`${result.account.idpUrl}  ${result.state}  ${catalog}`);
    for (const [label, names] of [["added", d.added], ["changed", d.changed], ["removed", d.removed], ["unchanged", d.unchanged], ["collisions", d.collisions]] as const)
      console.log(`  ${label.padEnd(10)} ${names.length ? names.join(", ") : "-"}`);
    if (d.selectionInvalidated)
      console.log(c.yellow(`  selected space "${d.selectionInvalidated}" vanished; no default mesh is selected`));
  });
  const failures = results.filter((r) => r.state === "failed");
  if (failures.length)
    throw new Error(failures.map((r) => `space catalog for ${r.account.idpUrl} failed: ${r.error}`).join("; "));
}

const spaceCatalogConsumer: SpaceCatalogConsumer = {
  kind: "space-catalog-consumer",
  name: "workspace",
  validate: validateCatalogSnapshot,
  apply: (result) => void applyResult(result),
};

registry.register(spaceCatalogConsumer);
