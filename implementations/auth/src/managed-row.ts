import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { KV } from "@nats-io/kv";
import { canonicalJson, managedRowStableBytes, managedRowSuccessReply, managedRowWireId, rawDigest, validateManagedRowIntent, walkKvEntries, type ManagedRowIntent } from "@cotal-ai/core";
import { processStartToken } from "@cotal-ai/workspace";

export const MANAGED_ROW_VERSION = 1;
export const MANAGED_TOMBSTONE_VERSION = 1;

export interface ManagedActorLiveRow {
  owner: string;
  actor: string;
  scope: string[];
  allowSubscribe: string[];
  allowPublish: string[];
  role?: string;
  parent?: string;
  label?: string;
  tokenHash: string;
  lifecycleUid: string;
  grantedAt: string;
}

export interface ManagedActorTombstone {
  ver: 1;
  kind: "managed-actor-tombstone";
  owner: string;
  actor: string;
  lifecycleUid: string;
  revokedAt: string;
  revokeOpId: string;
  previousDigest: string;
}

export type ManagedActorCanonical = ({ ver: 1 } & ManagedActorLiveRow) | ManagedActorTombstone;
export type ManagedActorRead =
  | { state: "absent" }
  | { state: "live"; row: ManagedActorLiveRow; bytes: Uint8Array; digest: string; historyHead: string; fence: number }
  | { state: "tombstone"; tombstone: ManagedActorTombstone; bytes: Uint8Array; digest: string; historyHead: string; fence: number };

export interface ManagedRowRequest {
  ver: 1;
  requestId: string;
  operationId: string;
  kind: "create" | "revoke";
  owner: string;
  actor: string;
  lifecycleUid: string;
  state: "pending" | "host-committed";
  sourceDigest: string | null;
  targetDigest: string;
  targetObject: string;
  committedDigest?: string;
}

interface ManagedHistoryEvent {
  ver: 1;
  operationId: string;
  requestId: string;
  kind: "create" | "revoke";
  owner: string;
  actor: string;
  lifecycleUid: string;
  predecessor: string | null;
  sourceDigest: string | null;
  targetDigest: string;
}

export interface ManagedRowMutationOptions {
  requestId: string;
  operationId?: string;
  now?: () => Date;
  failAt?: "after-request" | "after-temp-fsync" | "after-rename" | "after-history";
}
let BEFORE_LOCKED_EFFECT: (() => void) | undefined;
export function setManagedRowBeforeLockedEffectForSmoke(hook: (() => void) | undefined): void { BEFORE_LOCKED_EFFECT = hook; }

export interface PreparedManagedAuthorization {
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
  readonly requestId: string;
  readonly consumerId: string;
  readonly requestDigest: string;
  readonly rowDigest: string;
  readonly historyHead: string;
  readonly fence: number;
  commit(resultDigest: string, resultBytes: Uint8Array): Uint8Array;
  cancel(outcome: string): void;
}

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown): Uint8Array => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const PINNED_DIRS = new Set<string>();
const PINNED_STATE_ROOTS = new Map<string, string>();
const PINNED_SUBDIRS = new Map<string, Map<string, string>>();
const HELD_DIRS = new Set<string>();

function descriptorPath(fd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin" || process.platform === "freebsd") return `/dev/fd/${fd}`;
  throw new Error("managed-row projection requires a descriptor-addressable filesystem on this platform");
}

function pinRoots(dir: string, write: boolean): { dir: string; close(): void } {
  if (PINNED_DIRS.has(dir)) return { dir, close() {} };
  const absolute = resolve(dir);
  const parentFd = openSync(dirname(absolute), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const held: number[] = [];
  let pinned: string | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (pinned !== undefined) {
      PINNED_SUBDIRS.delete(pinned); PINNED_STATE_ROOTS.delete(pinned); PINNED_DIRS.delete(pinned);
    }
    for (const fd of held.reverse()) { HELD_DIRS.delete(descriptorPath(fd)); closeSync(fd); }
    closeSync(parentFd);
  };
  try {
    const parent = descriptorPath(parentFd);
    const addressedRoot = join(parent, basename(absolute));
    if (write && !existsSync(addressedRoot)) mkdirSync(addressedRoot, { mode: 0o700 });
    if (!existsSync(addressedRoot)) { closeSync(parentFd); closed = true; return { dir: addressedRoot, close() {} }; }
    const pin = (path: string): string => {
      const before = lstatSync(path);
      if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`${path}: managed projection directory must be real`);
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); held.push(fd);
      const after = fstatSync(fd);
      if (after.dev !== before.dev || after.ino !== before.ino || (after.mode & 0o077) !== 0) throw new Error(`${path}: managed projection directory changed or is not private while pinning`);
      const out = descriptorPath(fd); HELD_DIRS.add(out); return out;
    };
    pinned = pin(addressedRoot);
    PINNED_DIRS.add(pinned);
    const statePath = join(parent, "managed-row-state");
    if (write && !existsSync(statePath)) mkdirSync(statePath, { mode: 0o700 });
    const statePinned = existsSync(statePath) ? pin(statePath) : statePath;
    PINNED_STATE_ROOTS.set(pinned, statePinned);
    const children = new Map<string, string>();
    if (existsSync(statePath)) for (const name of ["requests", "bytes", "history", "heads", "fences", "result-cache", "locks"]) {
      const path = join(statePinned, name);
      if (write && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
      if (existsSync(path)) children.set(name, pin(path));
    }
    PINNED_SUBDIRS.set(pinned, children);
    if (write) ensureLayout(pinned);
    return { dir: pinned, close };
  } catch (error) { close(); throw error; }
}

function withPinnedRoots<T>(dir: string, write: boolean, fn: (pinnedDir: string) => T): T {
  const pinned = pinRoots(dir, write);
  try { return fn(pinned.dir); }
  finally { pinned.close(); }
}

function assertToken(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} must be a plain token`);
  return value;
}

function assertDigest(value: string, name: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a sha256 hex digest`);
  return value;
}

function assertRequestId(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new Error("managed row requestId must be a 16-128 character opaque token");
  return value;
}

function actorKey(owner: string, actor: string): string {
  assertToken(owner, "owner");
  assertToken(actor, "actor");
  return `${owner}.${actor}`;
}

function stateRoot(dir: string): string { return PINNED_STATE_ROOTS.get(dir) ?? join(dirname(dir), "managed-row-state"); }
function childDir(dir: string, name: string): string { return PINNED_SUBDIRS.get(dir)?.get(name) ?? join(stateRoot(dir), name); }
function requestsDir(dir: string): string { return childDir(dir, "requests"); }
function bytesDir(dir: string): string { return childDir(dir, "bytes"); }
function historyDir(dir: string): string { return childDir(dir, "history"); }
function headsDir(dir: string): string { return childDir(dir, "heads"); }
function fencesDir(dir: string): string { return childDir(dir, "fences"); }
function cacheDir(dir: string): string { return childDir(dir, "result-cache"); }
function locksDir(dir: string): string { return childDir(dir, "locks"); }

function ensurePrivateDir(path: string): void {
  if (HELD_DIRS.has(path)) return;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0)
    throw new Error(`${path}: managed-row state must be a private real directory`);
}

function ensureLayout(dir: string): void {
  ensurePinnedManagedDirectory(dir, true);
  for (const path of [stateRoot(dir), requestsDir(dir), bytesDir(dir), historyDir(dir), headsDir(dir), fencesDir(dir), cacheDir(dir), locksDir(dir)])
    ensurePrivateDir(path);
}

