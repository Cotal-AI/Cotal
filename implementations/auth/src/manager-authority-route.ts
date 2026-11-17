import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isCredentialTransportUrl, mkSecretDir, parseSecretStoreIdentity, sameSecretStoreIdentity, writeSecretFileCreateOnly, type SecretStore, type SecretStoreIdentity } from "@cotal-ai/core";
import { spaceSegment } from "@cotal-ai/workspace";

export interface ManagerAuthorityRoute {
  endpoint: string;
  idpUrl: string;
}
interface RoutePin extends ManagerAuthorityRoute {
  ver: 1;
  provider: "cotal";
  space: string;
  dir: string;
  storeIdentity: SecretStoreIdentity;
}

export function managerAuthorityRouteUrl(value: unknown): string {
  if (typeof value !== "string" || !value || /[\s\\\u0000-\u001f\u007f]/.test(value))
    throw new Error("manager authority route requires a canonical URL");
  const parsed = new URL(value);
  if (!isCredentialTransportUrl(parsed) || parsed.username || parsed.password || parsed.search || parsed.hash || value.includes("?") || value.includes("#") || value.includes("@"))
    throw new Error("manager authority route refuses credentials, queries, fragments, or insecure transport");
  return parsed.href;
}

function identity(store: SecretStore): SecretStoreIdentity {
  if (store.identity === undefined) throw new Error("manager authority route requires an explicit store identity");
  return parseSecretStoreIdentity(store.identity);
}

function parse(raw: unknown, store: SecretStore, dir: string, space: string): RoutePin {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid manager authority route pin");
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some(key => !["ver", "provider", "space", "dir", "storeIdentity", "endpoint", "idpUrl"].includes(key)) || o.ver !== 1 || o.provider !== "cotal" || o.space !== space || o.dir !== resolve(dir) || typeof o.dir !== "string" || !isAbsolute(o.dir))
    throw new Error("manager authority route pin has changed provider, space, directory, or schema");
  const storeIdentity = parseSecretStoreIdentity(o.storeIdentity);
  if (storeIdentity.kind === "fs") {
    // Workspace filesystem identities name the participant root, not its .cotal directory.
    const original = lstatSync(join(storeIdentity.root, ".cotal", "store.id"), { throwIfNoEntry: false });
    if (!original?.isFile()) throw new Error("manager authority route original store identity is missing or nonregular");
  }
  if (!sameSecretStoreIdentity(storeIdentity, identity(store))) throw new Error("manager authority route store identity changed");
  const endpoint = managerAuthorityRouteUrl(o.endpoint), idpUrl = managerAuthorityRouteUrl(o.idpUrl);
  if (endpoint !== o.endpoint || idpUrl !== o.idpUrl) throw new Error("manager authority route pin contains noncanonical URLs");
  if (!new URL(endpoint).pathname.endsWith("/manager-service-authority")) throw new Error("invalid manager authority endpoint path");
  return { ver: 1, provider: "cotal", space, dir: resolve(dir), storeIdentity, endpoint, idpUrl };
}

/** Read only the original explicit directory. Missing pins never discover another authority. */
export function loadManagerAuthorityRoute(store: SecretStore, dir: string, space: string): ManagerAuthorityRoute | undefined {
  spaceSegment(space);
  const file = join(resolve(dir), "manager-authority-route.json");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error("manager authority route pin is not a regular file");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("manager authority route pin changed while opening");
    const pin = parse(JSON.parse(readFileSync(fd, "utf8")), store, dir, space);
    return { endpoint: pin.endpoint, idpUrl: pin.idpUrl };
  } finally { closeSync(fd); }
}

/** Publish before any remote effect. A concurrent creator must pin the same authority. */
export function pinManagerAuthorityRoute(store: SecretStore, dir: string, space: string, route: ManagerAuthorityRoute): ManagerAuthorityRoute {
  spaceSegment(space);
  const existing = loadManagerAuthorityRoute(store, dir, space);
  if (existing) {
    if (existing.endpoint !== route.endpoint || existing.idpUrl !== route.idpUrl) throw new Error("manager authority route pin changed; refusing another authority");
    return existing;
  }
  const pin = parse({ ver: 1, provider: "cotal", space, dir: resolve(dir), storeIdentity: identity(store), endpoint: route.endpoint, idpUrl: route.idpUrl }, store, dir, space);
  mkSecretDir(resolve(dir));
  try { writeSecretFileCreateOnly(join(resolve(dir), "manager-authority-route.json"), `${JSON.stringify(pin)}\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const saved = loadManagerAuthorityRoute(store, dir, space);
  if (!saved || saved.endpoint !== pin.endpoint || saved.idpUrl !== pin.idpUrl) throw new Error("manager authority route pin changed; refusing another authority");
  return saved;
}
