import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export interface ExecutionIdentity {
  readonly logicalEntry: string;
  readonly loadedEntry: string;
  readonly launchEntry?: string;
}

/** Process-local identity supplied by the built-ins bootstrap, never inherited from the environment. */
export function executionIdentity(): ExecutionIdentity | undefined {
  const value: unknown = Reflect.get(globalThis, Symbol.for("cotal.execution.identity"));
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !Object.isFrozen(value)) throw new Error("invalid execution identity");
  const record = value as ExecutionIdentity;
  for (const entry of [record.logicalEntry, record.loadedEntry]) {
    if (typeof entry !== "string" || !isAbsolute(entry) || realpathSync(entry) !== entry) throw new Error("invalid execution entry identity");
    const root = dirname(dirname(entry));
    const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; bin?: { cotal?: unknown } };
    if (meta.name !== "cotal-ai" || meta.bin?.cotal !== "./dist/cotal.js" || entry !== join(root, "dist", "cotal.js"))
      throw new Error("execution identity does not name the declared cotal entry");
  }
  const logical = dirname(dirname(record.logicalEntry)), loaded = dirname(dirname(record.loadedEntry));
  if (logical !== loaded) {
    const rel = relative(join(dirname(dirname(logical)), ".cotal-generations"), loaded);
    const parts = rel.split(sep);
    if (isAbsolute(rel) || parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || parts[1] !== "cotal-ai")
      throw new Error("loaded execution identity is outside the owning generation store");
  }
  if (record.launchEntry !== undefined && (!isAbsolute(record.launchEntry) || realpathSync(record.launchEntry) !== record.logicalEntry)) throw new Error("execution launch route differs from logical entry");
  return record;
}

/** Stable installed destination, separate from the immutable package this process loaded. */
export function logicalExecutionEntry(): string | undefined {
  return executionIdentity()?.logicalEntry;
}
