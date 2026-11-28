import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import { Resolver } from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";

export type ResolvedSpawnBroker = { server: string; hosts: Map<string, LookupAddress[]> };

const hostKey = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "");

async function resolveHost(resolver: Resolver, host: string): Promise<LookupAddress[]> {
  const [ipv4, ipv6] = await Promise.all([
    resolver.resolve4(host).catch((): string[] => []),
    resolver.resolve6(host).catch((): string[] => []),
  ]);
  const v4 = ipv4.map(address => ({ address, family: 4 }));
  const v6 = ipv6.map(address => ({ address, family: 6 }));
  return dns.getDefaultResultOrder() === "ipv6first" ? [...v6, ...v4] : [...v4, ...v6];
}

/** Keep the recorded transport, hostname and port. An unanswered name is not a dial candidate. */
export async function resolveSpawnBroker(server: string, expiresAt: number): Promise<ResolvedSpawnBroker | undefined> {
  const remaining = Math.ceil(expiresAt - performance.now());
  if (remaining <= 0) return undefined;
  const targets = server.split(",").map(raw => raw.trim()).filter(Boolean).map(target => {
    const url = new URL(target.includes("://") ? target : `nats://${target}`);
    return { target, host: hostKey(url.hostname) };
  });
  const names = [...new Set(targets.map(t => t.host).filter(host => !isIP(host)))];
  const hosts = new Map<string, LookupAddress[]>();
  if (!names.length) return { server, hosts };

  const resolver = new Resolver({ timeout: remaining, tries: 1 });
  resolver.setServers(dns.getServers());
  const timer = setTimeout(() => resolver.cancel(), remaining);
  try {
    await Promise.all(names.map(async host => { hosts.set(host, await resolveHost(resolver, host)); }));
    const usable = targets.filter(({ host }) => isIP(host) || hosts.get(host)?.length);
    if (!usable.length) return undefined;
    const websocket = (target: string) => /^wss?:\/\//i.test(target);
    // The first address chooses the list's transport. Keep it if filtering would switch transport.
    const filtered = websocket(targets[0]!.target) === websocket(usable[0]!.target)
      ? usable.map(t => t.target).join(",") : server;
    return { server: filtered, hosts };
  } finally {
    clearTimeout(timer);
    resolver.cancel();
  }
}

type LookupResult = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/** Install only inside the single-use observation worker. Both the NATS dial and Node's WebSocket
 * keep the original URL (including TLS identity), but neither may start an OS DNS lookup. */
export function pinSpawnBrokerLookup({ hosts }: ResolvedSpawnBroker): void {
  dns.lookup = ((hostname: string, options: LookupOptions | number | LookupResult, callback?: LookupResult) => {
    const reply = typeof options === "function" ? options : callback!;
    const opts = typeof options === "number" ? { family: options } : typeof options === "function" ? {} : options;
    const host = hostKey(hostname);
    const literal = isIP(host);
    const answers = literal ? [{ address: host, family: literal }] : (hosts.get(host) ?? []);
    const family = opts?.family === "IPv4" ? 4 : opts?.family === "IPv6" ? 6 : opts?.family;
    const matching = family ? answers.filter(address => address.family === family) : answers;
    queueMicrotask(() => {
      const first = matching[0];
      if (!first) reply(Object.assign(new Error("No address for registered broker hostname"), { code: "ENOTFOUND" }));
      else if (opts?.all) reply(null, matching);
      else reply(null, first.address, first.family);
    });
  }) as typeof dns.lookup;
  syncBuiltinESMExports();
}
