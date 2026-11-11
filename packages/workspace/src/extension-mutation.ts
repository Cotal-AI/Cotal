import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, constants, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { acquireLock, acquireLockAsync, inspectLock, processStartToken, type AcquireOptions, type HeldLock } from "./advisory-lock.js";
import { extensionMutationLockPath } from "./extensions.js";
import { claimUpdateClosureAccess } from "./update-closure.js";

function extensionUpdatePassLockPath(): string {
  return `${extensionMutationLockPath()}.update`;
}

export function extensionNpmMutationPath(): string {
  return `${extensionMutationLockPath()}.npm-child`;
}

function canonicalGlobalRoot(root: string): string {
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

function globalUpdateChildPath(root: string): string {
  return join(canonicalGlobalRoot(root), ".cotal-update-child");
}

export function claimGlobalNpmUpdateLock(root: string, opts: { waitMs?: number } = {}): () => void {
  const canonicalRoot = canonicalGlobalRoot(root);
  const held = acquireLock(join(canonicalRoot, ".cotal-update.lock"), {
    label: "a global cotal-ai update",
    waitMs: opts.waitMs ?? 0,
    onTimeout: (owner) => new Error(
      `another cotal-ai update is using npm global root ${canonicalRoot} (pid ${owner.pid}) - retry once it finishes`,
    ),
  });
  try {
    assertNoProcessMutation(globalUpdateChildPath(canonicalRoot), "global cotal-ai update child");
    return () => held.release();
  } catch (e) {
    held.release();
    throw e;
  }
}

export interface ExtensionMutationOptions {
  readonly waitMs?: number;
  readonly borrowUpdateParent?: number;
  readonly label?: string;
  readonly timeoutMessage?: (pid: number) => string;
}

/** One lock acquisition the policy needs. The policy only says WHAT to acquire; the sync and async
 *  claimers differ only in HOW they acquire it (and, for async, how the wait is budgeted). */
interface LockRequest {
  readonly path: string;
  readonly opts: AcquireOptions;
}

type MutationPolicy = Generator<LockRequest, () => void, HeldLock>;

/** Update pass: acquire it, then refuse while an extension npm child is still marked live. */
function* updatePassPolicy(waitMs: number | undefined): MutationPolicy {
  // The first lock can create the shared config root. A group-writable umask must not make
  // Cotal's own directory fail the completion writer's protected-ancestor check.
  mkdirSync(dirname(extensionMutationLockPath()), { recursive: true, mode: 0o700 });
  const held = yield {
    path: extensionUpdatePassLockPath(),
    opts: {
      label: "a `cotal update` extension pass",
      waitMs: waitMs ?? 0,
      onTimeout: (owner) => new Error(`another extension update or mutation is in progress (pid ${owner.pid}) - retry once it finishes`),
    },
  };
  try {
    assertNoProcessMutation(extensionNpmMutationPath(), "extension npm mutation");
    return () => held.release();
  } catch (e) {
    held.release();
    throw e;
  }
}

/** Shared pass -> writer order for every extension-prefix reader that can rewrite peer links and
 * every writer. An update child may borrow its live parent's pass, but always owns the writer. */
function* mutationPolicy(opts: ExtensionMutationOptions): MutationPolicy {
  let releasePass: () => void;
  if (opts.borrowUpdateParent === undefined) {
    releasePass = yield* updatePassPolicy(opts.waitMs);
  } else {
    if (!extensionUpdatePassOwnedBy(opts.borrowUpdateParent))
      throw new Error("the extension update parent no longer owns its pass lock");
    assertNoProcessMutation(extensionNpmMutationPath(), "extension npm mutation");
    releasePass = () => {};
  }
  try {
    const held = yield {
      path: extensionMutationLockPath(),
      opts: {
        label: opts.label ?? "an extension mutation",
        waitMs: opts.waitMs ?? 0,
        onTimeout: (owner) => new Error(
          opts.timeoutMessage?.(owner.pid) ?? `another extension mutation is in progress (pid ${owner.pid}) - retry once it finishes`,
        ),
      },
    };
    return () => {
      held.release();
      releasePass();
    };
  } catch (e) {
    releasePass();
    throw e;
  }
}

/** Drive a policy with the blocking acquirer. */
function runPolicy(policy: MutationPolicy): () => void {
  let step = policy.next();
  while (!step.done) {
    let held: HeldLock;
    try {
      held = acquireLock(step.value.path, step.value.opts);
    } catch (e) {
      policy.throw(e); // lets the policy release what it already holds; it rethrows
      throw e;
    }
    step = policy.next(held);
  }
  return step.value;
}

/** Drive a policy with the awaited acquirer. `waitMs` is one deadline shared by every acquisition: each
 *  request waits at most the time left, so the pass and the writer together never exceed it. */
async function runPolicyAsync(policy: MutationPolicy, waitMs: number): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  let step = policy.next();
  while (!step.done) {
    let held: HeldLock;
    try {
      held = await acquireLockAsync(step.value.path, {
        ...step.value.opts,
        waitMs: Math.min(step.value.opts.waitMs ?? 0, Math.max(0, deadline - Date.now())),
      });
    } catch (e) {
      policy.throw(e);
      throw e;
    }
    step = policy.next(held);
  }
  return step.value;
}

