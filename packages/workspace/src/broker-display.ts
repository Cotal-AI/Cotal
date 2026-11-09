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

export { brokerUrlHasUserinfo } from "@cotal-ai/core";

/** Why a broker URL with a user name or password in it is refused, and the step that replaces it. The
 *  NATS client keeps only a broker URL's host and port, so those credentials would be dropped in
 *  silence. `what` names where the URL came from, such as `--server`, `COTAL_SERVER` or a bundle's
 *  server; the value is never repeated. Every command's refusal of one takes its words from here. */
export function brokerUrlCredentialProblem(what: string): { message: string; remedy: string } {
  return { message: `${what} must not embed credentials`, remedy: "name the broker URL without user:password@, and pass the credential with --creds, a login or the space's own trust" };
}

/** Why a broker URL is not one this client can dial as written, or undefined when it is. The NATS
 *  client keeps only the host and port, so a missing scheme, any other scheme, a path, a query or a
 *  fragment would be dropped and the command would connect in plaintext to whatever that host and port
 *  answer. A `ws://` or `wss://` URL keeps its path, because that path is the websocket route. A list
 *  is one verdict per entry. The value is never repeated: the commonest malformed URL is a half-typed
 *  credential. */
export function brokerUrlShapeProblem(raw: string, what: string): { message: string; remedy: string } | undefined {
  for (const entry of raw.split(",")) {
    const input = entry.trim();
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return { message: `${what} is not a valid URL`, remedy: "pass a broker URL such as nats://127.0.0.1:4222" };
    }
    if (!["nats:", "tls:", "ws:", "wss:"].includes(url.protocol))
      return { message: `${what} scheme "${url.protocol.replace(":", "")}" is not a broker scheme`, remedy: "use nats://, tls://, ws:// or wss://" };
    if (url.search || url.hash)
      return { message: `${what} must be a bare broker URL`, remedy: `drop its ${url.search ? "query string" : "fragment"}` };
    if (url.pathname && url.pathname !== "/" && url.protocol !== "ws:" && url.protocol !== "wss:")
      return { message: `${what} must be a bare broker URL`, remedy: "drop its path" };
    if (!url.hostname)
      return { message: `${what} names no host`, remedy: "name the broker's host, for example nats://127.0.0.1:4222" };
  }
  return undefined;
}

/** {@link brokerUrlCredentialProblem} as the refusal of a command before it runs. */
export function brokerUrlCredentialRefusal(what: string): CommandFailure {
  const { message, remedy } = brokerUrlCredentialProblem(what);
  return new CommandFailure("refused", "USAGE_INVALID", `${message}; the command did not run`, { remedy, selfContained: true });
}

/** {@link brokerUrlShapeProblem} as the refusal of a command before it dials, or undefined when the
 *  URL is one this client dials as written. */
export function brokerUrlShapeRefusal(raw: string, what: string): CommandFailure | undefined {
  const problem = brokerUrlShapeProblem(raw, what);
  return problem === undefined ? undefined : new CommandFailure("refused", "USAGE_INVALID", `${problem.message}; the command did not run`, { remedy: problem.remedy, selfContained: true });
}
