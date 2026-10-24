/** The listeners a controller stack's broker and manager open, read from their saved definitions:
 *  the broker's client and websocket listeners from the configuration it launches with, and the
 *  manager's console from the host its definition names. Nothing here dials or probes a port. */
import { readFileSync } from "node:fs";
import type { ServiceDefinitionSnapshot } from "./service-definitions.js";
import { STACK_ADAPTER } from "./stack-journal.js";

export interface StackListener {
  name: "client" | "websocket" | "console";
  host: string;
  /** Null for a console whose port the manager picks when it starts; that port is recorded nowhere. */
  port: number | null;
  reach: "every-interface" | "loopback" | "address";
  encrypted: boolean;
}

const reachOf = (host: string): StackListener["reach"] =>
  ["0.0.0.0", "::", "[::]"].includes(host) ? "every-interface" : /^(127\.|localhost$|::1$|\[::1\]$)/i.test(host) ? "loopback" : "address";

/** The listeners one definition's process opens. An adapter other than the broker and the manager
 *  opens none that this names. Undefined when the broker's configuration cannot be read. */
export function definitionListeners(definition: ServiceDefinitionSnapshot): StackListener[] | undefined {
  const launch = definition.record.value.launch;
  if (launch.type !== "adapter") return [];
  if (launch.adapter === STACK_ADAPTER.manager) {
    const host = typeof launch.options["console-host"] === "string" ? launch.options["console-host"] : "127.0.0.1";
    const port = launch.options["console-port"];
    return [{ name: "console", host, port: typeof port === "number" && port > 0 ? port : null, reach: reachOf(host), encrypted: false }];
  }
  if (launch.adapter !== STACK_ADAPTER.broker || typeof launch.options.config !== "string") return [];
  let text: string;
  try { text = readFileSync(launch.options.config, "utf8"); } catch { return undefined; }
  // `cotal up` renders the client listener at the top level and the websocket listener as its own
  // block, which it always serves without TLS.
  const host = /^host: (\S+)$/m.exec(text)?.[1], port = /^port: (\d+)$/m.exec(text)?.[1];
  if (host === undefined || port === undefined) return undefined;
  const listeners: StackListener[] = [{ name: "client", host, port: Number(port), reach: reachOf(host), encrypted: /^tls \{$/m.test(text) }];
  const ws = /^websocket \{\n {2}host: (\S+)\n {2}port: (\d+)\n/m.exec(text);
  if (ws) listeners.push({ name: "websocket", host: ws[1]!, port: Number(ws[2]), reach: reachOf(ws[1]!), encrypted: false });
  return listeners;
}

const LABEL: Record<StackListener["name"], string> = { client: "Broker client", websocket: "Broker websocket", console: "Manager console" };

/** One listener as a report row: what listens, at which address, how far it reaches and whether it is encrypted. */
export function listenerRow(listener: StackListener): [string, string] {
  const host = listener.host.includes(":") && !listener.host.startsWith("[") ? `[${listener.host}]` : listener.host;
  const address = listener.port === null ? `${host}, on a port the manager picks when it starts` : `${host}:${listener.port}`;
  const reach = listener.reach === "every-interface" ? "every interface" : listener.reach === "loopback" ? "loopback only" : "this address only";
  return [LABEL[listener.name], `${address} · ${reach} · ${listener.encrypted ? "TLS" : listener.name === "console" ? "plaintext HTTP" : "plaintext"}`];
}

/** The sentence a report adds when a plaintext listener reaches beyond this machine's loopback. */
export function exposedPlaintext(listeners: readonly StackListener[]): string | undefined {
  const open = listeners.filter((listener) => !listener.encrypted && listener.reach !== "loopback").map((listener) => LABEL[listener.name].toLowerCase());
  if (!open.length) return undefined;
  const names = open.length === 1 ? `The ${open[0]} listener is` : `The ${open.slice(0, -1).join(", ")} and ${open.at(-1)} listeners are`;
  return `${names} plaintext and reachable from other machines, so what crosses ${open.length === 1 ? "it" : "them"} is not encrypted.`;
}