/** Blocking claim of the pass -> writer locks; see {@link mutationPolicy}. */
export function claimExtensionMutationLock(opts: ExtensionMutationOptions = {}): () => void {
  const release = claimUpdateClosureAccess();
  try {
    const writer = runPolicy(mutationPolicy(opts));
    return () => { try { writer(); } finally { release(); } };
  } catch (error) { release(); throw error; }
}

/** {@link claimExtensionMutationLock} for async callers: the wait is an awaited timer, not a blocked
 *  event loop, and `waitMs` is one deadline shared by the pass and the writer acquisition. */
export async function claimExtensionMutationLockAsync(opts: Omit<ExtensionMutationOptions, "borrowUpdateParent"> = {}): Promise<() => void> {
  const release = claimUpdateClosureAccess();
  try {
    const writer = await runPolicyAsync(mutationPolicy(opts), opts.waitMs ?? 0);
    return () => { try { writer(); } finally { release(); } };
  } catch (error) { release(); throw error; }
}

export function claimExtensionUpdatePass(opts: { waitMs?: number } = {}): () => void {
  const release = claimUpdateClosureAccess();
  try {
    const pass = runPolicy(updatePassPolicy(opts.waitMs));
    return () => { try { pass(); } finally { release(); } };
  } catch (error) { release(); throw error; }
}

export function extensionUpdatePassOwnedBy(pid: number): boolean {
  const found = inspectLock(extensionUpdatePassLockPath());
  return found.state === "active" && found.owner.pid === pid;
}

export type ProcessMutationRecord =
  | { readonly phase: "pending"; readonly owner: number; readonly ownerStart?: string; readonly intermediary: boolean; readonly nonce: string; readonly operation?: string }
  | { readonly phase: "live"; readonly owner: number; readonly ownerStart?: string; readonly pid: number; readonly start?: string; readonly intermediary: boolean; readonly nonce: string; readonly operation?: string }
  | { readonly phase: "ambiguous"; readonly owner: number; readonly nonce: string; readonly operation?: string; readonly reason: string };

export interface ProcessMutation {
  markLive(pid: number): void;
  markAmbiguous(reason: string): void;
  complete(status: number | null, signal: NodeJS.Signals | null, ambiguityReason: string): void;
  clear(): void;
}

export function processExitIsAmbiguous(
  status: number | null,
  signal: NodeJS.Signals | null,
  intermediary: boolean,
): boolean {
  return signal !== null || (intermediary && status !== 0);
}

export function beginExtensionNpmMutation(intermediary = process.platform === "win32"): ProcessMutation {
  return beginProcessMutation(extensionNpmMutationPath(), "extension npm mutation", intermediary);
}

export function beginGlobalUpdateChild(root: string, operation: "install" | "reconcile"): ProcessMutation {
  return beginProcessMutation(
    globalUpdateChildPath(root),
    `global ${operation}`,
    operation === "install" && process.platform === "win32",
  );
}

/** Local account records used only for the migration inspector's private-group proof. */
export interface UpdateCustodyAccounts {
  readonly passwd: string;
  readonly group: string;
  readonly nsswitch: string;
}

function boundedAccountFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const limit = 1024 * 1024;
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > limit) throw new Error(`untrusted local account file (${path})`);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
    const after = fstatSync(fd);
    if (size > limit || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error(`local account file changed or exceeded its limit (${path})`);
    return bytes.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

/** Prove a primary group from complete local records. No NSS commands or ACL inspection. */
export function updateCustodyPrivateGroup(accounts: UpdateCustodyAccounts, uid: number, gid: number): boolean {
  if (Object.values(accounts).some(value => value.length > 1024 * 1024)) return false;
  const sources = new Map<string, string[]>();
  for (const raw of accounts.nsswitch.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) return false;
    if (!["passwd", "group"].includes(match[1]!)) continue;
    if (sources.has(match[1]!)) return false;
    sources.set(match[1]!, match[2]!.split(/\s+/).filter(Boolean));
  }
  if (["passwd", "group"].some(key => !sources.get(key)?.length || sources.get(key)!.some(source => !["files", "systemd"].includes(source)))) return false;
  const users: { name: string; uid: number; gid: number }[] = [];
  const ids = /^(0|[1-9]\d{0,9})$/;
  for (const line of accounts.passwd.split("\n").filter(Boolean)) {
    const row = line.split(":");
    if (row.length !== 7 || !row[0] || !ids.test(row[2]!) || !ids.test(row[3]!)) return false;
    users.push({ name: row[0], uid: Number(row[2]), gid: Number(row[3]) });
  }
  const self = users.filter(user => user.uid === uid);
  if (new Set(users.map(user => user.name)).size !== users.length || self.length !== 1 || self[0]!.gid !== gid || users.some(user => user.gid === gid && user.uid !== uid)) return false;
  const groups: { gid: number; members: string[] }[] = [];
  for (const line of accounts.group.split("\n").filter(Boolean)) {
    const row = line.split(":");
    if (row.length !== 4 || !row[0] || !ids.test(row[2]!)) return false;
    groups.push({ gid: Number(row[2]), members: row[3] ? row[3].split(",") : [] });
  }
  const primary = groups.filter(group => group.gid === gid);
  return primary.length === 1 && primary[0]!.members.every(member => member === self[0]!.name);
}

/** Read custody without acquiring, clearing, or repairing the parent's marker.
 * Group-writable paths require a locally proven primary private group. Extended ACLs are not examined. */
export function inspectGlobalUpdateChild(root: string, localAccounts?: UpdateCustodyAccounts): { owner: ReturnType<typeof inspectLock>; child: ProcessMutationRecord | undefined } {
  const canonical = realpathSync(root);
  let accounts = localAccounts;
  const protectedMode = (stat: Stats): boolean => {
    if ((stat.mode & 0o002) !== 0) return false;
    if ((stat.mode & 0o020) === 0) return true;
    if (!process.getuid || !process.getgid || stat.uid !== process.getuid() || stat.gid !== process.getgid()) return false;
    accounts ??= { passwd: boundedAccountFile("/etc/passwd"), group: boundedAccountFile("/etc/group"), nsswitch: boundedAccountFile("/etc/nsswitch.conf") };
    return updateCustodyPrivateGroup(accounts, process.getuid(), stat.gid);
  };
  for (let path = canonical;; path = dirname(path)) {
    const stat = lstatSync(path);
    const stickyRoot = path !== canonical && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || (!stickyRoot && !protectedMode(stat)) || (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid()))
      throw new Error(`global update custody ancestor is not protected (${path})`);
    if (dirname(path) === path) break;
  }
  for (const path of [canonical, join(canonical, ".cotal-update.lock"), join(canonical, ".cotal-update-child")]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (process.getuid && stat.uid !== process.getuid()) || !protectedMode(stat))
      throw new Error(`global update custody path is not protected (${path})`);
  }
  return { owner: inspectLock(join(canonical, ".cotal-update.lock")), child: readMarker(join(canonical, ".cotal-update-child")) };
}

/** Journal an actual mutating child across wrapper death. Pending closes spawn->PID publication;
 * live tracks the child itself; ambiguous is operator-repaired and never auto-cleared. */
