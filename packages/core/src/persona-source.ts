import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { rawDigest } from "./canonical.js";

export const PERSONA_SOURCE_META_KEY = "ai.cotal.persona.source";
const PREFIX = "fs-v1:";

export function isPersonaSourceRef(value: unknown): value is string {
  return typeof value === "string" && /^fs-v1:[a-f0-9]{64}:sha256:[a-f0-9]{64}$/.test(value);
}

function bootScope(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot))
      return PREFIX + rawDigest(`cotal persona source\0${boot}`).slice("sha256:".length) + ":";
  } catch { /* No boot scope is available. */ }
}

/** A restored local launch must not advertise an origin associated with another boot. */
export function isLocalPersonaSourceRef(value: unknown): value is string {
  const scope = bootScope();
  return scope !== undefined && isPersonaSourceRef(value) && value.startsWith(scope);
}

/** Advisory reference to a directory entry on this Linux boot. Following the parent but not the
 *  entry gives directory aliases the same scope without merging two final symlinks or hard links.
 *  A host without a usable filesystem scope reports no reference. */
export function personaSourceRef(path: string): string | undefined {
  const scope = bootScope();
  if (scope === undefined) return undefined;
  try {
    const dir = statSync(dirname(path), { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    const file = entry.isSymbolicLink() ? statSync(path, { bigint: true }) : entry;
    if (!dir.isDirectory() || !file.isFile() || !dir.ino || !entry.ino || !file.ino) return undefined;
    return scope + rawDigest([dir.dev, dir.ino, entry.dev, entry.ino, entry.birthtimeNs, file.dev, file.ino, file.birthtimeNs, basename(path)].join("\0"));
  } catch {
    return undefined;
  }
}
