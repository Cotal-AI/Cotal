/** Why a hosted Manager lost its connection to its space. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ManagerConnection } from "./protocol.js";

const LOOKUP_MS = 3000;
// A system lookup that outlives LOOKUP_MS still holds a libuv worker thread until it returns, so a
// host never has more than one in flight. Later checks wait on the same one.
const pending = new Map<string, Promise<unknown>>();

/** Look up the host of the broker at `server`. A lookup that fails or does not finish means this
 *  computer has no working internet connection. One that works means the space is not answering. */
export async function lostConnection(server: string, resolve: (host: string) => Promise<unknown> = lookup): Promise<ManagerConnection> {
  const host = new URL(server).hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) !== 0) return { state: "unreachable", reason: `${host} is not answering` };
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
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { state: "offline", reason: `this computer cannot look up ${host}${typeof code === "string" ? ` (${code})` : ""}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { state: "unreachable", reason: `${host} is not answering` };
}
