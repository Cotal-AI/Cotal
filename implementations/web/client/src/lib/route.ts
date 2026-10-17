// The dashboard's routes live in the URL hash, so a view can be linked, reloaded and stepped through
// with the back button. This module only maps text to a route and back: it reads no location itself.
import { eventChannelAgent } from "./session.js";

export type Route =
  | { view: "channel"; channel: string }
  | { view: "activity" }
  | { view: "dm"; peer: string; with?: string }
  | { view: "agents"; group: "status" | "host" }
  | { view: "topology" }
  | { view: "needs" }
  | { view: "agent"; id: string; at?: string };

/** Where a blank or unrecognised address lands. */
export const DEFAULT_ROUTE: Route = { view: "activity" };

const TOPOLOGY: Route = { view: "topology" };

/** A hash segment as text, or undefined when it is not valid percent-encoding. */
function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The route a hash names, or undefined when it names none. */
function fromHash(hash: string): Route | undefined {
  const parts = hash.replace(/^#/, "").split("/");
  if (parts[0] !== "") return undefined; // every route hash starts "#/"
  const [, view, a, b, ...extra] = parts;
  if (extra.length > 0) return undefined;
  switch (view) {
    case "channel": {
      if (!a || b !== undefined) return undefined;
      const channel = decode(a);
      if (!channel) return undefined;
      // An agent's event channel opens its session: its frames reach the page only through a watch.
      const agent = eventChannelAgent(channel);
      return agent ? { view: "agent", id: agent } : { view: "channel", channel };
    }
    case "agent": {
      if (!a) return undefined;
      const id = decode(a);
      if (!id) return undefined;
      if (b === undefined) return { view: "agent", id };
      const at = b === "" ? undefined : decode(b);
      return at ? { view: "agent", id, at } : undefined;
    }
    case "dm": {
      if (!a) return undefined;
      const peer = decode(a);
      if (!peer) return undefined;
      if (b === undefined) return { view: "dm", peer };
      const other = b === "" ? undefined : decode(b);
      return other ? { view: "dm", peer, with: other } : undefined;
    }
    case "agents":
      if (b !== undefined) return undefined;
      if (a === undefined || a === "status") return { view: "agents", group: "status" };
      return a === "host" ? { view: "agents", group: "host" } : undefined;
    case "activity":
    case "topology":
    case "needs":
      return a === undefined ? { view: view } : undefined;
    default:
      return undefined;
  }
}

/** The route for a location. `hash` is `location.hash` and `path` is `location.pathname`. A hash that
 *  names no route falls back to the path: the old graph page lived at /graph, which is topology now.
 *  Anything else, including an undecodable channel name, is the default route and never an error. */
export function parseRoute(hash: string, path: string): Route {
  return fromHash(hash) ?? (path === "/graph" ? TOPOLOGY : DEFAULT_ROUTE);
}

/** The hash for a route. `parseRoute(formatRoute(r), "/")` gives `r` back, except for a channel route
 *  that names an agent's event channel, which reads back as that agent's session. */
export function formatRoute(r: Route): string {
  switch (r.view) {
    case "channel":
      return `#/channel/${encodeURIComponent(r.channel)}`;
    case "dm":
      return `#/dm/${encodeURIComponent(r.peer)}${r.with === undefined ? "" : `/${encodeURIComponent(r.with)}`}`;
    case "agents":
      return r.group === "status" ? "#/agents" : `#/agents/${r.group}`;
    case "agent":
      return `#/agent/${encodeURIComponent(r.id)}${r.at === undefined ? "" : `/${encodeURIComponent(r.at)}`}`;
    default:
      return `#/${r.view}`;
  }
}
