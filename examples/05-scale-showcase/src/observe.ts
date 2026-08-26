import { parseArgs } from "node:util";
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CotalEndpoint,
  deliveryOf,
  parseSubject,
  spaceWildcard,
  type CotalMessage,
  type PresenceEvent,
} from "@cotal-ai/core";

/**
 * The scale-safe observer for the galaxy.
 *
 * A read-only endpoint taps the whole space and folds every message into an in-memory graph
 * model (agents, channel/role hubs, the edges between them). Crucially it NEVER emits one SSE
 * event per message: it batches all structural deltas + a bounded "what lit up this frame"
 * activity set and flushes them on a fixed ~15Hz tick. So the bytes pushed to the browser scale
 * with the size of the GRAPH, not with the message rate — which is what makes 5k endpoints at
 * thousands of msgs/sec survivable (the old per-message comet feed did not, and ate 50GB).
 */

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..", "web");

const TICK_MS = 66; // ~15Hz flush — the only cadence the browser ever sees

type NodeKind = "agent" | "channel" | "role";
interface GNode { id: string; kind: NodeKind; label: string; role?: string }

interface Model {
  nodes: GNode[];
  nodeIndex: Map<string, number>;
  links: [number, number][];
  linkIndex: Map<string, number>;
  status: Map<string, string>;
}

export interface ObserveOptions { server: string; space: string; port: number; creds?: string; monUrl?: string }

