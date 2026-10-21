import { join } from "node:path";
import { isLoopbackLiteral, mkSecretDir, registry, resolveAuthProvider, writeSecretFileAtomic, type AuthProvider, type AuthSpaceCatalogAccount, type AuthSpaceCatalogResult, type FlagSpec, type FlagValues, type ParsedArgs, type SpaceCatalogConsumer } from "@cotal-ai/core";
import {
  CommandFailure,
  clearCurrent,
  getCurrent,
  homeCotalDir,
  jsonFlag,
  plainFlag,
  presentationOf,
  writeResult,
  type Cell,
  type OutputWarning,
  type Report,
  loadMeshes,
  readMesh,
  recordMeshes,
  removeMeshes,
  userAuthStateDir,
  type MeshEntry,
  type RefusalCode,
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
  jsonFlag,
  plainFlag,
  { name: "idp", type: "string", value: "<auth base URL>", description: "refresh only this signed-in IdP account" },
] as const satisfies readonly FlagSpec[];
export { syncFlags };

type SyncValues = FlagValues<typeof syncFlags>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Canonicalize an IdP identity for account binding with the same URL shape the stock provider
 * accepts: HTTPS, or HTTP on a loopback IP literal; no credentials, query, fragment, or trailing
 * slash. This is not a bundle validator. It compares already-validated registration trust to the
 * proved account. */
function canonicalIdpUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackLiteral(url.hostname)))
    throw new Error(`${what} must be https (or http on a loopback IP literal for local development)`);
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
  const loaded = loadMeshes();
  const before = loaded.filter((m) => m.origin === "catalog" && m.catalogOwner === result.account.ownerKey);
  const priorByName = new Map(before.map((m) => [m.space, m]));
  const diff = emptyDiff();
  if (result.state === "failed") {
    recordMeshes(before.map((old) => ({ ...old, ...(result.fetchedAt ? { catalogFetchedAt: result.fetchedAt } : {}), catalogError: result.error ?? "refresh failed" })));
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
  for (const old of before) if (!nextSlugs.has(old.space)) diff.removed.push(old.space);
  removeMeshes(diff.removed);
  const loadedByName = new Map(loaded.map((m) => [m.space, m]));
  // Each row is checked just before its own write, because writers outside the catalog lock
  // (`meshes add`, `up`) can record a space while this runs and their record must still win. They
  // write the canonical file, which answers in one read; a pre-hex record only an older build writes,
  // so the opening load answers for it.
  function* entries(): Generator<MeshEntry> {
    for (const row of snapshot.spaces) {
      const existing = readMesh(row.slug) ?? loadedByName.get(row.slug);
      if (existing && (existing.origin !== "catalog" || existing.catalogOwner !== result.account.ownerKey)) {
        diff.collisions.push(row.slug);
        continue;
      }
      const next = entryFor(result.account, row, result.fetchedAt);
      const prior = priorByName.get(row.slug);
      writeCatalogCredential(next, row);
      if (!prior) diff.added.push(row.slug);
      else if (sameEntry(prior, next)) diff.unchanged.push(row.slug);
      else diff.changed.push(row.slug);
      yield next;
    }
  }
  recordMeshes(entries());
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

let catalogDiagnostics: AuthSpaceCatalogResult[] = [];

/** The account results prepared by the dispatcher immediately before `status` renders. */
export function preparedCatalogDiagnostics(): readonly AuthSpaceCatalogResult[] {
  return catalogDiagnostics;
}

/** A space catalog that stopped a command before it ran, with the stable code a structured command
 *  reports it under: the selected space left its catalog, or the catalog for the target's account
 *  could not be refreshed. */
export class CatalogPreparationError extends Error {
  constructor(message: string, readonly code: RefusalCode) {
    super(message);
    this.name = "CatalogPreparationError";
  }
}

/** Shared once-per-command preparation. Every target-resolving call gives each signed-in account a
 * chance to refresh inside the provider's freshness window. An operational catalog target scopes
 * that work to its own account and treats its failure as fatal. Other targets warn per account;
 * diagnostics retain every result for `status` and never refuse the command. Unknown names force a
 * refresh even inside the freshness window. */
export async function prepareCatalogCommand(args: ParsedArgs, diagnostics = false, command?: "meshes" | "use"): Promise<void> {
  catalogDiagnostics = [];
  const values = args.values as { space?: string };
  const requested = values.space ?? (command === "use" ? args.positionals[0] : undefined);
  const current = !requested && command !== "meshes" ? getCurrent() : undefined;
  let meshes: MeshEntry[];
  try {
    meshes = loadMeshes();
  } catch {
    // Applying a catalog reads this same registry, so none can apply while a record is unusable.
    // Refusing here would pre-empt the command's own checks; a command that resolves its target
    // through the registry still refuses the record by name.
    return;
  }
  const named = requested ? meshes.find((m) => m.space === requested) : undefined;
  const selected = current ? meshes.find((m) => m.space === current) : undefined;
  const target = named ?? selected;
  const targetCatalog = !diagnostics && target?.origin === "catalog" ? target : undefined;
  const force = Boolean(requested && !named);
  if (registry.all<AuthProvider>("auth-provider").length === 0) return;
  const provider = resolveAuthProvider();
  if (!provider.prepareSpaceCatalogs) return;
  const diffs: CatalogDiff[] = [];
  const results = await provider.prepareSpaceCatalogs({
    dir: homeCotalDir(),
    ...(targetCatalog?.userAuth?.idp.url ? { idpUrl: targetCatalog.userAuth.idp.url } : {}),
    ...(force ? { force: true } : {}),
    validate: validateCatalogSnapshot,
    apply: (result) => void diffs.push(consume(result, force)),
  });
  catalogDiagnostics = results;
  if (results.every((r) => r.state === "no-catalog" && r.snapshot === undefined)) return;
  const vanished = diffs.map((d) => d.selectionInvalidated).filter((s): s is string => Boolean(s));
  if (vanished.length) {
    const message = `selected space "${vanished.join("\", \"")}" vanished from its account catalog; no default mesh is selected`;
    if (diagnostics) console.error(c.yellow(message));
    else throw new CatalogPreparationError(message, "TARGET_NOT_FOUND");
  }
  const failures = results.filter((r) => r.state === "failed");
  if (diagnostics) return;
  if (targetCatalog && failures.length)
    throw new CatalogPreparationError(failures.map((r) => `space catalog for ${r.account.idpUrl} failed: ${r.error}`).join("; "), "DEPENDENCY_UNAVAILABLE");
  for (const failure of failures)
    console.error(c.yellow(`space catalog for ${failure.account.idpUrl} failed: ${failure.error}`));
}

/** One signed-in account's refresh, as `cotal sync` reports it. */
interface SyncedAccount {
  readonly idp: string;
  readonly state: AuthSpaceCatalogResult["state"];
  /** The catalog the account advertises, or null when it advertises none. */
  readonly catalog: string | null;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
  readonly collisions: readonly string[];
  /** The selected space this refresh removed, so no space is selected now; null otherwise. */
  readonly selectionCleared: string | null;
  readonly error: string | null;
}

interface SyncResult {
  readonly kind: "sync";
  readonly accounts: readonly SyncedAccount[];
}

/**
 * `cotal sync` refreshes every signed-in account's space catalog, or the one `--idp` names, and
 * applies it to the registry. An account whose catalog could not be refreshed keeps its last
 * snapshot and is named in a warning; when some failed the result is partial, and when every one
 * failed the command is refused.
 */
export async function sync(args: ParsedArgs): Promise<void> {
  const values = args.values as SyncValues;
  const presentation = presentationOf(values);
  const { results, diffs } = await prepareCatalogTargets({ idpUrl: values.idp, force: true });
  const accounts: SyncedAccount[] = results.map((result, i) => {
    const d = diffs[i]!;
    return {
      idp: result.account.idpUrl,
      state: result.state,
      catalog: result.account.catalogUrl ?? null,
      added: d.added,
      changed: d.changed,
      removed: d.removed,
      unchanged: d.unchanged,
      collisions: d.collisions,
      selectionCleared: d.selectionInvalidated ?? null,
      error: result.state === "failed" ? (result.error ?? "refresh failed") : null,
    };
  });
  const failed = accounts.filter((a) => a.error !== null);
  const failure = failed.map((a) => `space catalog for ${a.idp} failed: ${a.error}`).join("; ");
  if (failed.length > 0 && failed.length === accounts.length)
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", failure, { remedy: "check the IdP is reachable and you are signed in (`cotal whoami`), then run `cotal sync` again" });
  const warnings: OutputWarning[] = failed.map((a) => ({ code: "CATALOG_UNAVAILABLE", target: { idp: a.idp }, message: `space catalog for ${a.idp} failed: ${a.error}; its last snapshot stays applied` }));
  const result: SyncResult = { kind: "sync", accounts };
  writeResult(
    presentation,
    {
      command: "sync",
      target: values.idp === undefined ? null : { idp: values.idp },
      result,
      warnings,
      ...(failed.length > 0 ? { partial: { message: `${failed.length} of ${accounts.length} space catalogs could not be refreshed; the warnings name them`, remedy: "run `cotal sync --idp <url>` again for each once its IdP answers" } } : {}),
    },
    syncView,
  );
}

function syncView(r: SyncResult): Report {
  if (r.accounts.length === 0) return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: "no signed-in IdP accounts - sign in with `cotal login`", tone: "hint" }] }] }] };
  return {
    sections: r.accounts.map((a) => {
      const names = (list: readonly string[]): Cell => (list.length ? list.join(", ") : { text: "-", tone: "hint" });
      const fields: [string, Cell][] = [
        ["state", { text: a.state, tone: a.error === null ? "ok" : "failed" }],
        ["catalog", a.catalog ?? { text: "none advertised", tone: "hint" }],
        ["added", names(a.added)],
        ["changed", names(a.changed)],
        ["removed", names(a.removed)],
        ["unchanged", names(a.unchanged)],
        ["collisions", names(a.collisions)],
      ];
      const notes: Cell[] = a.selectionCleared === null ? [] : [{ text: `selected space "${a.selectionCleared}" left its catalog; no space is selected now`, tone: "waiting" }];
      return { title: a.idp, blocks: [{ kind: "fields", rows: fields }, ...(notes.length ? [{ kind: "lines" as const, lines: notes }] : [])] };
    }),
  };
}

const spaceCatalogConsumer: SpaceCatalogConsumer = {
  kind: "space-catalog-consumer",
  name: "workspace",
  validate: validateCatalogSnapshot,
  apply: (result) => void consume(result, true),
};

registry.register(spaceCatalogConsumer);