/** Validate and return the one canonical managed directory. It may be created only by an authorized writer. */
export function ensurePinnedManagedDirectory(dir: string, create = false): string {
  if (PINNED_DIRS.has(dir)) return dir;
  const path = resolve(dir);
  if (!existsSync(path)) {
    if (!create) return path;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path}: managed actor directory must be a real directory`);
  return path;
}

export function managedCanonicalPath(dir: string, owner: string, actor: string): string {
  const root = ensurePinnedManagedDirectory(dir, false);
  const path = resolve(root, `${actorKey(owner, actor)}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("managed actor path escaped its pinned directory");
  return path;
}

function inspectCanonical(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${path}: managed actor canonical must be a regular non-symlink file`);
  if (st.nlink !== 1) throw new Error(`${path}: managed actor canonical must have exactly one hard link`);
  if ((st.mode & 0o777) !== 0o600) throw new Error(`${path}: managed actor canonical must be mode 0600`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${path}: managed actor canonical has the wrong owner`);
}

function closedKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${where}: unknown fields ${extra.join(", ")}`);
}

function parseCanonical(bytes: Uint8Array, path: string): ManagedActorCanonical {
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch (error) { throw new Error(`${path}: malformed managed actor JSON (${error instanceof Error ? error.message : String(error)})`); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: managed actor value must be an object`);
  const value = raw as Record<string, unknown>;
  if (value.kind === "managed-actor-tombstone") {
    closedKeys(value, ["ver", "kind", "owner", "actor", "lifecycleUid", "revokedAt", "revokeOpId", "previousDigest"], path);
    if (value.ver !== MANAGED_TOMBSTONE_VERSION || typeof value.owner !== "string" || typeof value.actor !== "string" ||
        typeof value.lifecycleUid !== "string" || typeof value.revokedAt !== "string" || typeof value.revokeOpId !== "string" ||
        typeof value.previousDigest !== "string") throw new Error(`${path}: invalid managed actor tombstone`);
    assertToken(value.owner, "owner"); assertToken(value.actor, "actor"); assertToken(value.lifecycleUid, "lifecycleUid");
    assertRequestId(value.revokeOpId); assertDigest(value.previousDigest, "previousDigest");
    if (Number.isNaN(Date.parse(value.revokedAt))) throw new Error(`${path}: invalid revokedAt`);
    return value as unknown as ManagedActorTombstone;
  }
  closedKeys(value, ["ver", "owner", "actor", "scope", "allowSubscribe", "allowPublish", "role", "parent", "label", "tokenHash", "lifecycleUid", "grantedAt"], path);
  if (value.ver !== MANAGED_ROW_VERSION || typeof value.owner !== "string" || typeof value.actor !== "string" ||
      !Array.isArray(value.scope) || !Array.isArray(value.allowSubscribe) || !Array.isArray(value.allowPublish) ||
      typeof value.tokenHash !== "string" || typeof value.lifecycleUid !== "string" || typeof value.grantedAt !== "string")
    throw new Error(`${path}: invalid managed actor row`);
  for (const list of [value.scope, value.allowSubscribe, value.allowPublish])
    if (!list.every((item) => typeof item === "string")) throw new Error(`${path}: managed actor lists must contain strings`);
  assertToken(value.owner, "owner"); assertToken(value.actor, "actor"); assertToken(value.lifecycleUid, "lifecycleUid");
  assertDigest(value.tokenHash, "tokenHash");
  if (Number.isNaN(Date.parse(value.grantedAt))) throw new Error(`${path}: invalid grantedAt`);
  return value as unknown as { ver: 1 } & ManagedActorLiveRow;
}

function readHead(dir: string, owner: string, actor: string): string {
  const path = join(headsDir(dir), actorKey(owner, actor));
  if (!existsSync(path)) return "0".repeat(64);
  const head = readFileSync(path, "utf8").trim();
  return assertDigest(head, "managed history head");
}