export async function observe(opts: ObserveOptions): Promise<void> {
  const m: Model = { nodes: [], nodeIndex: new Map(), links: [], linkIndex: new Map(), status: new Map() };

  // batched deltas, drained every tick
  const pendNodes: number[] = [];
  const pendLinks: number[] = [];
  const pendStatus = new Map<string, string>();
  const actNodes = new Set<number>();
  const actLinks = new Set<number>();
  let msgs = 0; // total real messages seen on the wire (chat/DM/anycast), the "delivered" counter
  let mUni = 0, mMulti = 0, mAny = 0; // by delivery mode: unicast DM / multicast channel / anycast role
  let latSum = 0, latN = 0; // rolling avg delivery latency: now − msg.ts (publish → observer receipt)
  let bCpu = 0, bMem = 0, bConn = 0; // broker stats from NATS /varz monitoring

  const short = (id: string) => (id.length > 8 ? id.slice(0, 6) + "…" : id);

  function ensureNode(id: string, kind: NodeKind, label: string, role?: string): number {
    let idx = m.nodeIndex.get(id);
    if (idx === undefined) {
      idx = m.nodes.length;
      m.nodes.push({ id, kind, label, role });
      m.nodeIndex.set(id, idx);
      pendNodes.push(idx);
    } else if (role && !m.nodes[idx].role) {
      m.nodes[idx].role = role; // late-learned role from a roster/message
    }
    return idx;
  }
  function ensureLink(a: number, b: number): number {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let idx = m.linkIndex.get(key);
    if (idx === undefined) {
      idx = m.links.length;
      m.links.push([a, b]);
      m.linkIndex.set(key, idx);
      pendLinks.push(idx);
    }
    return idx;
  }
  function setStatus(id: string, status: string): void {
    if (m.status.get(id) === status) return;
    m.status.set(id, status);
    pendStatus.set(id, status);
  }

  // ── the mesh observer (invisible to peers: no presence, no inbox) ──
  const ep = new CotalEndpoint({
    space: opts.space,
    servers: opts.server,
    creds: opts.creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: { name: "galaxy-observer", kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();

  // presence → nodes + statuses (so quiet agents still appear and color by status). Handle ONLY the
  // changed peer per event — re-scanning the whole roster on every heartbeat is O(N) per beat and
  // pegs the observer at scale (5k agents × heartbeats = millions of iterations/sec).
  ep.on("presence", (e: PresenceEvent) => {
    const p = e?.presence; if (!p?.card || p.card.kind === "endpoint") return;
    const idx = ensureNode(p.card.id, "agent", p.card.name || short(p.card.id), p.card.role);
    actNodes.add(idx); // a heartbeat is a faint sign of life
    setStatus(p.card.id, p.status);
  });

  // every comm → fold into the model + mark what lit up (no per-message emit)
  ep.tap((subject: string, msg: CotalMessage | undefined) => {
    const mode = deliveryOf(subject);
    if (!mode || !msg) return;
    const parsed = parseSubject(subject);
    if (!parsed) return;
    msgs++;
    if (mode === "unicast") mUni++; else if (mode === "chat") mMulti++; else mAny++;
    if (msg.ts) { latSum += Math.max(0, Date.now() - msg.ts); latN++; }
    const sender = parsed.sender;
    const from = ensureNode(sender, "agent", msg.from?.name || short(sender), msg.from?.role);
    actNodes.add(from);

    if (mode === "unicast") {
      // a DM is a real agent↔agent communication edge — peer-to-peer structure
      const to = ensureNode(parsed.rest, "agent", short(parsed.rest));
      actNodes.add(to);
      actLinks.add(ensureLink(from, to));
    } else if (mode === "chat") {
      // a channel post wires the sender to a shared channel HUB — teams gather into lobes around these
      const ch = ensureNode(`#${parsed.rest}`, "channel", `#${parsed.rest}`);
      actNodes.add(ch);
      actLinks.add(ensureLink(from, ch));
    }
    // anycast stays ambient: the sender already pulsed above, no node/edge.
  }, { subject: spaceWildcard(opts.space) });

  // ── SSE fan-out, fixed cadence ──
  const clients = new Set<ServerResponse>();
  const send = (res: ServerResponse, event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event: string, data: unknown) => { for (const res of clients) send(res, event, data); };

  setInterval(() => {
    if (pendNodes.length) { broadcast("nodes", pendNodes.map((i) => m.nodes[i])); pendNodes.length = 0; }
    if (pendLinks.length) { broadcast("links", pendLinks.map((i) => m.links[i])); pendLinks.length = 0; }
    if (pendStatus.size) { broadcast("status", Object.fromEntries(pendStatus)); pendStatus.clear(); }
    if (actNodes.size || actLinks.size) {
      broadcast("act", { p: [...actNodes], l: [...actLinks] });
      actNodes.clear(); actLinks.clear();
    }
  }, TICK_MS);

  // broker cpu/mem/conns from NATS' native HTTP monitoring (/varz) — polled on its own cadence
  const pollVarz = async (): Promise<void> => {
    if (!opts.monUrl) return;
    try {
      const r = await fetch(`${opts.monUrl}/varz`);
      if (!r.ok) return;
      const v = await r.json() as { cpu?: number; mem?: number; connections?: number };
      bCpu = Math.round(v.cpu ?? 0); bMem = Math.round((v.mem ?? 0) / 1e6); bConn = v.connections ?? 0;
    } catch { /* monitoring not up yet */ }
  };
  if (opts.monUrl) { void pollVarz(); setInterval(() => void pollVarz(), 1000); }

  // the perf/meta feed (counter + per-mode rates + avg latency + broker stats), on its own slow cadence
  let lastMsgs = 0, lUni = 0, lMulti = 0, lAny = 0, lastT = Date.now();
  const meta = () => {
    const now = Date.now(), dt = (now - lastT) / 1000;
    const per = (cur: number, last: number) => (dt > 0 ? Math.round((cur - last) / dt) : 0);
    const rate = per(msgs, lastMsgs), dm = per(mUni, lUni), chan = per(mMulti, lMulti), any = per(mAny, lAny);
    const lat = latN ? Math.round((latSum / latN) * 100) / 100 : 0;
    lastMsgs = msgs; lUni = mUni; lMulti = mMulti; lAny = mAny; lastT = now; latSum = 0; latN = 0;
    return { msgs, rate, dm, chan, any, lat, cpu: bCpu, mem: bMem, conns: bConn };
  };
  setInterval(() => broadcast("meta", meta()), 500);

  // ── http: static page + the SSE feed + a stats probe ──
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/feed") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      // full snapshot first; the client dedups by id so an overlapping tick delta is harmless
      send(res, "snapshot", { nodes: m.nodes, links: m.links, status: Object.fromEntries(m.status) });
      send(res, "meta", { msgs, rate: 0, dm: 0, chan: 0, any: 0, lat: 0, cpu: bCpu, mem: bMem, conns: bConn });
      req.on("close", () => clients.delete(res));
      return;
    }
    if (path === "/api/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ space: opts.space, nodes: m.nodes.length, links: m.links.length, clients: clients.size }));
      return;
    }
    const file = path === "/" ? "galaxy.html" : path.slice(1);
    try {
      const body = readFileSync(join(WEB, file)); // read FIRST — a miss throws before any header is written
      const type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((ready) => server.listen(opts.port, "127.0.0.1", ready));
  console.log(`galaxy observer → http://127.0.0.1:${opts.port}/  (space ${opts.space})`);

  const stop = async () => { for (const r of clients) r.end(); server.close(); await ep.stop().catch(() => {}); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}

// allow running standalone: `tsx src/observe.ts --space bench --server nats://127.0.0.1:4711 --port 7900`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: {
    server: { type: "string" }, space: { type: "string" }, port: { type: "string" }, creds: { type: "string" },
  } });
  void observe({
    server: values.server ?? "nats://127.0.0.1:4711",
    space: values.space ?? "bench",
    port: values.port ? Number(values.port) : 7900,
    creds: values.creds ? readFileSync(values.creds, "utf8") : undefined,
  });
}
