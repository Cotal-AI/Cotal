import { readdirSync } from "node:fs";
import { isAbsolute, join, normalize, dirname, basename } from "node:path";
import type { Extension } from "@cotal-ai/core";
import { spaceKey } from "./auth-paths.js";

/** Context supplied to local process providers by workstation commands such as `down` and `status`. */
export interface LocalProcessContext {
  readonly root: string;
  readonly space: string;
  readonly userAuth?: boolean;
}

/** A workstation-owned process recorded by a pidfile under a mesh root. Optional packages register
 *  these beside their commands so lifecycle commands stay ignorant of package-specific processes.
 *  Metadata is declarative and cached at install time: status/down never import package code. An
 *  extension-provided process must claim its pidfile with an exclusive create and refuse an existing
 *  file; extension removal reserves the same path so startup and uninstall cannot cross. */
export interface LocalProcess extends Extension {
  readonly kind: "local-process";
  readonly name: string;
  readonly label: string;
  /** Lower orders stop first; the broker should remain last so dependants can shut down cleanly. */
  readonly order?: number;
  /** Path relative to `<root>/.cotal`; `{space}` expands to the injective hex space key
   *  (`spaceKey` — case-safe, so two case-differing spaces can never share a pid/log file). */
  readonly pidFile: string;
  /** Files removed only after the process is confirmed gone. Same template rules as `pidFile`. */
  readonly artifacts?: readonly string[];
  /** Refuse selective shutdown while any unselected registered process is still live. */
  readonly stopLast?: boolean;
  /** Removing this process also clears transient run state and the machine mesh registry entry. */
  readonly clearsMesh?: boolean;
  /** Hide this process from status unless the selected mesh uses per-user auth. */
  readonly visibleWhen?: "user-auth";
}

/** Resolve a declarative local-process path, rejecting absolute/traversal templates. */
export function localProcessPath(template: string, context: LocalProcessContext): string {
  if (!template.trim()) throw new Error("local-process path must not be empty");
  const expanded = template.replaceAll("{space}", spaceKey(context.space));
  const normalized = normalize(expanded);
  if (normalized === "." || isAbsolute(expanded) || normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    throw new Error(`local-process path must stay under .cotal: ${JSON.stringify(template)}`);
  const canonical = join(context.root, ".cotal", normalized);
  // A `{space}`-keyed file (the user-auth service pid/log) was written `auth-service.<encoded>.pid`
  // before the hex re-key. `down`/`status` READ this path to find and stop the process; if only the
  // canonical hex name is checked, a pre-upgrade auth-service - a callout SIGNER - is a live process
  // whose legacy pidfile is skipped, so `down` exits 0 leaving it running (the customer-update-path
  // invariant AGENTS.md calls load-bearing: an upgrade must never silently orphan a signer). Admit
  // the legacy name too, BYTE-EXACT (a bare `existsSync` would case-fold on macOS/Windows and match
  // another space's legacy file); both present is ambiguous and fails loud, mirroring the state-dir
  // and registry legacy shims.
  if (template.includes("{space}")) {
    const legacy = join(context.root, ".cotal", normalize(template.replaceAll("{space}", encodeURIComponent(context.space))));
    if (legacy !== canonical) {
      const has = (p: string) => existsByteExact(p);
      const canonicalExists = has(canonical);
      const legacyExists = has(legacy);
      if (legacyExists && canonicalExists)
        throw new Error(`both ${canonical} and the pre-hex ${legacy} exist for space "${context.space}" - ambiguous process record; remove the stale one`);
      if (legacyExists) return legacy;
    }
  }
  return canonical;
}

/** Byte-exact existence: an entry named exactly `basename(p)` in its parent dir. `existsSync` on a
 *  case-insensitive filesystem reports a case-folded sibling as present, which for a legacy pidfile
 *  lookup would match a DIFFERENT space's file; this matches only the exact name. */
function existsByteExact(p: string): boolean {
  try {
    return readdirSync(dirname(p)).includes(basename(p));
  } catch {
    return false; // parent absent → not present
  }
}

export function localProcessVisible(process: LocalProcess, context: LocalProcessContext): boolean {
  return process.visibleWhen !== "user-auth" || context.userAuth === true;
}