function readFence(dir: string, owner: string, actor: string): number {
  const path = join(fencesDir(dir), actorKey(owner, actor));
  if (!existsSync(path)) return 0;
  const value = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path}: invalid managed revocation fence`);
  return value;
}

export function readManagedActorPath(path: string): ManagedActorRead {
  if (!existsSync(path)) return { state: "absent" };
  inspectCanonical(path);
  const bytes = readFileSync(path);
  const parsed = parseCanonical(bytes, path);
  const common = { bytes, digest: sha256(bytes), historyHead: "0".repeat(64), fence: 0 };
  if ("kind" in parsed) return { state: "tombstone", tombstone: parsed, ...common };
  const { ver: _ver, ...row } = parsed;
  return { state: "live", row, ...common };
}

export function readManagedActor(dir: string, owner: string, actor: string): ManagedActorRead {
  if (!PINNED_DIRS.has(dir)) return withPinnedRoots(dir, false, (pinned) => readManagedActor(pinned, owner, actor));
  const path = managedCanonicalPath(dir, owner, actor);
  if (!existsSync(path)) return { state: "absent" };
  inspectCanonical(path);
  const bytes = readFileSync(path);
  const parsed = parseCanonical(bytes, path);
  if (parsed.owner !== owner || parsed.actor !== actor) throw new Error(`${path}: managed actor principal does not match its canonical key`);
  const common = { bytes, digest: sha256(bytes), historyHead: readHead(dir, owner, actor), fence: readFence(dir, owner, actor) };
  if ("kind" in parsed) return { state: "tombstone", tombstone: parsed, ...common };
  const { ver: _ver, ...row } = parsed;
  return { state: "live", row, ...common };
}

function releaseActorLock(dir: string, owner: string, actor: string): void {
  const lock = join(locksDir(dir), actorKey(owner, actor));
  rmSync(lock, { recursive: true, force: true });
}

function locked<T>(dir: string, owner: string, actor: string, fn: (pinnedDir: string) => T): T {
  if (!PINNED_DIRS.has(dir)) return withPinnedRoots(dir, true, (pinned) => locked(pinned, owner, actor, fn));
  ensureLayout(dir);
  const lock = join(locksDir(dir), actorKey(owner, actor));
  const claim = () => { mkdirSync(lock, { mode: 0o700 }); writeDurable(join(lock, "owner.json"), Buffer.from(`${JSON.stringify({ pid: process.pid, start: processStartToken(process.pid) })}\n`), true); };
  try { claim(); }
  catch {
    let stale = false;
    try {
      const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid?: unknown; start?: unknown };
      const pid = owner.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || (owner.start !== undefined && typeof owner.start !== "string")) stale = true;
      else {
        try {
          process.kill(pid, 0);
          const currentStart = processStartToken(pid);
          if (typeof owner.start === "string" && currentStart !== undefined && currentStart !== owner.start) stale = true;
        } catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
    } catch { stale = true; }
    if (!stale) throw new Error(`managed actor ${owner}.${actor} is busy`);
    rmSync(lock, { recursive: true, force: true });
    claim();
  }
  try { BEFORE_LOCKED_EFFECT?.(); return fn(dir); }
  finally { releaseActorLock(dir, owner, actor); }
}

function writeDurable(path: string, bytes: Uint8Array, exclusive = false): void {
  ensurePrivateDir(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : constants.O_TRUNC) | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dfd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

function writeObject(dir: string, bytes: Uint8Array): { digest: string; name: string } {
  const digest = sha256(bytes);
  const name = `${digest}.json`;
  const path = join(bytesDir(dir), name);
  if (!existsSync(path)) writeDurable(path, bytes, true);
  else if (sha256(readFileSync(path)) !== digest) throw new Error(`${path}: managed byte object digest mismatch`);
  return { digest, name };
}

function pendingOwner(dir: string, owner: string, actor: string): ManagedRowRequest | undefined {
  for (const name of readdirSync(requestsDir(dir)).filter((name) => name.endsWith(".json")).sort()) {
    const request = JSON.parse(readFileSync(join(requestsDir(dir), name), "utf8")) as ManagedRowRequest;
    if (request.owner === owner && request.actor === actor && request.state === "pending") return request;
  }
  return undefined;
}

function writeRequest(dir: string, request: ManagedRowRequest): void {
  const path = join(requestsDir(dir), `${request.requestId}.json`);
  const bytes = jsonBytes(request);
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8")) as ManagedRowRequest;
    const identity = (r: ManagedRowRequest) => JSON.stringify({ ...r, state: "pending", committedDigest: undefined });
    if (identity(existing) !== identity(request)) throw new Error(`managed request ${request.requestId} conflicts with its durable identity`);
    return;
  }
  writeDurable(path, bytes, true);
}

function replaceRequest(dir: string, request: ManagedRowRequest): void {
  writeDurable(join(requestsDir(dir), `${request.requestId}.json`), jsonBytes(request));
}

function appendHistory(dir: string, request: ManagedRowRequest): string {
  const operationPath = join(historyDir(dir), `op-${request.operationId}`);
  if (existsSync(operationPath)) {
    const recorded = assertDigest(readFileSync(operationPath, "utf8").trim(), "managed operation history digest");
    if (!existsSync(join(historyDir(dir), `${recorded}.json`))) throw new Error(`managed operation ${request.operationId} points to a missing history commit`);
    writeDurable(join(headsDir(dir), actorKey(request.owner, request.actor)), Buffer.from(`${recorded}\n`));
    return recorded;
  }
  const predecessor = readHead(dir, request.owner, request.actor);
  const event: ManagedHistoryEvent = {
    ver: 1, operationId: request.operationId, requestId: request.requestId, kind: request.kind,
    owner: request.owner, actor: request.actor, lifecycleUid: request.lifecycleUid,
    predecessor: predecessor === "0".repeat(64) ? null : predecessor,
    sourceDigest: request.sourceDigest, targetDigest: request.targetDigest,
  };
  const bytes = jsonBytes(event);
  const digest = sha256(bytes);
  const eventPath = join(historyDir(dir), `${digest}.json`);
  if (!existsSync(eventPath)) writeDurable(eventPath, bytes, true);
  writeDurable(operationPath, Buffer.from(`${digest}\n`), true);
  writeDurable(join(headsDir(dir), actorKey(request.owner, request.actor)), Buffer.from(`${digest}\n`));
  return digest;
}

function advanceFence(dir: string, owner: string, actor: string): number {
  const next = readFence(dir, owner, actor) + 1;
  writeDurable(join(fencesDir(dir), actorKey(owner, actor)), Buffer.from(`${next}\n`));
  return next;
}

function atomicCanonicalReplace(dir: string, request: ManagedRowRequest, failAt?: ManagedRowMutationOptions["failAt"]): void {
  const canonical = managedCanonicalPath(dir, request.owner, request.actor);
  if (existsSync(canonical)) inspectCanonical(canonical);
  const target = readFileSync(join(bytesDir(dir), request.targetObject));
  if (sha256(target) !== request.targetDigest) throw new Error("managed target object digest mismatch");
  const tmp = join(dir, `.rowtmp.${request.operationId}`);
  if (existsSync(tmp)) unlinkSync(tmp);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, target); fsyncSync(fd); }
  finally { closeSync(fd); }
  if (failAt === "after-temp-fsync") throw new Error("injected crash after temp fsync");
  renameSync(tmp, canonical);
  const dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  if (failAt === "after-rename") throw new Error("injected crash after rename");
  const final = readFileSync(canonical);
  if (sha256(final) !== request.targetDigest) throw new Error("managed canonical final reread did not match committed target");
}

function applyRequest(dir: string, request: ManagedRowRequest, failAt?: ManagedRowMutationOptions["failAt"]): ManagedActorRead {
  const current = readManagedActor(dir, request.owner, request.actor);
  const currentDigest = current.state === "absent" ? null : current.digest;
  if (currentDigest !== request.targetDigest) {
    if (currentDigest !== request.sourceDigest)
      throw new Error(`managed request ${request.requestId} lost ownership: canonical source changed before commit`);
    if (request.kind === "revoke") advanceFence(dir, request.owner, request.actor);
    atomicCanonicalReplace(dir, request, failAt);
  }
  if (failAt === "after-rename") throw new Error("injected crash after rename");
  appendHistory(dir, request);
  if (failAt === "after-history") throw new Error("injected crash after history");
  const committed = { ...request, state: "host-committed" as const, committedDigest: request.targetDigest };
  replaceRequest(dir, committed);
  return readManagedActor(dir, request.owner, request.actor);
}

export function grantManagedActorExact(
  dir: string,
  row: ManagedActorLiveRow,
  options: ManagedRowMutationOptions,
): ManagedActorLiveRow {
  if (!PINNED_DIRS.has(dir)) return withPinnedRoots(dir, true, (pinned) => grantManagedActorExact(pinned, row, options));
  assertRequestId(options.requestId);
  return locked(dir, row.owner, row.actor, (dir) => {
    const requestPath = join(requestsDir(dir), `${options.requestId}.json`);
    if (existsSync(requestPath)) {
      const existing = JSON.parse(readFileSync(requestPath, "utf8")) as ManagedRowRequest;
      if (existing.owner !== row.owner || existing.actor !== row.actor || existing.kind !== "create")
        throw new Error(`managed request ${options.requestId} conflicts with another operation`);
      const committedTarget = parseCanonical(readFileSync(join(bytesDir(dir), existing.targetObject)), existing.targetObject);
      if ("kind" in committedTarget) throw new Error(`managed request ${options.requestId} has a revoke target on a create request`);
      const { ver: _committedVer, grantedAt: _committedAt, ...committedAuthority } = committedTarget;
      const { grantedAt: _retryAt, ...retryAuthority } = row;
      if (JSON.stringify(retryAuthority) !== JSON.stringify(committedAuthority))
        throw new Error(`managed request ${options.requestId} conflicts with different target bytes`);
      const result = applyRequest(dir, existing, options.failAt);
      if (result.state !== "live") throw new Error("managed create did not commit a live row");
      return result.row;
    }
    const pending = pendingOwner(dir, row.owner, row.actor);
    if (pending) throw new Error(`managed actor ${row.owner}.${row.actor} is owned by pending request ${pending.requestId}`);
    const current = readManagedActor(dir, row.owner, row.actor);
    const sourceDigest = current.state === "absent" ? null : current.digest;
    const target = jsonBytes({ ver: 1, ...row });
    const object = writeObject(dir, target);
    const request: ManagedRowRequest = {
      ver: 1, requestId: options.requestId, operationId: options.operationId ?? options.requestId,
      kind: "create", owner: row.owner, actor: row.actor, lifecycleUid: row.lifecycleUid,
      state: "pending", sourceDigest, targetDigest: object.digest, targetObject: object.name,
    };
    writeRequest(dir, request);
    if (options.failAt === "after-request") throw new Error("injected crash after request");
    const result = applyRequest(dir, request, options.failAt);
    if (result.state !== "live") throw new Error("managed create did not commit a live row");
    return result.row;
  });
}

export function revokeManagedActorExact(
  dir: string,
  owner: string,
  actor: string,
  lifecycleUid: string | undefined,
  options: ManagedRowMutationOptions,
): boolean {
  if (!PINNED_DIRS.has(dir)) return withPinnedRoots(dir, true, (pinned) => revokeManagedActorExact(pinned, owner, actor, lifecycleUid, options));
  assertRequestId(options.requestId);
  return locked(dir, owner, actor, (dir) => {
    const requestPath = join(requestsDir(dir), `${options.requestId}.json`);
    if (existsSync(requestPath)) {
      const existing = JSON.parse(readFileSync(requestPath, "utf8")) as ManagedRowRequest;
      if (existing.owner !== owner || existing.actor !== actor || existing.kind !== "revoke")
        throw new Error(`managed request ${options.requestId} conflicts with another operation`);
      applyRequest(dir, existing, options.failAt);
      return true;
    }
    const current = readManagedActor(dir, owner, actor);
    if (current.state === "absent") return false;
    if (current.state === "tombstone") return true;
    if (lifecycleUid !== undefined && current.row.lifecycleUid !== lifecycleUid)
      throw new Error(`managed revoke refused: lifecycle ${lifecycleUid} does not own current ${current.row.lifecycleUid}`);
    const tombstone: ManagedActorTombstone = {
      ver: 1, kind: "managed-actor-tombstone", owner, actor, lifecycleUid: current.row.lifecycleUid,
      revokedAt: (options.now ?? (() => new Date()))().toISOString(), revokeOpId: options.operationId ?? options.requestId,
      previousDigest: current.digest,
    };
    const object = writeObject(dir, jsonBytes(tombstone));
    const request: ManagedRowRequest = {
      ver: 1, requestId: options.requestId, operationId: options.operationId ?? options.requestId,
      kind: "revoke", owner, actor, lifecycleUid: current.row.lifecycleUid, state: "pending",
      sourceDigest: current.digest, targetDigest: object.digest, targetObject: object.name,
    };
    writeRequest(dir, request);
    if (options.failAt === "after-request") throw new Error("injected crash after request");
    applyRequest(dir, request, options.failAt);
    return true;
  });
}

export function recoverManagedRowRequests(dir: string): number {
  if (!PINNED_DIRS.has(dir)) return withPinnedRoots(dir, true, (pinned) => recoverManagedRowRequests(pinned));
  ensureLayout(dir);
  let recovered = 0;
  for (const name of readdirSync(requestsDir(dir)).filter((name) => name.endsWith(".json")).sort()) {
    const request = JSON.parse(readFileSync(join(requestsDir(dir), name), "utf8")) as ManagedRowRequest;
    if (request.state === "host-committed") continue;
    locked(dir, request.owner, request.actor, (dir) => applyRequest(dir, request));
    recovered++;
  }
  return recovered;
}

interface BrokerOperationRow {
  ver: 1; requestId: string; wireId: string; intentDigest: string; intent: ManagedRowIntent;
  state: "pending" | "committed"; effectAt: string; resultDigest?: string;
}
interface BrokerHistoryEvent {
  ver: 1; requestId: string; operationId: string; intentDigest: string; targetDigest: string;
  predecessor: string | null; owner: string; actor: string; lifecycleUid: string; command: ManagedRowIntent["command"];
}
interface BrokerTargetRow {
  ver: 1; state: "live" | "tombstone"; owner: string; actor: string; lifecycleUid: string;
  operationId: string; effectAt: string; policy?: Omit<Extract<ManagedRowIntent, { command: "create-managed-row" }>, "ver" | "command" | "requestId" | "operationId" | "space" | "target">;
}
const wire = new TextEncoder();
const unwire = new TextDecoder();
const kvKey = (family: string, ...tokens: string[]) => `${family}.${tokens.join(".")}`;
const casLoss = (error: unknown): boolean => {
  const code = (error as { api_error?: { err_code?: number } })?.api_error?.err_code;
  return code === 10071 || code === 10164 || /wrong last sequence|key exists/i.test((error as Error)?.message ?? "");
};
async function putCreateExact(kv: KV, key: string, bytes: Uint8Array): Promise<void> {
  try { await kv.create(key, bytes); }
  catch (error) {
    if (!casLoss(error)) throw error;
    const existing = await kv.get(key);
    if (!existing || existing.operation !== "PUT" || Buffer.compare(Buffer.from(existing.value), Buffer.from(bytes)) !== 0)
      throw new Error(`managed-row create-only key ${key} exists with different bytes`);
  }
}
function parseBrokerRow<T>(bytes: Uint8Array, what: string): T {
  try { return JSON.parse(unwire.decode(bytes)) as T; }
  catch { throw new Error(`${what} is not JSON`); }
}
function validateCommittedResult(bytes: Uint8Array, op: BrokerOperationRow, historyHead?: string, targetDigest?: string): void {
  const result = parseBrokerRow<{ ok?: unknown; id?: unknown; data?: unknown }>(bytes, `managed-row result ${op.requestId}`);
  if (result.ok !== true || result.id !== op.wireId || result.data === null || typeof result.data !== "object" || Array.isArray(result.data))
    throw new Error(`managed-row result ${op.requestId} does not bind its wire echo`);
  const data = result.data as Record<string, unknown>;
  const expectedState = op.intent.command === "create-managed-row" ? "live" : "tombstone";
  if (data.command !== op.intent.command || data.requestId !== op.requestId || data.operationId !== op.intent.operationId ||
      data.state !== expectedState || canonicalJson(data.target) !== canonicalJson(op.intent.target) || typeof data.targetDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(data.targetDigest) ||
      typeof data.historyHead !== "string" || !/^[a-f0-9]{64}$/.test(data.historyHead) ||
      (historyHead !== undefined && data.historyHead !== historyHead) || (targetDigest !== undefined && data.targetDigest !== targetDigest))
    throw new Error(`managed-row result ${op.requestId} does not bind all committed coordinates`);
}
async function validateCommittedBrokerTruth(kv: KV, bytes: Uint8Array, op: BrokerOperationRow): Promise<void> {
  const eventCommitKey = kvKey("managedroweventcommit", op.intent.operationId);
  const eventCommit = await kv.get(eventCommitKey);
  if (!eventCommit || eventCommit.operation !== "PUT") throw new Error(`managed-row committed operation ${op.requestId} has no retained event commit`);
  const eventDigest = unwire.decode(eventCommit.value);
  if (!/^[a-f0-9]{64}$/.test(eventDigest)) throw new Error(`managed-row event commit ${eventCommitKey} is malformed`);
  const eventEntry = await kv.get(kvKey("managedrowevent", eventDigest));
  if (!eventEntry || eventEntry.operation !== "PUT" || rawDigest(eventEntry.value) !== `sha256:${eventDigest}`)
    throw new Error(`managed-row committed operation ${op.requestId} has no exact retained event`);
  const event = parseBrokerRow<BrokerHistoryEvent>(eventEntry.value, eventCommitKey);
  const eventKeys = ["ver", "requestId", "operationId", "intentDigest", "targetDigest", "predecessor", "owner", "actor", "lifecycleUid", "command"];
  if (event === null || typeof event !== "object" || Object.keys(event).some((key) => !eventKeys.includes(key)) ||
      (event.predecessor !== null && (typeof event.predecessor !== "string" || !/^[a-f0-9]{64}$/.test(event.predecessor))))
    throw new Error(`managed-row committed operation ${op.requestId} retained event is malformed`);
  if (typeof event.targetDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(event.targetDigest))
    throw new Error(`managed-row committed operation ${op.requestId} retained event target digest is malformed`);
  const targetObject = await kv.get(kvKey("managedrowbytes", event.targetDigest.slice("sha256:".length)));
  if (!targetObject || targetObject.operation !== "PUT" || rawDigest(targetObject.value) !== event.targetDigest)
    throw new Error(`managed-row committed operation ${op.requestId} has no exact retained target object`);
  const retainedTarget = parseBrokerRow<BrokerTargetRow>(targetObject.value, `managed-row target object ${event.targetDigest}`);
  const expectedTarget: BrokerTargetRow = op.intent.command === "create-managed-row"
    ? { ver: 1, state: "live", ...op.intent.target, operationId: op.intent.operationId, effectAt: op.effectAt,
        policy: { tokenHash: op.intent.tokenHash, scope: op.intent.scope, allowSubscribe: op.intent.allowSubscribe, allowPublish: op.intent.allowPublish,
          ...(op.intent.role !== undefined ? { role: op.intent.role } : {}), ...(op.intent.parent !== undefined ? { parent: op.intent.parent } : {}), ...(op.intent.label !== undefined ? { label: op.intent.label } : {}) } }
    : { ver: 1, state: "tombstone", ...op.intent.target, operationId: op.intent.operationId, effectAt: op.effectAt };
  if (retainedTarget === null || typeof retainedTarget !== "object" || canonicalJson(retainedTarget) !== canonicalJson(expectedTarget))
    throw new Error(`managed-row committed operation ${op.requestId} retained target object conflicts`);
  if (event.ver !== 1 || event.requestId !== op.requestId || event.operationId !== op.intent.operationId || event.intentDigest !== op.intentDigest ||
      event.owner !== op.intent.target.owner || event.actor !== op.intent.target.actor ||
      event.lifecycleUid !== op.intent.target.lifecycleUid || event.command !== op.intent.command)
    throw new Error(`managed-row committed operation ${op.requestId} event/target coordinates conflict`);
  const headEntry = await kv.get(kvKey("managedrowhead", op.intent.target.owner, op.intent.target.actor));
  if (!headEntry || headEntry.operation !== "PUT") throw new Error(`managed-row committed operation ${op.requestId} has no retained history head`);
  let cursor = unwire.decode(headEntry.value);
  const seen = new Set<string>();
  while (cursor !== eventDigest) {
    if (!/^[a-f0-9]{64}$/.test(cursor) || seen.has(cursor)) throw new Error(`managed-row history head chain for ${op.requestId} is malformed or cyclic`);
    seen.add(cursor);
    const prior = await kv.get(kvKey("managedrowevent", cursor));
    if (!prior || prior.operation !== "PUT" || rawDigest(prior.value) !== `sha256:${cursor}`) throw new Error(`managed-row history head chain for ${op.requestId} is broken`);
    const priorEvent = parseBrokerRow<BrokerHistoryEvent>(prior.value, `managed-row history event ${cursor}`);
    if (priorEvent.owner !== op.intent.target.owner || priorEvent.actor !== op.intent.target.actor || priorEvent.predecessor === null)
      throw new Error(`managed-row history head does not descend from committed operation ${op.requestId}`);
    cursor = priorEvent.predecessor;
  }
  validateCommittedResult(bytes, op, eventDigest, event.targetDigest);
}
async function validateReplaceableCommittedTombstone(kv: KV, current: { value: Uint8Array }, targetKey: string, target: BrokerTargetRow, expected: ManagedRowIntent["target"]): Promise<void> {
  const keys = ["ver", "state", "owner", "actor", "lifecycleUid", "operationId", "effectAt"];
  if (target === null || typeof target !== "object" || Object.keys(target).sort().join(",") !== keys.sort().join(",") ||
      target.ver !== 1 || target.state !== "tombstone" || typeof target.owner !== "string" || typeof target.actor !== "string" ||
      typeof target.lifecycleUid !== "string" || typeof target.operationId !== "string" || typeof target.effectAt !== "string" || Number.isNaN(Date.parse(target.effectAt)))
    throw new Error(`managed-row successor create found a malformed retained tombstone at ${targetKey}`);
  if (target.owner !== expected.owner || target.actor !== expected.actor)
    throw new Error(`managed-row successor create found a retained tombstone that does not match its target key`);
  const eventCommit = await kv.get(kvKey("managedroweventcommit", target.operationId));
  if (!eventCommit || eventCommit.operation !== "PUT") throw new Error(`managed-row successor create found no committed tombstone event for ${target.operationId}`);
  const eventDigest = unwire.decode(eventCommit.value);
  if (!/^[a-f0-9]{64}$/.test(eventDigest)) throw new Error(`managed-row successor create found a malformed tombstone event commit for ${target.operationId}`);
  const head = await kv.get(kvKey("managedrowhead", target.owner, target.actor));
  if (!head || head.operation !== "PUT" || unwire.decode(head.value) !== eventDigest)
    throw new Error(`managed-row successor create requires the retained tombstone to be the current history head`);
  const eventEntry = await kv.get(kvKey("managedrowevent", eventDigest));
  if (!eventEntry || eventEntry.operation !== "PUT" || rawDigest(eventEntry.value) !== `sha256:${eventDigest}`)
    throw new Error(`managed-row successor create found no exact retained tombstone event`);
  const event = parseBrokerRow<BrokerHistoryEvent>(eventEntry.value, `managed-row tombstone event ${eventDigest}`);
  if (event.command !== "revoke-managed-row" || event.operationId !== target.operationId || event.owner !== target.owner || event.actor !== target.actor ||
      event.lifecycleUid !== target.lifecycleUid || rawDigest(current.value) !== event.targetDigest)
    throw new Error(`managed-row successor create found conflicting tombstone event/target coordinates`);
  const opEntry = await kv.get(kvKey("managedrowop", event.requestId));
  if (!opEntry || opEntry.operation !== "PUT") throw new Error(`managed-row successor create found no retained tombstone operation`);
  const op = validateBrokerOperation(parseBrokerRow<unknown>(opEntry.value, `managed-row operation ${event.requestId}`), event.requestId);
  if (op.state !== "committed" || op.intent.command !== "revoke-managed-row" || op.intent.operationId !== target.operationId ||
      op.intent.target.owner !== target.owner || op.intent.target.actor !== target.actor || op.intent.target.lifecycleUid !== target.lifecycleUid)
    throw new Error(`managed-row successor create requires a committed revoke operation for the retained tombstone`);
  const result = await kv.get(kvKey("managedrowcommit", event.requestId));
  if (!result || result.operation !== "PUT" || rawDigest(result.value) !== op.resultDigest)
    throw new Error(`managed-row successor create found no exact committed tombstone result`);
  await validateCommittedBrokerTruth(kv, result.value, op);
}
function validateBrokerOperation(raw: unknown, requestId: string): BrokerOperationRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`managed-row operation ${requestId} is not an object`);
  const value = raw as Record<string, unknown>;
  const allowed = ["ver", "requestId", "wireId", "intentDigest", "intent", "state", "effectAt", "resultDigest"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || value.ver !== 1 || value.requestId !== requestId ||
      typeof value.wireId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.wireId) || typeof value.intentDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.intentDigest) ||
      (value.state !== "pending" && value.state !== "committed") || typeof value.effectAt !== "string" || Number.isNaN(Date.parse(value.effectAt)))
    throw new Error(`managed-row operation ${requestId} does not validate`);
  if ((value.state === "committed") !== (typeof value.resultDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.resultDigest)))
    throw new Error(`managed-row operation ${requestId} result state does not validate`);
  const intent = validateManagedRowIntent(value.intent);
  if (intent.requestId !== requestId || rawDigest(managedRowStableBytes(intent)) !== value.intentDigest) throw new Error(`managed-row operation ${requestId} intent identity does not validate`);
  return { ...(value as unknown as BrokerOperationRow), intent };
}
function validateOpenIndex(raw: unknown, requestId: string): { ver: 1; requestId: string; intentDigest: string; state: "open" | "closed"; operation: BrokerOperationRow; resultDigest?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`managed-row open index ${requestId} is not an object`);
  const value = raw as Record<string, unknown>;
  const allowed = ["ver", "requestId", "intentDigest", "state", "operation", "resultDigest"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || value.ver !== 1 || value.requestId !== requestId || typeof value.intentDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(value.intentDigest) || (value.state !== "open" && value.state !== "closed")) throw new Error(`managed-row open index ${requestId} does not validate`);
  const operation = validateBrokerOperation(value.operation, requestId);
  if (operation.intentDigest !== value.intentDigest) throw new Error(`managed-row open index ${requestId} conflicts with embedded operation`);
  if (value.state === "closed") {
    if (operation.state !== "committed" || value.resultDigest !== operation.resultDigest) throw new Error(`managed-row closed index ${requestId} has no matching committed result`);
  } else if (value.resultDigest !== undefined || operation.state !== "pending") throw new Error(`managed-row open index ${requestId} carries terminal fields`);
  return { ver: 1, requestId, intentDigest: value.intentDigest, state: value.state, operation, ...(typeof value.resultDigest === "string" ? { resultDigest: value.resultDigest } : {}) };
}

export interface ManagedRowBrokerExecutor {
  execute(input: { wireId: string; intent: ManagedRowIntent; finalAdmission(): Promise<void>; assertPreEffectOpen(): void }): Promise<Uint8Array>;
  recover(adopt: (retained: { wireId: string; intent: ManagedRowIntent }) => Promise<{ finalAdmission(): Promise<void>; assertPreEffectOpen?(): void }>): Promise<{ discovered: number; committed: number; recovered: number }>;
  close(): Promise<void>;
}

/** Broker-backed exact-operation executor. All authority rows, targets, and exact committed replies
 * live in the managedrow* KV families on the dedicated executor connection. */
export function openManagedRowBrokerExecutor(
  kv: KV,
  closeClient: () => Promise<void>,
  project: (input: { intent: ManagedRowIntent; target: BrokerTargetRow; targetBytes: Uint8Array }) => Promise<void> | void,
  walkOpen: (kv: KV, filter: string) => Promise<Awaited<ReturnType<typeof walkKvEntries>>> = walkKvEntries,
): ManagedRowBrokerExecutor {
  const flights = new Map<string, { intentDigest: string; wireId: string; promise: Promise<Uint8Array> }>();
  const actorFlights = new Map<string, Promise<void>>();
  let closed = false;
  const run = async (input: { wireId: string; intent: ManagedRowIntent; finalAdmission(): Promise<void>; assertPreEffectOpen(): void }): Promise<Uint8Array> => {
    if (closed) throw new Error("managed-row executor is closed");
    const intent = validateManagedRowIntent(input.intent);
    if (input.wireId !== managedRowWireId(intent)) throw new Error(`managed-row request ${intent.requestId} wire identity does not match its canonical immutable intent`);
    const intentDigest = rawDigest(managedRowStableBytes(intent));
    const opKey = kvKey("managedrowop", intent.requestId);
    let opEntry = await kv.get(opKey);
    let op: BrokerOperationRow;
    let effectStartedHere = false;
    if (opEntry) {
      if (opEntry.operation !== "PUT") throw new Error(`managed-row operation ${intent.requestId} carries a deletion marker`);
      op = validateBrokerOperation(parseBrokerRow<unknown>(opEntry.value, `managed-row operation ${intent.requestId}`), intent.requestId);
      if (op.ver !== 1 || op.requestId !== intent.requestId || op.wireId !== input.wireId || op.intentDigest !== intentDigest || canonicalJson(op.intent) !== canonicalJson(intent))
        throw new Error(`managed-row request ${intent.requestId} conflicts with its retained intent or wire echo`);
      if (op.state === "committed") {
        const result = await kv.get(kvKey("managedrowcommit", intent.requestId));
        if (!result || result.operation !== "PUT") throw new Error(`managed-row request ${intent.requestId} has no retained committed result`);
        if (rawDigest(result.value) !== op.resultDigest) throw new Error(`managed-row request ${intent.requestId} retained result digest mismatch`);
        await validateCommittedBrokerTruth(kv, result.value, op);
        return result.value;
      }
    } else {
      op = { ver: 1, requestId: intent.requestId, wireId: input.wireId, intentDigest, intent, state: "pending", effectAt: new Date().toISOString() };
      await input.finalAdmission();
      input.assertPreEffectOpen();
      effectStartedHere = true;
      await putCreateExact(kv, kvKey("managedrowopen", intent.requestId), wire.encode(canonicalJson({ ver: 1, requestId: intent.requestId, intentDigest, state: "open", operation: op })));
      await putCreateExact(kv, opKey, wire.encode(canonicalJson(op)));
      opEntry = await kv.get(opKey);
      if (!opEntry || opEntry.operation !== "PUT") throw new Error(`managed-row operation ${intent.requestId} reservation vanished`);
    }
    const targetKey = kvKey("managedrowtarget", intent.target.owner, intent.target.actor);
    const current = await kv.get(targetKey);
    let target: BrokerTargetRow;
    if (intent.command === "create-managed-row") {
      target = { ver: 1, state: "live", ...intent.target, operationId: intent.operationId, effectAt: op.effectAt,
        policy: { tokenHash: intent.tokenHash, scope: intent.scope, allowSubscribe: intent.allowSubscribe, allowPublish: intent.allowPublish,
          ...(intent.role !== undefined ? { role: intent.role } : {}), ...(intent.parent !== undefined ? { parent: intent.parent } : {}), ...(intent.label !== undefined ? { label: intent.label } : {}) } };
      if (current) {
        const retained = current.operation === "PUT" ? parseBrokerRow<BrokerTargetRow>(current.value, targetKey) : undefined;
        if (retained && canonicalJson(retained) !== canonicalJson(target) && retained.state === "tombstone" && retained.lifecycleUid !== intent.target.lifecycleUid)
          await validateReplaceableCommittedTombstone(kv, current, targetKey, retained, intent.target);
        else if (!retained || canonicalJson(retained) !== canonicalJson(target))
          throw new Error(`managed-row create refused: ${intent.target.owner}.${intent.target.actor} is already reserved or changed`);
      }
    } else {
      if (!current || current.operation !== "PUT") throw new Error(`managed-row revoke refused: retained target is absent`);
      const previous = parseBrokerRow<BrokerTargetRow>(current.value, targetKey);
      if (previous.state === "tombstone" && previous.lifecycleUid === intent.target.lifecycleUid) target = previous;
      else {
        if (previous.state !== "live" || previous.lifecycleUid !== intent.target.lifecycleUid)
          throw new Error(`managed-row revoke refused: lifecycle ${intent.target.lifecycleUid} is not the retained live owner`);
        target = { ver: 1, state: "tombstone", ...intent.target, operationId: intent.operationId, effectAt: op.effectAt };
      }
    }
    // Existing pending operations have not yet entered this process's effect region. Fresh admission
    // and the synchronous latch check sit immediately before its first effect-bearing KV call.
    if (!effectStartedHere) {
      await input.finalAdmission();
      input.assertPreEffectOpen();
    }
    const targetBytes = wire.encode(canonicalJson(target));
    const targetDigest = rawDigest(targetBytes);
    await putCreateExact(kv, kvKey("managedrowbytes", targetDigest.slice("sha256:".length)), targetBytes);
    if (!current) await putCreateExact(kv, targetKey, targetBytes);
    else if (Buffer.compare(Buffer.from(current.value), Buffer.from(targetBytes)) !== 0) {
      try { await kv.update(targetKey, targetBytes, current.revision); }
      catch (error) { if (casLoss(error)) throw new Error(`managed-row target ${targetKey} changed at the final effect fence`); throw error; }
    }
    // Project broker truth into the existing filesystem reader before readiness/result commit. A
    // crash leaves the operation pending and boot recovery repeats this idempotent projection.
    await project({ intent, target, targetBytes });
    const headKey = kvKey("managedrowhead", intent.target.owner, intent.target.actor);
    const head = await kv.get(headKey);
    if (head && head.operation !== "PUT") throw new Error(`managed-row history head ${headKey} carries a deletion marker`);
    const eventCommitKey = kvKey("managedroweventcommit", intent.operationId);
    const priorEventCommit = await kv.get(eventCommitKey);
    let eventDigest: string;
    if (priorEventCommit) {
      if (priorEventCommit.operation !== "PUT") throw new Error(`managed-row event commit ${eventCommitKey} carries a deletion marker`);
      eventDigest = unwire.decode(priorEventCommit.value);
      const retained = await kv.get(kvKey("managedrowevent", eventDigest));
      if (!retained || retained.operation !== "PUT") throw new Error(`managed-row event commit ${eventCommitKey} has no retained event`);
      const event = parseBrokerRow<BrokerHistoryEvent>(retained.value, eventCommitKey);
      if (event.ver !== 1 || event.requestId !== intent.requestId || event.operationId !== intent.operationId || event.intentDigest !== intentDigest ||
          event.targetDigest !== targetDigest || event.owner !== intent.target.owner || event.actor !== intent.target.actor || event.lifecycleUid !== intent.target.lifecycleUid || event.command !== intent.command)
        throw new Error(`managed-row retained event ${eventDigest} conflicts with operation ${intent.operationId}`);
    } else {
      const predecessor = head ? unwire.decode(head.value) : null;
      const event: BrokerHistoryEvent = { ver: 1, requestId: intent.requestId, operationId: intent.operationId, intentDigest,
        targetDigest, predecessor, ...intent.target, command: intent.command };
      const eventBytes = wire.encode(canonicalJson(event));
      eventDigest = rawDigest(eventBytes).slice("sha256:".length);
      await putCreateExact(kv, kvKey("managedrowevent", eventDigest), eventBytes);
      await putCreateExact(kv, eventCommitKey, wire.encode(eventDigest));
    }
    if (!head) await putCreateExact(kv, headKey, wire.encode(eventDigest));
    else if (unwire.decode(head.value) !== eventDigest) {
      try { await kv.update(headKey, wire.encode(eventDigest), head.revision); }
      catch (error) {
        if (!casLoss(error)) throw error;
        const winner = await kv.get(headKey);
        if (!winner || winner.operation !== "PUT" || unwire.decode(winner.value) !== eventDigest)
          throw new Error(`managed-row history head ${headKey} moved before commit; refusing older-head rollback`);
      }
    }
    const reply = wire.encode(canonicalJson(managedRowSuccessReply(input.wireId, { ver: 1, command: intent.command, requestId: intent.requestId, operationId: intent.operationId, target: intent.target, state: target.state, targetDigest, historyHead: eventDigest })));
    const resultDigest = rawDigest(reply);
    await putCreateExact(kv, kvKey("managedrowcommit", intent.requestId), reply);
    const committed: BrokerOperationRow = { ...op, state: "committed", resultDigest };
    try { await kv.update(opKey, wire.encode(canonicalJson(committed)), opEntry!.revision); }
    catch (error) {
      if (!casLoss(error)) throw error;
      const winner = await kv.get(opKey);
      if (!winner || winner.operation !== "PUT" || canonicalJson(parseBrokerRow<BrokerOperationRow>(winner.value, opKey)) !== canonicalJson(committed))
        throw new Error(`managed-row operation ${intent.requestId} lost its commit CAS`);
    }
    const openEntry = await kv.get(kvKey("managedrowopen", intent.requestId));
    if (!openEntry || openEntry.operation !== "PUT") throw new Error(`managed-row open index ${intent.requestId} vanished before terminalization`);
    await kv.update(kvKey("managedrowopen", intent.requestId), wire.encode(canonicalJson({ ver: 1, requestId: intent.requestId, intentDigest, state: "closed", operation: committed, resultDigest })), openEntry.revision);
    return (await kv.get(kvKey("managedrowcommit", intent.requestId)))!.value;
  };
  return {
    execute(input) {
      const intent = validateManagedRowIntent(input.intent);
      const intentDigest = rawDigest(managedRowStableBytes(intent));
      const existing = flights.get(intent.requestId);
      if (existing) {
        if (existing.intentDigest !== intentDigest || existing.wireId !== input.wireId)
          return Promise.reject(new Error(`managed-row in-flight request ${intent.requestId} conflicts with its retained intent or wire echo`));
        return existing.promise;
      }
      const actorKey = `${intent.target.owner}.${intent.target.actor}`;
      const previous = actorFlights.get(actorKey) ?? Promise.resolve();
      let release!: () => void;
      const actorTail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
      actorFlights.set(actorKey, actorTail);
      const promise = previous.then(() => run({ ...input, intent })).finally(() => {
        release();
        if (actorFlights.get(actorKey) === actorTail) actorFlights.delete(actorKey);
        if (flights.get(intent.requestId)?.promise === promise) flights.delete(intent.requestId);
      });
      flights.set(intent.requestId, { intentDigest, wireId: input.wireId, promise });
      return promise;
    },
    async recover(adopt) {
      const entries = await walkOpen(kv, "managedrowopen.>");
      let committed = 0, recovered = 0;
      for (const entry of entries) {
        if (entry.operation !== "PUT" || !entry.key.startsWith("managedrowopen.")) throw new Error(`invalid managed-row open index entry ${entry.key}`);
        const requestId = entry.key.slice("managedrowopen.".length);
        const open = validateOpenIndex(parseBrokerRow<unknown>(entry.value, entry.key), requestId);
        let opEntry = await kv.get(kvKey("managedrowop", requestId));
        if (!opEntry) {
          await putCreateExact(kv, kvKey("managedrowop", requestId), wire.encode(canonicalJson(open.operation)));
          opEntry = await kv.get(kvKey("managedrowop", requestId));
        }
        if (!opEntry || opEntry.operation !== "PUT") throw new Error(`managed-row open index ${entry.key} has no retained operation`);
        const op = validateBrokerOperation(parseBrokerRow<unknown>(opEntry.value, `managed-row operation ${requestId}`), requestId);
        if (canonicalJson(op) !== canonicalJson(open.operation)) {
          const pendingIdentity = (value: BrokerOperationRow) => {
            const { resultDigest: _resultDigest, ...identity } = value;
            return canonicalJson({ ...identity, state: "pending" });
          };
          const exactCommitTransition = open.state === "open" && open.operation.state === "pending" && op.state === "committed" &&
            pendingIdentity(op) === pendingIdentity(open.operation);
          if (!exactCommitTransition) throw new Error(`managed-row open index ${requestId} does not match its operation row`);
        }
        const intent = validateManagedRowIntent(op.intent);
        if (op.ver !== 1 || op.requestId !== requestId || op.intentDigest !== open.intentDigest || op.intentDigest !== rawDigest(managedRowStableBytes(intent)))
          throw new Error(`managed-row open index ${entry.key} conflicts with its retained operation`);
        if (op.state === "committed") {
          const result = await kv.get(kvKey("managedrowcommit", requestId));
          if (!result || result.operation !== "PUT" || rawDigest(result.value) !== op.resultDigest)
            throw new Error(`committed managed-row operation ${requestId} has no exact retained result`);
          await validateCommittedBrokerTruth(kv, result.value, op);
          if (open.state === "open") {
            await kv.update(entry.key, wire.encode(canonicalJson({ ver: 1, requestId, intentDigest: op.intentDigest, state: "closed", operation: op, resultDigest: op.resultDigest })), entry.revision);
          } else if (open.resultDigest !== op.resultDigest) throw new Error(`closed managed-row index ${requestId} result digest conflicts with its operation`);
          committed++; continue;
        }
        if (op.state !== "pending") throw new Error(`managed-row operation ${requestId} has unknown state`);
        const custody = await adopt({ wireId: op.wireId, intent });
        await this.execute({ wireId: op.wireId, intent, finalAdmission: custody.finalAdmission, assertPreEffectOpen: custody.assertPreEffectOpen ?? (() => {}) });
        recovered++;
      }
      return { discovered: entries.length, committed, recovered };
    },
    close: async () => { closed = true; await Promise.allSettled([...flights.values()].map((flight) => flight.promise)); await closeClient(); },
  };
}

export function prepareManagedAuthorization(
  dir: string,
  args: { owner: string; actor: string; lifecycleUid: string; requestId: string; consumerId: string; requestDigest: string },
): PreparedManagedAuthorization {
  const reservation = pinRoots(dir, true);
  dir = reservation.dir;
  assertRequestId(args.requestId); assertDigest(args.requestDigest, "requestDigest"); assertToken(args.consumerId, "consumerId");
  let snap: ManagedActorRead;
  try {
    snap = readManagedActor(dir, args.owner, args.actor);
    if (snap.state !== "live" || snap.row.lifecycleUid !== args.lifecycleUid) throw new Error("managed authorization denied: actor is absent, revoked, or a different lifecycle");
    verifyManagedHistoryAgainstCanonical(dir, args.owner, args.actor, snap.bytes);
  } catch (error) { reservation.close(); throw error; }
  if (snap.state !== "live") { reservation.close(); throw new Error("managed authorization denied"); }
  let terminal = false;
  return Object.freeze({
    ...args,
    rowDigest: snap.digest,
    historyHead: snap.historyHead,
    fence: snap.fence,
    commit(resultDigest: string, resultBytes: Uint8Array): Uint8Array {
      if (terminal) throw new Error("managed authorization reservation is terminal");
      assertDigest(resultDigest, "resultDigest");
      if (sha256(resultBytes) !== resultDigest) throw new Error("managed authorization result digest mismatch");
      try { const delivered = locked(dir, args.owner, args.actor, (dir) => {
        const current = readManagedActor(dir, args.owner, args.actor);
        if (current.state !== "live" || current.row.lifecycleUid !== args.lifecycleUid || current.digest !== snap.digest ||
            current.historyHead !== snap.historyHead || current.fence !== snap.fence)
          throw new Error("managed authorization cancelled by revocation or successor transition");
        const binding = sha256(`${args.requestId}\0${args.consumerId}\0${args.requestDigest}`);
        const path = join(cacheDir(dir), `${binding}.bin`);
        if (!existsSync(path)) writeDurable(path, resultBytes, true);
        const exact = readFileSync(path);
        if (sha256(exact) !== resultDigest) throw new Error("managed authorization cache bytes changed");
        return exact;
      });
      terminal = true;
      reservation.close();
      return delivered;
      } catch (error) { terminal = true; reservation.close(); throw error; }
    },
    cancel(_outcome: string): void { terminal = true; reservation.close(); },
  });
}

export function verifyManagedHistoryAgainstCanonical(dir: string, owner: string, actor: string, canonicalBytes: Uint8Array): string {
  if (!PINNED_DIRS.has(dir)) return withPinnedRoots(dir, false, (pinned) => verifyManagedHistoryAgainstCanonical(pinned, owner, actor, canonicalBytes));
  let head = readHead(dir, owner, actor);
  const selected = head;
  const seen = new Set<string>();
  while (head !== "0".repeat(64)) {
    if (seen.has(head)) throw new Error("managed history contains a cycle");
    seen.add(head);
    const path = join(historyDir(dir), `${head}.json`);
    if (!existsSync(path)) throw new Error(`managed history is missing commit ${head}`);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== head) throw new Error(`managed history commit ${head} has changed bytes`);
    const event = JSON.parse(bytes.toString("utf8")) as ManagedHistoryEvent;
    if (event.owner !== owner || event.actor !== actor) throw new Error("managed history key binding mismatch");
    const targetPath = join(bytesDir(dir), `${event.targetDigest}.json`);
    if (!existsSync(targetPath)) throw new Error(`managed history is missing target bytes ${event.targetDigest}`);
    const targetBytes = readFileSync(targetPath);
    if (sha256(targetBytes) !== event.targetDigest) throw new Error(`managed history target ${event.targetDigest} has changed bytes`);
    if (head === selected && Buffer.compare(targetBytes, Buffer.from(canonicalBytes)) !== 0)
      throw new Error("managed canonical row does not match the immutable selected history target");
    head = event.predecessor ?? "0".repeat(64);
  }
  return selected;
}

export function verifyManagedHistory(dir: string, owner: string, actor: string): string {
  const canonical = readManagedActor(dir, owner, actor);
  if (canonical.state === "absent") throw new Error("managed history has no canonical row");
  return verifyManagedHistoryAgainstCanonical(dir, owner, actor, canonical.bytes);
}

export function managedRowStatePaths(dir: string): { root: string; requests: string; bytes: string; history: string; heads: string; fences: string } {
  if (!PINNED_DIRS.has(dir)) {
    withPinnedRoots(dir, false, () => undefined);
    const root = join(dirname(resolve(dir)), "managed-row-state");
    return { root, requests: join(root, "requests"), bytes: join(root, "bytes"), history: join(root, "history"), heads: join(root, "heads"), fences: join(root, "fences") };
  }
  return { root: stateRoot(dir), requests: requestsDir(dir), bytes: bytesDir(dir), history: historyDir(dir), heads: headsDir(dir), fences: fencesDir(dir) };
}
