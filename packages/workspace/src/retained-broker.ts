import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountInventory, authDir, spaceFromKey } from "./auth-paths.js";
import { readLocalRecordSource } from "./local-record-source.js";

const CONFIG_LIMIT = 64 * 1024;
const openBrokerConfigPath = (root: string): string => join(root, ".cotal", "server-open.conf");

function renderedBrokerServer(text: string, protocol = "nats"): string | undefined {
  const host = /^host:\s*(\S+)\s*$/m.exec(text)?.[1], port = /^port:\s*(\d+)\s*$/m.exec(text)?.[1];
  return host && port ? `${protocol}://${host.includes(":") ? `[${host}]` : host}:${port}` : undefined;
}

/** The `host:` and `port:` a rendered broker configuration names, as a broker URL. */
function renderedServer(path: string): string | undefined {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > CONFIG_LIMIT) return undefined;
    return renderedBrokerServer(readFileSync(path, "utf8"));
  } catch { return undefined; }
}

/** Whether the root holds a broker account, readable or not. */
export function rootHoldsAccount(root: string): boolean {
  try { const inventory = accountInventory(authDir(root)); return inventory.spaces.length > 0 || inventory.corrupt.length > 0; }
  catch { return true; }
}

function renderedOpenSpace(text: string): string | undefined {
  const key = /^# space key: ([0-9a-f]+)$/m.exec(text)?.[1];
  return key === undefined ? undefined : spaceFromKey(key);
}

/** The space identity recorded by an open broker's rendered configuration. */
export function retainedOpenSpace(root: string): string | undefined {
  try { return renderedOpenSpace(readFileSync(openBrokerConfigPath(root), "utf8")); } catch { return undefined; }
}

/** The broker address and mode retained in this root's rendered configuration. */
export function retainedLegacyBroker(root: string): { server: string; open: boolean } | undefined {
  if (rootHoldsAccount(root)) {
    const server = renderedServer(join(authDir(root), "server.conf"));
    return server ? { server, open: false } : undefined;
  }
  const server = renderedServer(openBrokerConfigPath(root));
  return server ? { server, open: true } : undefined;
}

/** The store path in a Cotal-rendered broker configuration, resolved from the broker's cwd. */
export function renderedBrokerStore(config: string, cwd: string): string | undefined {
  const named = /jetstream \{ store_dir: ("(?:[^"\\]|\\.)*")/.exec(config)?.[1];
  return named === undefined ? undefined : resolve(cwd, JSON.parse(named) as string);
}

/** The space, listener and store named by one retained open broker configuration. */
export function retainedOpenBroker(root: string): { space: string; server: string; storeDir: string } | undefined {
  if (rootHoldsAccount(root)) return undefined;
  const text = readLocalRecordSource(openBrokerConfigPath(root), CONFIG_LIMIT, true)?.toString("utf8");
  if (text === undefined) return undefined;
  const space = renderedOpenSpace(text);
  const server = renderedBrokerServer(text, /^tls[ \t]*\{/m.test(text) ? "tls" : "nats");
  const storeDir = renderedBrokerStore(text, root);
  return space && server && storeDir ? { space, server, storeDir } : undefined;
}
