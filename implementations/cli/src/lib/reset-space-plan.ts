import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realDirNoSymlink, registry, resolveAuthProvider, type AuthProvider } from "@cotal-ai/core";
import {
  BROKER_AUTH_KEY, SPACE_AUTH_KEY, CommandFailure, DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND, agentSecretKeysUnder,
  getSpaceAuth, meshesForRoot, resolveSpace, segmentedKey, spaceAccountKey, spaceFromSegment, spaceSegment,
  workspaceSecretStore,
} from "@cotal-ai/workspace";
import { localIdentityCleanupTargets, type ReviewedIdentityCleanup } from "../commands/clean.js";

interface PathObservation {
  path: string;
  kind: "file" | "directory" | "absent";
  identity: string | null;
}

export interface ResetSpaceIdentityPlan {
  root: string;
  space: string;
  controlIdentity: string;
  paths: readonly PathObservation[];
  provider: AuthProvider | null;
  providerKeys: readonly string[];
  agentKeys: readonly string[];
  secretKeys: readonly string[];
}

const within = (parent: string, path: string): boolean => {
  const tail = relative(parent, path);
  return tail === "" || !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`);
};

/** Metadata only. Values and content fingerprints never enter the reset impact report. */
function observePaths(root: string, space: string, inputs: readonly string[]): PathObservation[] {
  const control = join(root, ".cotal"), rows = new Map<string, PathObservation>();
  if (process.getuid === undefined) throw new Error("reset identity ownership requires a native user id");
  const uid = BigInt(process.getuid());
  const visit = (path: string) => {
    const name = relative(root, path);
    if (rows.has(name)) return;
    if (rows.size >= 10_000 || !within(control, path) || path === control) throw new Error("identity cleanup scope exceeds its local path bound");
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) { rows.set(name, { path: name, kind: "absent", identity: null }); return; }
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || stat.uid !== uid || (stat.mode & 0o022n) !== 0n || stat.isFile() && stat.nlink !== 1n) throw new Error("identity cleanup needs unchanged owned physical files and directories");
    const kind = stat.isDirectory() ? "directory" : "file";
    rows.set(name, { path: name, kind, identity: [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") });
    if (kind === "directory") for (const child of readdirSync(path).sort()) {
      const tenant = spaceFromSegment(child);
      if (tenant !== undefined && tenant !== space) throw new Error("identity cleanup found another space segment");
      visit(join(path, child));
    }
  };
  for (const path of inputs) {
    // Inspect every existing parent without following a link before descending into a target.
    const tail = relative(control, path);
    if (!tail || isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`)) throw new Error("identity cleanup path escapes its control directory");
    let parent = control;
    for (const part of tail.split(sep).slice(0, -1)) {
      parent = join(parent, part);
      const stat = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
      if (!stat) break;
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022n) !== 0n) throw new Error("identity cleanup parent is not an owned physical directory");
    }
    visit(path);
  }
  return [...rows.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function scope(root: string, space: string, provider: AuthProvider | null) {
  const controlDirectory = realDirNoSymlink(root, ".cotal");
  if (!controlDirectory || process.getuid === undefined) throw new Error("identity cleanup needs an owned local control directory");
  const controlStat = lstatSync(controlDirectory, { bigint: true });
  if (controlStat.uid !== BigInt(process.getuid()) || (controlStat.mode & 0o022n) !== 0n) throw new Error("identity cleanup control directory is not exclusively writable by its owner");
  realDirNoSymlink(root, ".cotal", "auth", "creds");
  if (resolveSpace(root) !== space || meshesForRoot(root).some((mesh) => mesh.space !== space)) throw new Error("identity cleanup cannot attribute this entire root to the named space");
  const control = join(root, ".cotal"), targets = localIdentityCleanupTargets(root, space);
  const providerKeys = provider?.deprovisionSecretKeys?.(space);
  if (provider && !providerKeys || providerKeys && (providerKeys.length > 1000 || new Set(providerKeys).size !== providerKeys.length)) throw new Error("auth provider has no complete bounded cleanup key declaration");
  for (const key of providerKeys ?? []) {
    const path = resolve(control, key);
    if (![join(targets.auth, spaceSegment(space)), targets.material].some((allowed) => within(allowed, path) && path !== allowed)) throw new Error("provider cleanup key is not confined to this space's secret segment");
  }
  const agentKeys = agentSecretKeysUnder(root).sort();
  const keys = [...new Set([...[DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND].flatMap((kind) => [segmentedKey(kind, space), kind]), ...agentKeys, ...(providerKeys ?? []), spaceAccountKey(space), BROKER_AUTH_KEY, SPACE_AUTH_KEY])].sort();
  for (const key of keys) {
    if (!key || isAbsolute(key) || /[\u0000-\u001f\u007f]/u.test(key)) throw new Error("invalid identity cleanup store key");
    const path = resolve(control, key);
    if (!within(control, path) || path === control || ![targets.auth, targets.material, ...targets.legacy, ...[DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND].map((kind) => join(control, kind))].some((allowed) => within(allowed, path))) throw new Error("provider cleanup key is outside the reviewed native reset scope");
  }
  for (const name of readdirSync(control)) {
    const tenant = spaceFromSegment(name);
    if (tenant !== undefined && tenant !== space) throw new Error("another space owns material under this root");
  }
  return { controlIdentity: [controlStat.dev, controlStat.ino, controlStat.uid, controlStat.mode].join(":"), providerKeys: [...(providerKeys ?? [])], agentKeys, secretKeys: keys, paths: [targets.material, targets.renewal, ...targets.legacy, ...targets.runtime, targets.run, targets.auth, ...keys.map((key) => resolve(control, key))] };
}

/** A complete bounded inventory of the native clean-all filesystem composition, not hosted data.
 * Provider declarations are read without executing their deletion hooks. */
export async function planResetSpaceIdentity(root: string, space: string, mode: "open" | "auth" | "user"): Promise<ResetSpaceIdentityPlan> {
  try {
    const registered = registry.all<AuthProvider>("auth-provider");
    const provider = registered.length ? resolveAuthProvider() : null;
    if (mode === "user" && !provider) throw new Error("local user-auth reset needs its native provider");
    const planned = scope(root, space, provider);
    const before = observePaths(root, space, planned.paths);
    if (mode === "open" && [spaceAccountKey(space), BROKER_AUTH_KEY, SPACE_AUTH_KEY].some((key) => before.some((row) => row.path === join(".cotal", key) && row.kind !== "absent"))) throw new Error("open registration retains unvalidated signing authority");
    const trust = await getSpaceAuth(workspaceSecretStore(root), space);
    if (mode === "open" ? trust !== undefined : trust === undefined) throw new Error("registered authentication mode and local full trust disagree");
    const after = observePaths(root, space, planned.paths);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("identity paths changed while trust was validated");
    return { root, space, controlIdentity: planned.controlIdentity, paths: after, provider, providerKeys: planned.providerKeys, agentKeys: planned.agentKeys, secretKeys: planned.secretKeys };
  } catch {
    throw new CommandFailure("refused", "CONFLICT", "the named reset could not establish one complete unchanged local identity scope, valid trust and declared provider keys; no identity deletion was submitted", { target: { root, space }, remedy: "inspect reset space <space> --dry-run; shared roots, foreign segments, links and providers without cleanup metadata cannot be reset by this route" });
  }
}

export function recheckResetSpaceIdentity(plan: ResetSpaceIdentityPlan): void {
  const currentProvider = registry.all<AuthProvider>("auth-provider").length ? resolveAuthProvider() : null;
  if (currentProvider !== plan.provider) throw new Error("auth cleanup provider changed");
  const current = scope(plan.root, plan.space, currentProvider);
  if (current.controlIdentity !== plan.controlIdentity || JSON.stringify(current.providerKeys) !== JSON.stringify(plan.providerKeys) || JSON.stringify(observePaths(plan.root, plan.space, current.paths)) !== JSON.stringify(plan.paths)) throw new Error("reviewed identity scope changed");
}

/** Constrain the native delete hook and raw removals to the reviewed remaining tree. A newly
 * added path or changed file stops cleanup rather than expanding the confirmation's scope. */
export function reviewedResetIdentityCleanup(plan: ResetSpaceIdentityPlan, onSecretRemoved: (path: string) => void): ReviewedIdentityCleanup {
  const control = join(plan.root, ".cotal"), deleted: string[] = [];
  const wasDeleted = (path: string) => deleted.some((parent) => within(parent, path));
  const normalized = (row: PathObservation) => ({ ...row, identity: row.kind === "directory" ? row.identity?.split(":").slice(0, 4).join(":") ?? null : row.identity });
  const beforeRemove = (path: string) => {
    const owner = lstatSync(control, { bigint: true });
    if (!owner.isDirectory() || owner.isSymbolicLink() || [owner.dev, owner.ino, owner.uid, owner.mode].join(":") !== plan.controlIdentity) throw new Error("reset control directory changed");
    const name = relative(plan.root, path), original = plan.paths.find((row) => row.path === name);
    if (!original) throw new Error("native cleanup requested an unreviewed path");
    const expected = wasDeleted(path) || original.kind === "absent" ? [{ path: name, kind: "absent" as const, identity: null }]
      : plan.paths.filter((row) => row.kind !== "absent" && within(path, join(plan.root, row.path)) && !wasDeleted(join(plan.root, row.path)));
    const current = observePaths(plan.root, plan.space, [path]);
    if (JSON.stringify(current.map(normalized)) !== JSON.stringify(expected.map(normalized))) throw new Error("native cleanup scope or file identity changed");
  };
  const afterRemove = (path: string) => {
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("native deletion returned with a surviving path");
    deleted.push(path);
  };
  const backing = workspaceSecretStore(plan.root);
  const pathFor = (key: string) => {
    if (!plan.secretKeys.includes(key)) throw new Error("native cleanup requested an unreviewed secret key");
    return resolve(control, key);
  };
  return {
    provider: plan.provider, agentKeys: plan.agentKeys, beforeRemove, afterRemove,
    store: {
      async get(key) { beforeRemove(pathFor(key)); return backing.get(key); },
      async delete(key) {
        const path = pathFor(key);
        beforeRemove(path);
        const existed = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
        await backing.delete(key);
        afterRemove(path);
        if (existed) onSecretRemoved(relative(plan.root, path));
      },
      async put() { throw new Error("a reviewed identity reset cannot write secrets"); },
      async create() { throw new Error("a reviewed identity reset cannot create secrets"); },
    },
  };
}

export function resetSpaceIdentityProjection(plan: ResetSpaceIdentityPlan) {
  return { provider: plan.provider?.name ?? null, providerKeyCount: plan.providerKeys.length, paths: plan.paths.map(({ path, kind }) => ({ path, state: kind })), trust: "validated-native-local-chain" as const };
}

export function assertResetIdentityRemoved(plan: ResetSpaceIdentityPlan): void {
  for (const row of plan.paths) {
    if (lstatSync(join(plan.root, row.path), { throwIfNoEntry: false })) throw new Error("a native identity cleanup target remains");
  }
}
