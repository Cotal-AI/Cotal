import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Which Cotal copy runs the background service, in words a window can show without a path. */
export interface ServiceOwner {
  readonly kind: "app" | "cli";
  /** Where that copy lives, for Details only. */
  readonly location: string;
}

/** Classify an installation entry. The desktop app ships its runtime with a `desktop-runtime.json`
 *  marker beside `dist/cotal.js`, the same marker `daemonServeArgv` reads. */
export function serviceOwner(entry: string): ServiceOwner {
  const root = dirname(dirname(entry));
  const app = existsSync(join(root, "desktop-runtime.json"));
  return { kind: app ? "app" : "cli", location: app ? appBundle(root) : root };
}

/** The app bundle or install folder that holds a desktop runtime, for Details. */
function appBundle(runtime: string): string {
  const parts = runtime.split(sep);
  const bundle = parts.findIndex(part => part.endsWith(".app"));
  return bundle >= 0 ? parts.slice(0, bundle + 1).join(sep) : dirname(dirname(runtime));
}
