# 05 · Scale showcase — the galaxy

Thousands of **real** Cotal endpoints, live over NATS, rendered as a glowing GPU galaxy.

This is a showcase, not a benchmark harness: it spins up *N* genuine `CotalEndpoint`s that
actually publish multicast / DM / anycast traffic, taps the mesh with one read-only observer, and
draws the whole thing as a force-directed galaxy: agents wired to the peers they DM and clustered
around the channel hubs they post on — team lobes joined by cross-team bridges, glowing as traffic
flows, with a live messages-delivered counter.

```bash
pnpm demo --n 5000      # broker + observer + 5000 endpoints, then open the printed URL
pnpm demo --n 1000      # lighter
pnpm demo --n 12000 --workers 8
```

Open **http://127.0.0.1:7900/**. Ctrl-C tears everything down.

Measured on an 18-core / 48 GB Mac: **5,000 endpoints at 120 fps**, browser ≈ 0.6 GB, and the whole
mesh (broker + 4 swarm workers + observer) ≈ 1.2 GB. The protocol is cheap; the only thing that has
to be careful is the renderer.

## Why it's built this way

The naive version of this melts. Pointing the stock `cotal web` graph at just **500** live nodes
drove its Chrome renderer to **50 GB** and ~0.1 fps — because it spawns an animation object per
message (with channel fan-out) and the per-frame draw cost grows with traffic, so under load it
produces draw work faster than it can retire it. Unbounded by construction.

This showcase fixes that with two rules:

1. **Bounded feed (`src/observe.ts`).** The observer folds every message into an in-memory graph
   model and emits a *fixed-rate* (~15 Hz) batched delta + a small "what lit up this frame" set.
   The bytes sent to the browser scale with the **size of the graph**, never the message rate. The
   structure is two overlaid graphs: the **DM peer mesh** (each agent DMs a stable set of
   collaborators → agent↔agent edges, the cross-team bridges) and **channel hubs** (each agent
   posts to its team channel → a hub node every team lobe gathers around). Anycast stays
   *transient*: it pulses its sender but adds no edge, so the layout settles and stays stable. A
   running counter tracks total messages seen on the wire.
2. **Bounded renderer (`web/galaxy.js`).** [cosmos.gl](https://github.com/cosmosgl/graph) runs the
   force layout and rendering on the **GPU** with fixed, pre-allocated buffers. Pulses aren't
   objects — an `act` frame just sets `heat = 1` on a few indices; the render loop decays heat and
   uploads one node-color + one link-color buffer per frame. Per-frame work scales with what's
   on screen, not with traffic.

Net: work proportional to *what's visible*, not to *how much is happening*.

## Pieces

| File | Role |
|---|---|
| `src/showcase.ts` | One command: bare `nats-server` (JetStream for presence KV only — **no message streams, nothing persisted**), the observer, and the swarm. |
| `src/swarm.ts` | The load generator: *N* live-only endpoints (`channels:[]` pure publishers), sharded across `cluster` workers, each wired to a stable peer set (in-team peers + a cross-team bridge) it DMs and a team channel it posts to — that's what forms the lobe-and-bridge graph. |
| `src/observe.ts` | The scale-safe observer + SSE server (the bounded feed above). Runnable alone: `pnpm serve --space <s> --server <url>`. |
| `web/galaxy.html` + `web/galaxy.js` | The cosmos.gl GPU galaxy (loaded from a CDN — no bundler). |

Live-only delivery throughout: messages are pure core-NATS pub/sub, so there's no JetStream
consumer-cardinality limit and nothing touches disk.
