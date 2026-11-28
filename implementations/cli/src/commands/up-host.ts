import { lookup } from "node:dns/promises";
import { createServer, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { CommandFailure, brokerAddressForDisplay } from "@cotal-ai/workspace";
import { c } from "../ui.js";

/** Wildcard binds mean "every interface", so they are NOT an address a client can be told to dial:
 *  the probe/registry URL stays whatever it already is (loopback by default), which the wildcard
 *  bind necessarily covers. */
export const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/** The legacy TLS dial and certificate name is distinct from its local bind. */
export function tlsDialName(server: string | undefined): string | undefined {
  if (!server || !/^tls:\/\//i.test(server)) return undefined;
  const hostname = URL.parse(server)?.hostname;
  return hostname && !hostname.startsWith("[") && !isIP(hostname) ? hostname : undefined;
}

/** Check the machine's resolver, including its hosts file. The URL keeps the name for TLS. */
export async function assertLocalTlsDialName(server: string | undefined, bind = "127.0.0.1"): Promise<void> {
  const name = tlsDialName(server);
  if (!name) return;
  const local = new Set(Object.values(networkInterfaces()).flatMap((rows) => rows?.map(({ address }) => address) ?? []));
  const addresses = await lookup(name, { all: true }).catch(() => []);
  const covered = (address: string, family: number) => bind === address || bind === name ||
    WILDCARD_HOSTS.has(bind) && (bind !== "0.0.0.0" || family === 4);
  if (addresses.some(({ address, family }) => covered(address, family)) && addresses.every(({ address }) => local.has(address))) return;
  throw new CommandFailure("refused", "USAGE_INVALID", `--server names ${name}, which does not resolve exclusively to local addresses with one reachable through the broker bind ${bind}; nothing was started or written`, {
    remedy: "resolve the TLS server name to a local address and use a matching --host",
  });
}

/** Establish that a bind-host value IS a host, BEFORE anything brackets it, and return the
 *  bracketed literal a URL can hold (#1697).
 *
 *  `--host` is the bind address; its sibling `--server` takes a URL, the registry stores and prints
 *  URLs, and every message in this area shows one — so an operator plausibly types the URL here
 *  (the manifest's `broker.host` carries the same ambiguity against `broker.servers`). Unrejected,
 *  the IPv6 bracketing wrapped it into `nats://[nats://127.0.0.1:4222]:4222`, which is not a URL at
 *  all. Nothing checked the derived string: the first code to look at it compared it with the
 *  space's registry record, failed for a reason unrelated to what was typed, and showed the
 *  operator the "registered by hand" refusal whose remedy de-registers a live mesh. Refused by name
 *  here instead — pointing at the URL-carrying sibling — and a value that still cannot serve as a
 *  URL host (a `host:port` spelling, say) is refused rather than reaching that comparison as a
 *  silently wrong server string. Never rewritten: a value this flag cannot use is an error, not a
 *  URL to derive from. */
function assertBindableHost(host: string, source: string, urlSource: string): { literal: string; hostname: string } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    console.error(
      c.red(
        `✗ ${source} ${host} looks like a URL - it takes a bind host only (an IP or hostname, no scheme); pass the broker URL with ${urlSource} instead`,
      ),
    );
    process.exit(1);
  }
  const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    // ONE parse, both consumers served from it: `literal` builds the derived URL (a URL host needs
    // the brackets), `hostname` compares against the explicit server's (the URL API strips them).
    return { literal, hostname: new URL(`nats://${literal}:1`).hostname };
  } catch {
    console.error(
      c.red(
        `✗ ${source} ${host} is not a valid bind host - an IP or hostname only, with no port; the port comes from ${urlSource} (or its default), never from the bind host`,
      ),
    );
    process.exit(1);
  }
}

/**
 * Reconcile the bind address (`--host`, manifest `broker.host`) with the broker URL the readiness
 * probe, the mesh registry, and every later client use.
 *
 * They must name the same address. Left independent, `--host <non-loopback>` bound correctly and was
 * then probed at the loopback default: the probe found nothing, timed out, and the caller SIGTERM'd
 * a broker that had started perfectly, so `--host` alone could never succeed. With no explicit URL,
 * derive one from the host (keeping the implicit URL's port); with both, refuse a contradicting pair rather
 * than starting a broker that nothing can reach.
 */
export function reconcileHostAndServer(host: string, explicitServer: string | undefined, source = "--host", urlSource = "--server", implicitServer = DEFAULT_SERVER): string {
  const url = new URL(explicitServer ?? implicitServer);
  if (WILDCARD_HOSTS.has(host)) return explicitServer ?? implicitServer;
  const { literal, hostname } = assertBindableHost(host, source, urlSource);
  if (!explicitServer) return `nats://${literal}:${url.port || "4222"}`;
  // NO parse on this path: `assertBindableHost` just parsed the identical literal above, so the
  // mismatch check compares two parsed hostnames and can only ever print its diagnostic and exit 1
  // — the "never throw a raw Invalid URL" requirement (#1697) holds by construction, not by a
  // second guard that no input could reach.
  if (url.hostname !== hostname) {
    console.error(
      c.red(
        `✗ ${source} ${host} and ${urlSource} ${explicitServer} name different addresses - the broker would bind ${host} but be probed at ${url.hostname}. Pass one, or make them agree.`,
      ),
    );
    process.exit(1);
  }
  return explicitServer;
}

/** Bind the manifest's exact listener address before any team-boot write. Releasing this
 *  socket is not a reservation: the real broker still owns the final bind verdict. */
export async function assertFreshTeamBindAvailable(server: string, host: string, space: string): Promise<void> {
  const url = new URL(server), port = Number(url.port || "4222");
  const displayServer = brokerAddressForDisplay(server) ?? "not displayable";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new CommandFailure("refused", "USAGE_INVALID", "the fresh team broker needs a concrete TCP port before it can check its bind address", { target: { space } });
  await new Promise<void>((resolve, reject) => {
    const socket = createServer(), controller = new AbortController();
    socket.unref();
    let settled = false;
    const finish = (error?: CommandFailure) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local broker bind inspection did not complete within its deadline; no absence or startup eligibility was inferred", { target: { space, server: displayServer } }));
    }, 1500);
    socket.once("error", () => finish(new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected broker address cannot be bound as a new local listener; no existing or remote broker was adopted", { target: { space, server: displayServer }, remedy: "inspect this local bind address and any process already listening there" })));
    try {
      socket.listen({ port, host, signal: controller.signal }, () => {
        if (settled) return;
        socket.close((error) => finish(error ? new CommandFailure("failed", "OPERATION_FAILED", "the temporary bind inspection did not confirm closure; no broker was started", { target: { space, server: displayServer } }) : undefined));
      });
    } catch {
      controller.abort();
      finish(new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected broker bind address was rejected before startup; no other listener was chosen", { target: { space, server: displayServer } }));
    }
  });
}
