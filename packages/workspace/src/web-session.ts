import { readFileSync } from "node:fs";
import { serviceStartupPath } from "./service-startup.js";

/** `.cotal/web.session` — the web dashboard's record of the listener it bound, written 0600 beside its
 *  pidfile. The dashboard writes it and reads it back in its detached parent, and `cotal status` reads
 *  it from a package that cannot import the dashboard's. The name, the shape and the one reader live
 *  here so that a change reaches both packages or fails to compile in them. */
export const WEB_SESSION_FILE = "web.session";

/** `.cotal/web.pid` — the web dashboard's pidfile. The dashboard declares it, and `cotal status`, the
 *  setup card and `cotal clean` read it from a package that cannot import the dashboard's, so the
 *  name lives here where a rename reaches every reader. */
export const WEB_PIDFILE = "web.pid";

/** The local-process adapter the `web` service preset launches. `cotal status` finds a service-run
 *  dashboard's instance by it, from a package that cannot import the dashboard's. */
export const WEB_SERVICE_ADAPTER = "web-service";

/** A service-run dashboard's session record, the {@link WebSession} its native child writes beside its
 *  startup receipt, named for the full instance and launch. That child never writes `web.session`. */
export function serviceWebSessionPath(context: Parameters<typeof serviceStartupPath>[0]): string {
  return serviceStartupPath(context).replace(/\.ready\.json$/, ".web-session.json");
}

/** The header that presents {@link WebSession.readiness} to the dashboard. Lower-case because Node
 *  lower-cases incoming header names, so a capitalised name would never match and would look like a
 *  working check. */
export const WEB_READINESS_HEADER = "x-cotal-readiness";

/** The only path {@link WEB_READINESS_HEADER} opens. The dashboard's gate and route and
 *  {@link probeWebReadiness} share it so they cannot disagree about which path that is. */
export const WEB_READINESS_PATH = "/api/meta";

/** What the dashboard answers on {@link WEB_READINESS_PATH}. Whatever owns the port writes it, so
 *  neither field is trusted to be present or typed. */
export interface WebMeta {
  readonly space?: unknown;
  readonly pid?: unknown;
}

/** One readiness request to the dashboard whose base address is `url`, presenting `readiness` when
 *  there is one. `cotal web --detach` polls it and `cotal status` sends it once, so both send the
 *  same request and read its answer the same way. Resolves to the HTTP status, plus the parsed body
 *  only when the answer is OK, because no other answer has a defined body. A redirect is not
 *  followed: it would carry the readiness header to an address or path the port's owner picked and
 *  take the identity from there, so a 3xx resolves to its status like any other answer that is not
 *  OK. A transport error, the timeout, or an OK body that is not JSON rejects. */
export async function probeWebReadiness(url: string, readiness: string | undefined): Promise<{ status: number; meta?: WebMeta }> {
  const res = await fetch(new URL(WEB_READINESS_PATH, url), {
    signal: AbortSignal.timeout(500),
    headers: readiness === undefined ? {} : { [WEB_READINESS_HEADER]: readiness },
    redirect: "manual",
  });
  return res.ok ? { status: res.status, meta: await res.json() as WebMeta } : { status: res.status };
}

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
