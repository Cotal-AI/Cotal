/**
 * The commands and skills an OpenCode 1.x seat started in a directory would run, read before any seat
 * exists. A 1.x server lists both at `GET /command` on the first request (measured on 1.19.6), so this
 * reads that list once from a private server (private-serve.ts) and names each entry as the seat's
 * dispatcher does (commands1.ts).
 */
import type { CommandCatalog } from "@cotal-ai/core";
import { opencode1CommandEntries } from "./commands1.js";
import { freePort, readPrivateServe, type PrivateServe } from "./private-serve.js";

export async function openCode1CommandCatalog(o: Omit<PrivateServe, "port">): Promise<CommandCatalog> {
  // 1.x takes port 0 as 4096 while that is free, the port an operator's own server defaults to.
  const port = String(await freePort());
  return readPrivateServe({ ...o, port }, async ({ url, auth, signal }) => {
    const res = await fetch(`${url}/command`, { headers: { authorization: auth }, signal });
    if (!res.ok) throw new Error(`opencode serve answered /command with HTTP ${res.status}`);
    return { supported: true, commands: opencode1CommandEntries(await res.json()) };
  });
}
