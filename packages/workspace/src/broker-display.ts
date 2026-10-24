import { oneLine } from "@cotal-ai/core";
import { CommandFailure } from "./output.js";

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

/** Whether a broker URL, or any URL in a comma-separated list, has a user name or password in it. A
 *  value with no scheme is read as nats://, as the NATS client reads it. */
export function brokerUrlHasUserinfo(servers: string): boolean {
  return servers.split(",").some((entry) => /^[^:/?#]+:\/\/[^/?#]*@/.test(entry.includes("://") ? entry.trim() : `nats://${entry.trim()}`));
}

/** The refusal of a broker URL with a user name or password in it, before the command runs. The NATS
 *  client keeps only a broker URL's host and port, so those credentials would be dropped in silence.
 *  `what` names where the URL came from, such as `--server` or `COTAL_SERVER`; the value is never
 *  repeated. */
export function brokerUrlCredentialRefusal(what: string): CommandFailure {
  return new CommandFailure("refused", "USAGE_INVALID", `${what} must not embed credentials; the command did not run`, { remedy: "name the broker URL without user:password@, and pass the credential with --creds, a login or the space's own trust", selfContained: true });
}
