/** Why a hosted Manager lost its connection to its space. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ManagerConnection } from "./protocol.js";

const LOOKUP_MS = 3000;
// A system lookup that outlives LOOKUP_MS still holds a libuv worker thread until it returns, so a
// host never has more than one in flight. Later checks wait on the same one.
const pending = new Map<string, Promise<unknown>>();

/** Look up the hosts of the brokers in `servers` (one URL, or a comma-separated list). When every
 *  lookup fails or does not finish, this computer has no working internet connection. When one
 *  works, or a broker is named by its address, the space is not answering. */
export async function lostConnection(servers: string, resolve: (host: string) => Promise<unknown> = lookup): Promise<ManagerConnection> {
  const hosts = [...new Set(servers.split(",").map((server) => new URL(server.trim()).hostname.replace(/^\[(.*)\]$/, "$1")))];
  const address = hosts.find((host) => isIP(host) !== 0);
  if (address !== undefined) return { state: "unreachable", reason: `${address} is not answering` };
  const failures = await Promise.all(hosts.map((host) => lookupFailure(host, resolve)));
  const found = hosts.find((_, i) => failures[i] === undefined);
  if (found !== undefined) return { state: "unreachable", reason: `${found} is not answering` };
  return { state: "offline", reason: `this computer cannot look up ${hosts[0]}${failures[0] ? ` (${failures[0]})` : ""}` };
}

/** Undefined when `host` looks up; otherwise the failure's code, or "" when it has none. */
async function lookupFailure(host: string, resolve: (host: string) => Promise<unknown>): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending.get(host) ?? (() => {
        const attempt = resolve(host).finally(() => pending.delete(host));
        pending.set(host, attempt);
        return attempt;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("lookup did not finish"), { code: "ETIMEOUT" })), LOOKUP_MS); }),
    ]);
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
