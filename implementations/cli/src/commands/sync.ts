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
import { checkUserBundle, pinnedFetch, type UserBundle } from "./meshes-add.js";
import { c } from "../ui.js";

function sameRegistrationTrust(entry: MeshEntry, bundle: UserBundle): boolean {
  const ua = entry.userAuth;
  return entry.mode === "user" && ua !== undefined &&
    entry.space === bundle.space && entry.server === bundle.server && (entry.tlsRequired === true) === bundle.tlsRequired &&
    ua.idp.url === bundle.userAuth.idp.url && ua.idp.issuer === bundle.userAuth.idp.issuer &&
    ua.idp.audience === bundle.userAuth.idp.audience && ua.endpoints?.url === bundle.userAuth.endpoints?.url;
}

export const POLICY_FRESH_MS = 5_000;

async function refreshManualPolicy(entry: MeshEntry): Promise<void> {
  if (entry.origin !== "manual" || entry.mode !== "user" || entry.policy || !entry.userAuth?.endpoints?.url) return;
  const checkedAt = entry.policyCheckedAt ? Date.parse(entry.policyCheckedAt) : Number.NaN;
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < POLICY_FRESH_MS) return;
  let base: URL;
  try {
    base = new URL(entry.userAuth.endpoints.url);
  } catch {
    throw new Error(`manual registration for "${entry.space}" has an invalid pinned exchange URL`);
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/.well-known/cotal-mesh`;
  base.search = "";
  base.hash = "";
  let response: Response;
  try {
    response = await pinnedFetch(base.toString(), `manual registration "${entry.space}" policy refresh at ${entry.userAuth.endpoints.url}`);
  } catch (error) {
    throw new Error((error as Error).message.replace(/^✗ /, ""));
  }
  if (!response.ok)
    throw new Error(`manual registration "${entry.space}" policy refresh at ${entry.userAuth.endpoints.url} answered HTTP ${response.status}`);
  const checked = checkUserBundle(await response.text());
  if (!checked.ok) throw new Error(`manual registration "${entry.space}" policy refresh: ${checked.message.replace(/^✗ /, "")}`);
  if (!sameRegistrationTrust(entry, checked.value))
    throw new Error(`manual registration "${entry.space}" policy refresh returned different space, broker, transport, or user-auth trust pins`);
  recordMesh({ ...entry, ...(checked.value.policy ? { policy: checked.value.policy } : {}), policyCheckedAt: new Date().toISOString() });
}

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

/** Canonicalize an IdP identity for account binding with the same URL shape the stock provider
 * accepts: HTTPS, or loopback HTTP; no credentials, query, fragment, or trailing slash. This is not
 * a bundle validator. It compares already-validated registration trust to the proved account. */
function canonicalIdpUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(`${what} must be https (or loopback http for local development)`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`${what} must not contain credentials, a query, or a fragment`);
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function assertRegistrationAccountBinding(bundle: UserBundle, account: AuthSpaceCatalogAccount, label: string): void {
  const accountIdp = canonicalIdpUrl(account.idpUrl, "the proved account IdP URL");
  const registrationIdp = canonicalIdpUrl(bundle.userAuth.idp.url, `${label} IdP URL`);
  if (registrationIdp !== accountIdp || bundle.userAuth.idp.issuer !== account.issuer)
    throw new Error(`${label} names IdP trust that differs from the proved catalog account`);
  const accountOrigin = new URL(accountIdp).origin;
  for (const [name, raw] of [
    ["exchange endpoint", bundle.userAuth.endpoints?.url],
    ["agent-provisioning endpoint", bundle.userAuth.endpoints?.agentProvisioningUrl],
    ["manager-authority endpoint", bundle.userAuth.endpoints?.managerAuthorityUrl],
  ] as const) {
    if (!raw) continue;
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new Error(`${label} ${name} is not a valid URL`);
    }
    if (endpoint.username || endpoint.password || endpoint.origin !== accountOrigin)
      throw new Error(`${label} ${name} is not same-origin with the proved catalog account`);
  }
}

export function validateCatalogSnapshot(value: unknown, account: AuthSpaceCatalogAccount): asserts value is SpaceCatalogSnapshot {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.account) || !Array.isArray(value.spaces))
    throw new Error("the space catalog is not a v1 snapshot");
  if (value.account.idpUrl !== account.idpUrl || value.account.issuer !== account.issuer || value.account.sub !== account.sub)
    throw new Error("the space catalog account does not match the proved login");
  const slugs = new Set<string>();
  for (let i = 0; i < value.spaces.length; i++) {
    const row = value.spaces[i];
    if (!isRecord(row)) throw new Error(`space catalog entry ${i + 1} is not an object`);
    for (const key of ["id", "slug", "name", "kind", "role"] as const)
      if (typeof row[key] !== "string" || row[key].length === 0)
        throw new Error(`space catalog entry ${i + 1} has no ${key}`);
    const checked = checkUserBundle(JSON.stringify(row.registration));
    if (!checked.ok) throw new Error(`space catalog entry "${row.name}": ${checked.message.replace(/^✗ /, "")}`);
    assertRegistrationAccountBinding(checked.value, account, `space catalog entry "${row.name}"`);
    if (checked.value.space !== row.slug)
      throw new Error(`space catalog entry "${row.name}" (${row.slug}) registration names space "${checked.value.space}"`);
    if (slugs.has(row.slug)) throw new Error(`space catalog repeats the slug "${row.slug}"`);
    slugs.add(row.slug);
    row.registration = checked.value;
  }
}

function catalogRoot(ownerKey: string, space: string): string {
  return join(homeCotalDir(), "catalog", ownerKey, encodeURIComponent(space));
}

function entryFor(account: AuthSpaceCatalogAccount, row: CatalogSpace, fetchedAt?: string, error?: string): MeshEntry {
  const root = catalogRoot(account.ownerKey, row.slug);
  const dir = userAuthStateDir(root, row.slug);
  const sentinelCredsPath = join(dir, "sentinel.creds");
  return {
    space: row.slug,
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
    ...(row.registration.policy ? { policy: row.registration.policy } : {}),
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

const emptyDiff = (): CatalogDiff => ({ added: [], changed: [], removed: [], unchanged: [], collisions: [] });

/** One account can be applied twice in one preparation: a repair of an interrupted application,
 * then the refreshed snapshot. Report each slug against the registry the command started from, so
 * the first classification of a slug stands. */
function mergeDiff(prior: CatalogDiff | undefined, next: CatalogDiff): CatalogDiff {
  if (!prior) return next;
  const lists = ["added", "changed", "removed", "unchanged"] as const;
  const seen = new Set(lists.flatMap((k) => prior[k]));
  const merged: CatalogDiff = { ...prior, collisions: [...new Set([...prior.collisions, ...next.collisions])].sort() };
  for (const k of lists) merged[k] = [...prior[k], ...next[k].filter((s) => !seen.has(s))].sort();
  if (!merged.selectionInvalidated && next.selectionInvalidated) merged.selectionInvalidated = next.selectionInvalidated;
  return merged;
}

/** Reconcile the registry with one account's result. The provider calls this under its catalog
 * lock, so no other preparation reads or writes discovered entries while it runs, and it is
 * idempotent: the provider applies a cached snapshot again when an earlier application never
 * finished. An unforced fresh or not-modified result is already applied and writes nothing. */
function consume(result: AuthSpaceCatalogResult, force: boolean): CatalogDiff {
  return result.state === "updated" || result.state === "failed" || force ? applyResult(result) : emptyDiff();
}

function applyResult(result: AuthSpaceCatalogResult): CatalogDiff {
  const before = loadMeshes().filter((m) => m.origin === "catalog" && m.catalogOwner === result.account.ownerKey);
  const priorByName = new Map(before.map((m) => [m.space, m]));
  const diff = emptyDiff();
  if (result.state === "failed") {
    for (const old of before)
      recordMesh({ ...old, ...(result.fetchedAt ? { catalogFetchedAt: result.fetchedAt } : {}), catalogError: result.error ?? "refresh failed" });
    return diff;
  }
  if (result.snapshot === undefined) return diff;
  validateCatalogSnapshot(result.snapshot, result.account);
  const snapshot = result.snapshot;
  const nextSlugs = new Set(snapshot.spaces.map((s) => s.slug));
  // Invalidate the selection BEFORE the first registry write. Once an entry is removed, a later
  // application (after a death here) can no longer tell that the selected name belonged to this
  // account, and the selection would outlive its entry.
  const current = getCurrent();
  if (current && priorByName.has(current) && !nextSlugs.has(current)) {
    clearCurrent();
    diff.selectionInvalidated = current;
  }
  for (const old of before) {
    if (nextSlugs.has(old.space)) continue;
    removeMesh(old.space);
    diff.removed.push(old.space);
  }
  for (const row of snapshot.spaces) {
    const existing = findMesh(row.slug);
    if (existing && (existing.origin !== "catalog" || existing.catalogOwner !== result.account.ownerKey)) {
      diff.collisions.push(row.slug);
      continue;
    }
    const next = entryFor(result.account, row, result.fetchedAt);
    const prior = priorByName.get(row.slug);
    writeCatalogCredential(next, row);
    recordMesh(next);
    if (!prior) diff.added.push(row.slug);
    else if (sameEntry(prior, next)) diff.unchanged.push(row.slug);
    else diff.changed.push(row.slug);
  }
  for (const list of [diff.added, diff.changed, diff.removed, diff.unchanged, diff.collisions]) list.sort();
  return diff;
}

export async function prepareCatalogTargets(opts: { idpUrl?: string; force?: boolean } = {}): Promise<{ results: AuthSpaceCatalogResult[]; diffs: CatalogDiff[] }> {
  const provider = resolveAuthProvider();
  if (!provider.prepareSpaceCatalogs)
    throw new Error(`auth provider "${provider.name}" does not support space catalogs`);
  const applied = new Map<string, CatalogDiff>();
  const results = await provider.prepareSpaceCatalogs({
    dir: homeCotalDir(),
    ...(opts.idpUrl ? { idpUrl: opts.idpUrl } : {}),
    ...(opts.force ? { force: true } : {}),
    validate: validateCatalogSnapshot,
    apply: (result) => void applied.set(result.account.ownerKey, mergeDiff(applied.get(result.account.ownerKey), consume(result, Boolean(opts.force)))),
  });
  return { results, diffs: results.map((result) => applied.get(result.account.ownerKey) ?? emptyDiff()) };
}

/** Shared once-per-command preparation. A named manual/local entry never depends on discovery.
 * Unknown names force one refresh even inside the freshness window. `status` keeps a failed stale
 * snapshot only as timestamped diagnostics; operational commands refuse before target resolution. */
export async function prepareCatalogCommand(args: ParsedArgs, diagnostics = false, command?: "meshes" | "use"): Promise<void> {
  const values = args.values as { space?: string };
  const requested = values.space ?? (command === "use" ? args.positionals[0] : undefined);
  const named = requested ? findMesh(requested) : undefined;
  if (named && named.origin === "manual") {
    if (command === "meshes") return;
    await refreshManualPolicy(named);
    return;
  }
  if (named && named.origin !== "catalog") return;
  if (!requested && command !== "meshes") {
    const current = getCurrent();
    const selected = current ? findMesh(current) : undefined;
    if (selected?.origin === "manual") {
      await refreshManualPolicy(selected);
      return;
    }
    if (selected && selected.origin !== "catalog") return;
    const local = meshesForRoot(findCotalRoot()).filter((m) => m.origin !== "catalog");
    const localManual = local.find((m) => m.origin === "manual");
    if (localManual) {
      await refreshManualPolicy(localManual);
      return;
    }
    if (local.length > 0) return;
    const registered = loadMeshes();
    if (registered.length === 1 && registered[0].origin === "manual") {
      await refreshManualPolicy(registered[0]);
      return;
    }
    if (registered.length === 1 && registered[0].origin !== "catalog") return;
  }
  const force = Boolean(requested && !named);
  if (registry.all<AuthProvider>("auth-provider").length === 0) return;
  const provider = resolveAuthProvider();
  if (!provider.prepareSpaceCatalogs) return;
  const diffs: CatalogDiff[] = [];
  const results = await provider.prepareSpaceCatalogs({
    dir: homeCotalDir(),
    ...(named?.origin === "catalog" && named.userAuth?.idp.url ? { idpUrl: named.userAuth.idp.url } : {}),
    ...(force ? { force: true } : {}),
    validate: validateCatalogSnapshot,
    apply: (result) => void diffs.push(consume(result, force)),
  });
  if (results.every((r) => r.state === "no-catalog" && r.snapshot === undefined)) return;
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
  apply: (result) => void consume(result, true),
};

registry.register(spaceCatalogConsumer);
