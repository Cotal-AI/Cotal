import { readFileSync } from "node:fs";

/** `.cotal/web.session` — the web dashboard's record of the listener it bound, written 0600 beside its
 *  pidfile. The dashboard writes it and reads it back in its detached parent, and `cotal status` reads
 *  it from a package that cannot import the dashboard's. The name, the shape and the one reader live
 *  here so that a change reaches both packages or fails to compile in them. */
export const WEB_SESSION_FILE = "web.session";

/** The header that presents {@link WebSession.readiness} to the dashboard. Lower-case because Node
 *  lower-cases incoming header names, so a capitalised name would never match and would look like a
 *  working check. */
export const WEB_READINESS_HEADER = "x-cotal-readiness";

export interface WebSession {
  /** The single-use link that opens one browser session. */
  readonly launchUrl: string;
  /** Accepted in {@link WEB_READINESS_HEADER} on `/api/meta` only, for the dashboard's whole life,
   *  so a caller can poll whether the listener is up and is this dashboard. */
  readonly readiness: string;
  /** The socket's bound address, not the requested one: a hostname `--host` binds what it resolved to. */
  readonly host: string;
  readonly port: number;
}

/** The whole record, or `undefined` while there is none to read: the dashboard writes it only once it
 *  is listening, truncates the file before writing, and removes it on exit, so an absent, empty or
 *  partial file is an ordinary moment in its life. A file that exists and cannot be read is not, and
 *  reading it as absent would report a live dashboard as down, so that error throws. */
export function readWebSession(path: string): WebSession | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const { launchUrl, readiness, host, port } = JSON.parse(text) as Record<string, unknown>;
    if (typeof launchUrl !== "string" || typeof readiness !== "string" || typeof host !== "string" || typeof port !== "number")
      return undefined;
    return { launchUrl, readiness, host, port };
  } catch { return undefined; }
}
