import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, inspectLock, processStartToken } from "./advisory-lock.js";
import { extensionMutationLockPath } from "./extensions.js";

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

/** Shared pass -> writer order for every extension-prefix reader that can rewrite peer links and
 * every writer. An update child may borrow its live parent's pass, but always owns the writer. */
export function claimExtensionMutationLock(opts: ExtensionMutationOptions = {}): () => void {
  const releasePass = opts.borrowUpdateParent === undefined
    ? claimExtensionUpdatePass({ waitMs: opts.waitMs })
    : (() => {
        if (!extensionUpdatePassOwnedBy(opts.borrowUpdateParent))
          throw new Error("the extension update parent no longer owns its pass lock");
        assertNoProcessMutation(extensionNpmMutationPath(), "extension npm mutation");
        return () => {};
      })();
  try {
    const held = acquireLock(extensionMutationLockPath(), {
      label: opts.label ?? "an extension mutation",
      waitMs: opts.waitMs ?? 0,
      onTimeout: (owner) => new Error(
        opts.timeoutMessage?.(owner.pid) ?? `another extension mutation is in progress (pid ${owner.pid}) - retry once it finishes`,
      ),
    });
    return () => {
      held.release();
      releasePass();
    };
  } catch (e) {
    releasePass();
    throw e;
  }
}

export function claimExtensionUpdatePass(opts: { waitMs?: number } = {}): () => void {
  const held = acquireLock(extensionUpdatePassLockPath(), {
    label: "a `cotal update` extension pass",
    waitMs: opts.waitMs ?? 0,
    onTimeout: (owner) => new Error(`another extension update or mutation is in progress (pid ${owner.pid}) - retry once it finishes`),
  });
  try {
    assertNoProcessMutation(extensionNpmMutationPath(), "extension npm mutation");
    return () => held.release();
  } catch (e) {
    held.release();
    throw e;
  }
}

export function extensionUpdatePassOwnedBy(pid: number): boolean {
  const found = inspectLock(extensionUpdatePassLockPath());
  return found.state === "active" && found.owner.pid === pid;
}

type ProcessMutationRecord =
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
