import { readFileSync } from "node:fs";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  type ParsedArgs,
  type PresenceStatus,
} from "@cotal-ai/core";
import { resolveSpace } from "../lib/status.js";
import { c } from "../ui.js";

/**
 * `cotal demo` — spin up a handful of mock agents and replay a scripted trace that exercises
 * EVERY protocol-view feature: all four presence states, all three delivery modes (multicast to
 * several channels incl. mentions, peer DMs, an unclaimed anycast), a coalesced burst, and a
 * late-joining agent. Point `cotal console` / `cotal web` at the same space to watch it.
 *
 *   pnpm cotal up --open
 *   pnpm cotal demo --space demo
 *   pnpm cotal console --space demo      # in a real terminal
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Act =
  | { t: "status"; who: string; status: PresenceStatus; activity?: string }
  | { t: "chat"; who: string; channel: string; text: string; mentions?: string[] }
  | { t: "dm"; who: string; to: string; text: string }
  | { t: "burst"; who: string; to: string[]; text: string } // same text, many targets → coalesces
  | { t: "anycast"; who: string; service: string; text: string }
  | { t: "join"; who: string; role: string };

// The core cast (started up front); `scout` joins mid-trace to show a late join.
const AGENTS: { name: string; role: string }[] = [
  { name: "alice", role: "planner" },
  { name: "bob", role: "builder" },
  { name: "dave", role: "builder" },
  { name: "maya", role: "researcher" },
  { name: "linus", role: "reviewer" },
];

const SCRIPT: Act[] = [
  { t: "status", who: "alice", status: "working", activity: "drafting the auth outline" },
  { t: "status", who: "bob", status: "working", activity: "writing tests · channels.ts" },
  { t: "chat", who: "dave", channel: "general", text: "anyone else hit the flaky CI test on channels.ts?" },
  { t: "status", who: "dave", status: "working", activity: "refactoring endpoint.ts" },
  { t: "chat", who: "bob", channel: "team.backend", text: "pushed channels.ts tests — 12 green ✓" },
  { t: "chat", who: "maya", channel: "planning", text: "NATS v3 splits transports cleanly — notes in #planning" },
  { t: "dm", who: "alice", to: "bob", text: "can you take the API-key wiring while I'm blocked?" },
  { t: "dm", who: "bob", to: "alice", text: "on it — grabbing the OPENAI_API_KEY wiring now" },
  { t: "status", who: "alice", status: "waiting", activity: "blocked — needs OPENAI_API_KEY" },
  { t: "join", who: "scout", role: "observer" },
  { t: "chat", who: "scout", channel: "general", text: "scout here — watching #team.>" },
  { t: "anycast", who: "alice", service: "reviewer", text: "review needed on PR #51 (channels hierarchy)" },
  { t: "status", who: "linus", status: "working", activity: "reviewing PR #42 · auth guards" },
  { t: "chat", who: "linus", channel: "team.review", text: "left 2 comments on PR #42 — small nits" },
  { t: "dm", who: "alice", to: "dave", text: "want me to stub the key so you can keep planning?" },
  { t: "dm", who: "dave", to: "alice", text: "yes — a no-op stub is perfect for now" },
  { t: "burst", who: "linus", to: ["bob", "dave", "maya"], text: "ship it 🚀" },
  { t: "chat", who: "bob", channel: "general", text: "@alice key wired — you're unblocked", mentions: ["alice"] },
  { t: "status", who: "alice", status: "working", activity: "back on the auth module" },
  { t: "status", who: "maya", status: "offline" },
  { t: "chat", who: "dave", channel: "incidents", text: "CI flake traced to a race in channels.ts — fix incoming" },
  { t: "status", who: "maya", status: "idle", activity: "reading the NATS v3 notes" },
  { t: "dm", who: "maya", to: "linus", text: "sent the NATS v3 notes your way" },
  { t: "chat", who: "linus", channel: "team.frontend", text: "frontend review queue is clear ✓" },
];

export async function demo(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; server?: string; interval?: string; once?: boolean; creds?: string };
  const space = values.space ?? resolveSpace(process.cwd());
  const server = values.server ?? DEFAULT_SERVER;
  const interval = values.interval ? Number(values.interval) : 1200;
  const creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm cotal up`));
    process.exit(1);
  }

  const eps = new Map<string, CotalEndpoint>();
  // consume:true so each agent's inbox/streams exist — otherwise peer DMs (unicast) have no
  // backing stream. registerPresence:true puts them in the roster; watchPresence:false (the
  // console is the watcher). channels:["general"] just ensures the chat stream is bound; we
  // publish to every channel explicitly regardless of subscription.
  const make = async (name: string, role: string): Promise<void> => {
    const ep = new CotalEndpoint({
      space,
      servers: server,
      creds,
      card: { name, role, kind: "agent" },
      channels: ["general"],
      consume: true,
      registerPresence: true,
      watchPresence: false,
    });
    ep.on("error", () => {});
    await ep.start();
    eps.set(name, ep);
  };

  for (const a of AGENTS) await make(a.name, a.role);

  console.log(`${c.bold("cotal demo")} — ${eps.size} agents live in space ${c.bold(space)}`);
  console.log(c.dim(`  ${[...eps.keys()].join(", ")} (+ scout joins mid-trace)`));
  console.log(`  watch it: ${c.cyan(`cotal console --space ${space}`)}  ${c.dim("or")}  ${c.cyan(`cotal web --space ${space}`)}`);
  console.log(c.dim(`  ${values.once ? "single pass" : "looping"} · ~${interval}ms/step · Ctrl-C to stop\n`));

  const idOf = (n: string) => eps.get(n)?.card.id;
  const run = async (a: Act): Promise<void> => {
    const ep = "who" in a ? eps.get(a.who) : undefined;
    switch (a.t) {
      case "status":
        if (!ep) return;
        if (a.activity !== undefined) await ep.setActivity(a.activity);
        await ep.setStatus(a.status);
        return;
      case "chat":
        await ep?.multicast(a.text, { channel: a.channel, mentions: a.mentions });
        return;
      case "dm": {
        const tid = idOf(a.to);
        if (ep && tid) await ep.unicast(tid, a.text);
        return;
      }
      case "burst":
        for (const to of a.to) {
          const tid = idOf(to);
          if (ep && tid) await ep.unicast(tid, a.text); // back-to-back → inside the coalesce window
        }
        return;
      case "anycast":
        await ep?.anycast(a.service, a.text);
        return;
      case "join":
        if (!eps.has(a.who)) await make(a.who, a.role);
        return;
    }
  };

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(c.dim("\nstopping — agents going offline…"));
    for (const ep of eps.values()) await ep.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  do {
    for (const a of SCRIPT) {
      if (stopping) break;
      try {
        await run(a);
      } catch (e) {
        console.error(c.dim(`  (skipped ${a.t} from ${"who" in a ? a.who : "?"}: ${(e as Error).message})`));
      }
      await sleep(interval);
    }
    if (!values.once && !stopping) await sleep(interval * 2);
  } while (!values.once && !stopping);

  if (values.once) await shutdown();
}
