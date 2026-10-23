/** How a stopped legacy root last ran, read from its own files. A legacy `down` drops the
 *  registration that kept the root's broker address, and `clean all` also removes the broker
 *  configuration a start rendered there, so a bare `up` would otherwise start on the default
 *  address, in static auth, under the folder's default space. */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { accountInventory, authDir } from "@cotal-ai/workspace";
import { listFreshTeamSummaries } from "./team-fresh.js";

/** The `host:` and `port:` a rendered broker configuration names, as a broker URL. */
function renderedServer(path: string): string | undefined {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 64 * 1024) return undefined;
    const text = readFileSync(path, "utf8");
    const host = /^host:\s*(\S+)\s*$/m.exec(text)?.[1], port = /^port:\s*(\d+)\s*$/m.exec(text)?.[1];
    return host && port ? `nats://${host.includes(":") ? `[${host}]` : host}:${port}` : undefined;
  } catch { return undefined; }
}

/** Whether the root holds a broker account, readable or not. */
function holdsAccount(root: string): boolean {
  try { const inventory = accountInventory(authDir(root)); return inventory.spaces.length > 0 || inventory.corrupt.length > 0; }
  catch { return true; }
}

/** The broker this root's last start rendered: `.cotal/auth/server.conf` in static auth when the root
 *  holds an account, else `.cotal/server-open.conf` in open mode. Undefined when neither names one. */
export function retainedLegacyBroker(root: string): { server: string; open: boolean } | undefined {
  if (holdsAccount(root)) {
    const server = renderedServer(join(authDir(root), "server.conf"));
    return server ? { server, open: false } : undefined;
  }
  const server = renderedServer(join(root, ".cotal", "server-open.conf"));
  return server ? { server, open: true } : undefined;
}

/** After `clean all` removed a root's identity and broker configuration, the newest fresh team
 *  summary still names the manifest it was deployed from. Returns the command that deploys it again
 *  when a bare `up` (`open` asks for the open mode, `space` is the folder's space) would start
 *  another address, mode or space instead, else undefined. */
export function cleanedManifestStart(root: string, space: string, open: boolean): { command: string; space: string; server: string; mode: "open" | "auth" } | undefined {
  if (holdsAccount(root) || existsSync(join(root, ".cotal", "server-open.conf"))) return undefined;
  let summaries: ReturnType<typeof listFreshTeamSummaries>["valid"];
  try { summaries = listFreshTeamSummaries(root).valid; } catch { return undefined; }
  const last = summaries.filter((summary) => summary.authMode !== "user").sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).at(-1);
  if (!last) return undefined;
  const mode = last.authMode === "open" ? "open" : "auth";
  if (last.server === DEFAULT_SERVER && last.space === space && (mode === "open") === open) return undefined;
  return { command: existsSync(last.manifestPath) ? `cotal up -f ${last.manifestPath}` : `cotal up --space ${last.space}${mode === "open" ? " --open" : ""} --server ${last.server}`, space: last.space, server: last.server, mode };
}