function beginProcessMutation(path: string, operation: string, intermediary: boolean): ProcessMutation {
  assertNoProcessMutation(path, operation);
  const nonce = randomBytes(12).toString("hex");
  const ownerStart = processStartToken(process.pid);
  writeMarker(path, { phase: "pending", owner: process.pid, ownerStart, intermediary, nonce, operation });
  return {
    markLive(pid) {
      if (!positiveInteger(pid)) throw new Error(`invalid ${operation} child pid ${pid}`);
      const current = readMarker(path);
      if (!current || current.nonce !== nonce)
        throw new Error(`${operation} marker changed before the child PID was published`);
      writeMarker(path, {
        phase: "live",
        owner: process.pid,
        ownerStart,
        pid,
        start: processStartToken(pid),
        intermediary,
        nonce,
        operation,
      });
    },
    markAmbiguous(reason) {
      const current = readMarker(path);
      if (!current || current.nonce !== nonce)
        throw new Error(`${operation} marker changed before ambiguity was recorded`);
      writeMarker(path, { phase: "ambiguous", owner: process.pid, nonce, operation, reason });
    },
    complete(status, signal, ambiguityReason) {
      if (processExitIsAmbiguous(status, signal, intermediary)) {
        const current = readMarker(path);
        if (!current || current.nonce !== nonce)
          throw new Error(`${operation} marker changed before ambiguity was recorded`);
        writeMarker(path, { phase: "ambiguous", owner: process.pid, nonce, operation, reason: ambiguityReason });
        return;
      }
      removeMarker(path, nonce);
    },
    clear() {
      removeMarker(path, nonce);
    },
  };
}

function assertNoProcessMutation(path: string, operation: string): void {
  const marker = readMarker(path);
  if (!marker) return;
  if (marker.phase === "ambiguous") {
    throw new Error(`${marker.operation ?? operation} ended ambiguously (${marker.reason}; ${path}) - if no descendant process is running, remove the marker and retry`);
  }
  if (marker.phase === "pending") {
    if (sameProcessAlive(marker.owner, marker.ownerStart))
      throw new Error(`${marker.operation ?? operation} is starting under pid ${marker.owner} - retry once it finishes`);
    throw new Error(`${marker.operation ?? operation} may have been orphaned before publishing its child PID (${path}) - if no descendant process is running, remove the marker and retry`);
  }
  if (sameProcessAlive(marker.pid, marker.start))
    throw new Error(`${marker.operation ?? operation} is still running (pid ${marker.pid}) - retry once it finishes`);
  if (marker.intermediary) {
    const ownerAlive = sameProcessAlive(marker.owner, marker.ownerStart);
    throw new Error(
      ownerAlive
        ? `${marker.operation ?? operation} intermediary exited while its wrapper is still classifying descendant state - retry once it finishes`
        : `${marker.operation ?? operation} intermediary exited after its wrapper died; descendant completion is unproved (${path}) - if no descendant process is running, remove the marker and retry`,
    );
  }
  removeMarker(path, marker.nonce);
}

function sameProcessAlive(pid: number, start: string | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
  }
  if (start === undefined) return true;
  const now = processStartToken(pid);
  return now === undefined || now === start;
}

function readMarker(path: string): ProcessMutationRecord | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`process mutation marker is unreadable (${path}): ${(e as Error).message}`);
  }
  if (!validMarker(parsed))
    throw new Error(`process mutation marker is invalid (${path}) - inspect running npm/cotal processes before removing it`);
  return parsed;
}

function validMarker(value: unknown): value is ProcessMutationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  if (!positiveInteger(marker.owner) || !validNonce(marker.nonce) || !optionalString(marker.operation)) return false;
  if (marker.phase === "pending") {
    return optionalString(marker.ownerStart) && typeof marker.intermediary === "boolean" &&
      exactKeys(marker, ["phase", "owner", "ownerStart", "intermediary", "nonce", "operation"]);
  }
  if (marker.phase === "live") {
    return positiveInteger(marker.pid) && optionalString(marker.ownerStart) && optionalString(marker.start) &&
      typeof marker.intermediary === "boolean" &&
      exactKeys(marker, ["phase", "owner", "ownerStart", "pid", "start", "intermediary", "nonce", "operation"]);
  }
  if (marker.phase === "ambiguous") {
    return typeof marker.reason === "string" && marker.reason.length > 0 && exactKeys(marker, ["phase", "owner", "nonce", "operation", "reason"]);
  }
  return false;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function validNonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/.test(value);
}

function exactKeys(record: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function writeMarker(path: string, marker: ProcessMutationRecord): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
}

function removeMarker(path: string, nonce: string): void {
  const marker = readMarker(path);
  if (marker?.nonce === nonce) rmSync(path, { force: true });
}
