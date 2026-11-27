import { WEB_PIDFILE, WEB_SESSION_FILE, type LocalProcess } from "@cotal-ai/workspace";

/** The default bind is loopback. The same port is used by the browser and readiness probe. */
export const WEB_PORT = 7799;
export const WEB_HOST = "127.0.0.1";
export const WEB_URL = `http://cotal.localhost:${WEB_PORT}/`;
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);
const IPV4_MAPPED_WILDCARD = "::ffff:0:0";

export const webProcess: LocalProcess = {
  kind: "local-process",
  name: "web",
  label: "web dashboard",
  order: 40,
  pidFile: WEB_PIDFILE,
  // The readiness credential must be removed even if the killed process cannot run its handler.
  artifacts: [WEB_SESSION_FILE],
};

/** Validate and normalize one host used for both binding and browser advertisement. Wildcard binds
 *  are refused because they do not name a destination a browser or readiness probe can honestly use. */
export function normalizeWebHost(input: string | undefined): string {
  if (input === undefined) return WEB_HOST;
  if (input === "" || input !== input.trim()) throw new Error("--host must be a hostname or IP address without surrounding whitespace");
  const unbracketed = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (unbracketed.includes("[") || unbracketed.includes("]") || /[\s/?#@]/.test(unbracketed))
    throw new Error(`invalid --host ${input}`);
  let host: string;
  try {
    // Check the canonical address so alternative spellings cannot bypass the wildcard refusal.
    const ipv6 = unbracketed.includes(":");
    const parsed = new URL(`http://${ipv6 ? `[${unbracketed}]` : unbracketed}:1/`);
    if (parsed.port !== "1" || parsed.pathname !== "/" || parsed.username || parsed.password)
      throw new Error(`invalid --host ${input}`);
    host = ipv6 ? parsed.hostname.slice(1, -1) : parsed.hostname;
  } catch {
    throw new Error(`invalid --host ${input}`);
  }
  if (WILDCARD_HOSTS.has(host) || host === IPV4_MAPPED_WILDCARD)
    throw new Error(`--host ${input} is a wildcard bind, not a browser address; pass one reachable hostname or IP address`);
  return host;
}
