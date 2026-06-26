import { parseArgs } from "node:util";
import cluster from "node:cluster";
import { CotalEndpoint } from "@cotal-ai/core";

/**
 * The load generator: N real Cotal endpoints, live-only (no persistence), all talking.
 *
 * The graph is the REAL peer graph — agents connect to other AGENTS they actually message, not to
 * abstract channel hubs. Each agent has a stable set of collaborators (a handful inside its team +
 * a couple cross-team), and it DMs them; the observer turns those DMs into agent↔agent edges. That
 * yields a connected small-world network with team communities and bridges — a graph agents could
 * really have — instead of disconnected hub-and-spoke stars.
 *
 * Endpoints use deterministic ids (`a<globalIndex>`) so any worker can address any peer by id even
 * when sharded across processes (unicast just needs the target id; it's fire-and-forget on the wire).
 */

const ROLES = ["planner", "builder", "reviewer", "researcher", "ops"];
const TEAM_SIZE = 100;   // agents per team community
const IN_PEERS = 5;      // collaborators inside the team
const CROSS = 1;         // structured cross-team bridge on each bridge agent (target in another team)
const BRIDGE_EVERY = 3;  // ~1 in 3 agents bridges to another team (~1.6k bridges) — interwoven, not islands
const RANDOM_EVERY = 15; // ~1 in 15 also gets a FULLY-random long-range link (no team structure) — the
                         // long arcs that make a small-world net read organic rather than engineered

const rng = (seed: number) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1597334677) + 1) >>> 0; return s / 4294967296; }; };

/** Stable peer set for agent gi (by global id), mostly in-team + a cross-team bridge. */
function peersFor(gi: number, total: number): string[] {
  const team = Math.floor(gi / TEAM_SIZE);
  const start = team * TEAM_SIZE, end = Math.min(total, start + TEAM_SIZE);
  const r = rng(gi + 1), peers = new Set<string>();
  for (let k = 0; k < IN_PEERS && end - start > 1; k++) {
    const p = start + Math.floor(r() * (end - start));
    if (p !== gi) peers.add(`a${p}`);
  }
  const bridges = gi % BRIDGE_EVERY === 0 ? CROSS : 0;
  for (let k = 0; k < bridges; k++) {
    let p = Math.floor(r() * total);
    if (Math.floor(p / TEAM_SIZE) === team) p = (p + TEAM_SIZE) % total;
    if (p !== gi) peers.add(`a${p}`);
  }
  if (gi % RANDOM_EVERY === 0) { const p = Math.floor(r() * total); if (p !== gi) peers.add(`a${p}`); } // random long-range arc
  return [...peers];
}

export interface SwarmOptions {
  server: string; space: string; n: number; base: number; total: number; rate: number; heartbeatMs: number; conc: number;
}

export async function runSwarm(o: SwarmOptions): Promise<void> {
  const eps: { ep: CotalEndpoint; peers: string[]; team: number }[] = [];
  let connected = 0, failed = 0, sent = 0, errSamples = 0;

  const make = async (gi: number): Promise<void> => {
    const peers = peersFor(gi, o.total);
    const team = Math.floor(gi / TEAM_SIZE);
    let lastErr = "";
    // Retry transient connect failures: under a large connect burst the broker's accept backlog
    // (macOS somaxconn defaults to 128) drops connections; a couple of backed-off retries recover them.
    for (let attempt = 0; attempt < 6; attempt++) {
      const ep = new CotalEndpoint({
        space: o.space, servers: o.server,
        card: { id: `a${gi}`, name: `bot-${gi}`, role: ROLES[gi % ROLES.length], kind: "agent" },
        channels: [], consume: false, registerPresence: true, watchPresence: false,
        heartbeatMs: o.heartbeatMs,
      });
      ep.on("error", () => {});
      try {
        await ep.start();
        for (const p of peers) ep.unicast(p, "hi").catch(() => {}); // seed each peer edge (fire-and-forget)
        ep.multicast("hello", { channel: `team${team}` }).catch(() => {}); // seed this agent's channel-hub edge
        eps.push({ ep, peers, team });
        connected++;
        return;
      } catch (e) {
        lastErr = (e as Error)?.message ?? String(e);
        await ep.stop().catch(() => {});
        if (attempt < 5) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    failed++;
    if (errSamples < 6) { errSamples++; console.error(`${tag}connect FAILED (gi=${gi}) after retries: ${lastErr}`); }
  };

  const tag = cluster.worker ? `w${cluster.worker.id} ` : "";
  const t0 = Date.now();
  for (let i = 0; i < o.n; i += o.conc) {
    await Promise.all(Array.from({ length: Math.min(o.conc, o.n - i) }, (_, k) => make(o.base + i + k)));
  }
  console.log(`${tag}connected ${connected}/${o.n} (${failed} failed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // one scheduler emits a slice of the target rate each tick — not N timers
  const tickMs = 100;
  const perTick = Math.max(1, Math.round(o.n * o.rate * (tickMs / 1000)));
  const pick = () => eps[(Math.random() * eps.length) | 0];
  setInterval(() => {
    for (let k = 0; k < perTick && eps.length; k++) {
      const me = pick(); if (!me) continue;
      const roll = Math.random();
      if (roll < 0.7 && me.peers.length) me.ep.unicast(me.peers[(Math.random() * me.peers.length) | 0], "ping").catch(() => {}); // pulse a real edge
      else if (roll < 0.9) me.ep.multicast(`m${sent}`, { channel: `team${me.team}` }).catch(() => {}); // ambient channel chatter
      else me.ep.anycast(ROLES[(Math.random() * ROLES.length) | 0], "task").catch(() => {});
      sent++;
    }
  }, tickMs);
  setInterval(() => console.log(`${tag}live=${eps.length} sent=${sent} rss=${(process.memoryUsage().rss / 1e9).toFixed(2)}GB`), 5000);

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

/** Run N endpoints, sharded across `workers` child processes (cluster). With workers=1, in-process. */
export async function startSwarm(opts: Omit<SwarmOptions, "n" | "base"> & { total: number; workers: number }): Promise<void> {
  const { total, workers, ...rest } = opts;
  if (workers > 1 && cluster.isPrimary) {
    const per = Math.ceil(total / workers);
    // Don't override argv — workers inherit the full flags and read their slice from COTAL_SHARD.
    for (let w = 0; w < workers; w++) {
      const base = w * per, count = Math.min(per, total - base);
      if (count > 0) cluster.fork({ COTAL_SHARD: JSON.stringify({ base, count }) });
    }
    return;
  }
  const shard = process.env.COTAL_SHARD ? JSON.parse(process.env.COTAL_SHARD) as { base: number; count: number } : { base: 0, count: total };
  await runSwarm({ ...rest, total, n: shard.count, base: shard.base });
}

if (import.meta.url === `file://${process.argv[1]}` || process.env.COTAL_SHARD) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: {
    server: { type: "string" }, space: { type: "string" }, n: { type: "string" },
    workers: { type: "string" }, rate: { type: "string" }, heartbeat: { type: "string" }, conc: { type: "string" },
  } });
  void startSwarm({
    server: values.server ?? "nats://127.0.0.1:4711",
    space: values.space ?? "bench",
    total: values.n ? Number(values.n) : 1000,
    workers: values.workers ? Number(values.workers) : 1,
    rate: values.rate ? Number(values.rate) : 0.2,
    heartbeatMs: values.heartbeat ? Number(values.heartbeat) : 4000,
    conc: values.conc ? Number(values.conc) : 150,
  });
}
