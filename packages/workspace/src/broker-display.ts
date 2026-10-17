/** Broker addresses for reports, without URL user info, query strings or fragments. An unparsed
 *  value is unknown, never raw output. Connection and registry values are not changed. */
export function brokerAddressForDisplay(servers: string): string | undefined {
  try {
    return servers.split(",").map((server) => {
      const input = server.trim();
      const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(input);
      const url = new URL(bare ? `nats://${input}` : input);
      if (!url.username && !url.password && !url.search && !url.hash) return server;
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
