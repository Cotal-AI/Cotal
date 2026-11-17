// The dashboard's routes live in the URL hash, so a view can be linked, reloaded and stepped through
// with the back button. This module only maps text to a route and back: it reads no location itself.
import { eventChannelAgent } from "./session.js";

/** The tabs of an agent's page. */
export type AgentTab = "work" | "messages" | "profile";
const AGENT_TABS: readonly string[] = ["work", "messages", "profile"] satisfies AgentTab[];
const isAgentTab = (s: string): s is AgentTab => AGENT_TABS.includes(s);

export type Route =
  | { view: "channel"; channel: string }
  | { view: "activity" }
  | { view: "dm"; peer: string; with?: string }
  | { view: "agents"; group: "status" | "host" }
  | { view: "topology" }
  | { view: "needs" }
  | { view: "agent"; id: string; tab: AgentTab; at?: string };

/** Where a blank or unrecognised address lands. */
export const DEFAULT_ROUTE: Route = { view: "activity" };

const TOPOLOGY: Route = { view: "topology" };

/** An agent's roster id, `<owner>.<actor>`, each token of [A-Za-z0-9_], as the server's agent routes
 *  require. Restated because the client imports nothing from the server or core. */
const AGENT_ID = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

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
  const [, view, a, b, c, ...extra] = parts;
  // Only an agent's page has a third segment: the message its Work tab opens at.
  if (extra.length > 0 || (c !== undefined && view !== "agent")) return undefined;
  switch (view) {
    case "channel": {
      if (!a || b !== undefined) return undefined;
      const channel = decode(a);
      if (!channel) return undefined;
      // An agent's event channel opens its page: its frames reach the page only through a watch.
      const agent = eventChannelAgent(channel);
      return agent ? { view: "agent", id: agent, tab: "work" } : { view: "channel", channel };
    }
    case "agent": {
      if (!a) return undefined;
      const id = decode(a);
      if (!id || !AGENT_ID.test(id)) return undefined;
      if (b === undefined) return { view: "agent", id, tab: "work" };
      if (c === undefined) {
        if (isAgentTab(b)) return { view: "agent", id, tab: b };
        // The old link, `#/agent/<id>/<message id>`, opens Work at that message.
        const old = b === "" ? undefined : decode(b);
        return old ? { view: "agent", id, tab: "work", at: old } : undefined;
      }
      if (b !== "work") return undefined;
      const at = c === "" ? undefined : decode(c);
      return at ? { view: "agent", id, tab: "work", at } : undefined;
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
 *  that names an agent's event channel, which reads back as that agent's page. An agent's page is
 *  `#/agent/<id>` on Work, `#/agent/<id>/<tab>` on another tab, and `#/agent/<id>/work/<message id>`
 *  at a message; a route with `at` is always on Work. */
export function formatRoute(r: Route): string {
  switch (r.view) {
    case "channel":
      return `#/channel/${encodeURIComponent(r.channel)}`;
    case "dm":
      return `#/dm/${encodeURIComponent(r.peer)}${r.with === undefined ? "" : `/${encodeURIComponent(r.with)}`}`;
    case "agents":
      return r.group === "status" ? "#/agents" : `#/agents/${r.group}`;
    case "agent": {
      const page = `#/agent/${encodeURIComponent(r.id)}`;
      if (r.at !== undefined) return `${page}/work/${encodeURIComponent(r.at)}`;
      return r.tab === "work" ? page : `${page}/${r.tab}`;
    }
    default:
      return `#/${r.view}`;
  }
}
