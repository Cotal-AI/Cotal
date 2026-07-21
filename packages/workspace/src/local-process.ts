import { isAbsolute, join, normalize } from "node:path";
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
  return join(context.root, ".cotal", normalized);
}

export function localProcessVisible(process: LocalProcess, context: LocalProcessContext): boolean {
  return process.visibleWhen !== "user-auth" || context.userAuth === true;
}
