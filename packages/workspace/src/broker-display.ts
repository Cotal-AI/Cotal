import { oneLine } from "@cotal-ai/core";

/** Broker addresses for reports, without URL user info, query strings or fragments. An unparsed
 *  value is unknown, never raw output. Connection and registry values are not changed. */
export function brokerAddressForDisplay(servers: string): string | undefined {
  try {
    return servers.split(",").map((server) => {
      const input = server.trim();
      const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(input);
      const url = new URL(bare ? `nats://${input}` : input);
      if (!url.hostname) throw new Error("broker address has no host");
      if (!["nats:", "tls:", "ws:", "wss:"].includes(url.protocol)) throw new Error("unsupported broker scheme");
      if (url.pathname && url.pathname !== "/" && url.protocol !== "ws:" && url.protocol !== "wss:")
        throw new Error("TCP broker address has a path");
      if (!url.username && !url.password && !url.search && !url.hash) return oneLine(server);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return bare ? url.href.slice("nats://".length) : url.href;
    }).join(",");
  } catch {
    return undefined;
  }
}
