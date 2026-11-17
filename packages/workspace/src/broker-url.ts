import { brokerUrlCredentialProblem, brokerUrlHasUserinfo } from "./broker-display.js";
import type { Check } from "./registration-policy.js";

/** Check a broker address before it is probed, printed or persisted. The input may contain a secret,
 *  so refusals name only its source, such as `--server` or a bundle's server. WebSocket paths address
 *  proxy routes. TCP paths, queries and fragments have no broker meaning and are refused. */
export function checkServer(raw: string, what: string): Check<string> {
  const bad = (message: string): Check<never> => ({ ok: false, message: `✗ ${message}`, code: "USAGE_INVALID" });
  if (brokerUrlHasUserinfo(raw)) {
    const { message, remedy } = brokerUrlCredentialProblem(what);
    return { ok: false, message: `✗ ${message}`, code: "USAGE_INVALID", remedy };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad(`${what} is not a valid URL (expected something like nats://127.0.0.1:4222)`);
  }
  if (!["nats:", "tls:", "ws:", "wss:"].includes(u.protocol))
    return bad(`${what} scheme "${u.protocol.replace(":", "")}" is not a broker scheme - use nats://, tls://, ws:// or wss://`);
  if (u.search || u.hash)
    return bad(`${what} must be a bare broker URL - drop its ${u.search ? "query string" : "fragment"}`);
  if (u.pathname && u.pathname !== "/" && u.protocol !== "ws:" && u.protocol !== "wss:")
    return bad(`${what} must be a bare broker URL - drop its path`);
  if (!u.hostname) return bad(`${what} names no host - a broker URL needs one (e.g. nats://127.0.0.1:4222)`);
  return { ok: true, value: raw };
}

/** Required TLS from an explicit flag or a checked broker URL's scheme. The TCP client drops the
 *  scheme, so `tls://` must also become a dial option. WebSocket TLS is enforced by `wss://`. */
export function tlsIntent(server: string, tlsFlag: boolean): boolean {
  return tlsFlag || /^(tls|wss):\/\//i.test(server.trim());
}
