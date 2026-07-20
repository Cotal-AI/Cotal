# MeshView: one model, many surfaces

> **Reference**: describes the TypeScript reference implementation's observer surfaces (`MeshView`), not the wire contract. · **For:** integrators building a watch surface · **Wire contract:** [SPEC](../SPEC.md)

`MeshView` is the shared model behind every surface that lets a human *watch* a live mesh: the
terminal [console](watch-a-mesh.md), the plain stream, and the web dashboard. It defines what
those surfaces show and keeps them from drifting apart.

**This is a reference-implementation API, not the wire.** The wire is the source of truth; every
field below is a *rendering* derived from it. A different client is free to derive its own model
or none at all; nothing here is normative. What *is* normative (subjects, delivery modes,
presence) lives in the [SPEC](../SPEC.md).

## The observer

Every surface is built on one **read-only observer**: a `CotalEndpoint` started with
`consume: false, registerPresence: false, watchPresence: true`, invisible to peers, binding no
durables, reading the space through the live tap plus history and presence-watch. No surface opens
its own NATS connection, and none re-implements the wire semantics.

## The model: `MeshView` (`@cotal-ai/cli`)

One class (`implementations/cli/src/view/mesh-view.ts`) consumes that observer and emits a
normalized, render-agnostic model: no ANSI, no React, no HTML, no colour, pure data. It owns the
endpoint lifecycle (`start → tap → stop`) and batches every source (roster events, the tap, burst
flushes, channel polls, the rate/age heartbeat) into one snapshot per ~75 ms tick.

```ts
new MeshView(ep, { window?, tapSubject? })
  .on("entry",    (e: FeedEntry) => …)     // one classified+coalesced row, as it lands (stream)
  .on("presence", (ev) => …)               // a forwarded presence change (join / update / offline)
  .on("change",   (s: MeshSnapshot) => …)  // a batched snapshot (~75 ms) for dashboards
await view.start();
view.snapshot();                           // pull the current model on demand
await view.stop();
```

`window` caps the feed (default 300 entries). `tapSubject` chooses visibility: `chatWildcard(space)`
narrows the tap to multicast (auth: DMs and anycast stay confidential); `spaceWildcard(space)` or
omitting it taps the whole space (the god-view).

```ts
interface FeedEntry {           // one feed row
  id: string;
  ts: number;
  from: EndpointRef;
  delivery: "multicast" | "unicast" | "anycast";
  channel?: string;             // multicast target
  toService?: string;           // anycast target
  toNames?: string[];           // unicast: targets resolved off the roster
  count?: number;               // unicast: burst multiplicity for a coalesced entry
  text: string;                 // parts joined, plain; the surface colours it
}

interface MeshSnapshot {
  agents:    Presence[];        // card.kind === "agent", status-sorted (working→waiting→idle→offline) then by name
  endpoints: Presence[];        // everything else
  channels:  { channel: string; messages: number }[];
  feed:      FeedEntry[];       // classified + coalesced + windowed
  rates:     { msgsPerSec: number };
  status:    { connected: boolean; space: string; dmVisible: boolean; error?: string };
  signals:   MeshSignals;       // derived operator signals (below)
  nameOf:    (id: string) => string;   // unicast target id → display name
}
```

**What the model does:**

- **Classification.** `deliveryOf(subject)` returns chat / unicast / anycast (chat renders as
  multicast); control, presence, and trace frames return `null` and drop out of the feed.
- **Coalescing.** A same-sender/same-text unicast burst within 400 ms collapses to one entry, with
  a deterministic `id` (the first message's), `ts` (the earliest), and `count` (the multiplicity).
- **Roster.** A status-sorted snapshot plus an id→name map; agents split from other endpoints.
- **History prefill.** A one-shot per-channel backlog (multicast; plus DM backlog when DMs are
  visible), deduped against the live tap by `id`.
- **Windowing.** The feed is capped (~300 entries) with a rolling `msgs/s` rate.

### Derived operator signals

```ts
interface MeshSignals {
  counts:  { working: number; waiting: number; idle: number; offline: number };  // golden-signal tiles
  waiting: Presence[];              // agents blocked / needing input, name-ordered
  stalestLiveTs?: number;           // oldest heartbeat among live agents (liveness, not blocked-duration)
  dms:     DmPeer[];                // per-peer DM roll-up (only populated when DMs are visible)
}
```

**Why `waiting` is not age-ordered.** `Presence.ts` is the *last heartbeat*, republished on every
beat (2 s by default) — it is not the time the agent entered its current status, and the wire
carries no such field. So "how long has this agent been blocked" is **not knowable** from presence,
and no surface may claim it. `waiting` is therefore name-ordered, and the fifth golden-signal tile
reports `stalestLiveTs` — the oldest heartbeat among *live* agents, which answers "is a peer going
quiet?" and self-clears when that peer drops to offline. Offline agents are excluded: their
heartbeat age only grows, so including them would pin the tile to an ever-increasing number that
can never be acted on.

`dms` groups unicast traffic into per-peer conversations (`DmPeer → DmThread → DmMessage`), only
the pairs that actually talked, never the n² cross-product. It is populated only when DMs are
visible (god-view / open mode); a chat-only observer leaves it empty.

## Feature to surface map

| Feature | Model field | console (Ink) | stream | web |
|---|---|---|---|---|
| roster (status, activity, age) | `agents` / `endpoints` | ✓ panel | ✓ presence lines | ✓ sidebar |
| all-activity feed | `feed` | ✓ feed panel | ✓ log | ✓ Monitor view |
| channels plus counts | `channels` | ✓ tabs (`1`–`9`) |  | ✓ sidebar + Channel view |
| golden-signal counts | `signals.counts` | ✓ tiles strip |  | ✓ tiles |
| needs-you / blocked | `signals.waiting` | ✓ rail (`n`) |  | ✓ NEEDS-YOU rail |
| direct-message lens | `signals.dms` | ✓ lens (`d`) |  | ✓ DM view |
| topology (who-talks-to-whom) | `feed` + `agents` (derived) | ✓ lens (`t`, 3 variants) |  |  |
| message / agent **detail** | `feed` / `agents` | ✓ select → detail |  | ✓ row / thread |
| search / filter | client | ✓ `/` | (grep) | ✓ mode chips |
| msgs/s, connected, dmVisible | `rates` / `status` | ✓ status bar |  | ✓ conn pill |
| attention mode (`dnd` / `focus`) | `agents[].attention` |  |  | ✓ roster + detail + graph |
| per-channel attention (`quiet` / `muted`) | `agents[].channelModes` |  |  | ✓ agent detail |
| harness, model, variant | `agents[].card.meta` |  |  | ✓ badges + graph |
| channel policy (replay, delivery class) | `/api/channels` (web) |  |  | ✓ sidebar + header chips |

Both interactive surfaces render every model field. The console adds the signals as an always-on
tiles strip, a NEEDS-YOU rail (`n`), and a DM lens (`d`); the topology lens (`t`) folds the feed
plus roster into a who-talks-to-whom graph client-side and renders it three switchable ways
(`v` / `1`–`3`): swimlane sequence, adjacency heat matrix, and a ring node-link map. The stream is
line-oriented, so the signals stay out of it.

## Future: not yet on the wire

The web's `?demo` scene also mocks features that **no protocol message backs yet**. They render
only as the static design reference, never from live data, and are deliberately *not* implemented
on the live surfaces, design intent until the wire grows to support them:

| Flourish | What it would need |
|---|---|
| intent badges ("about to act") | a new intent message kind / field on the wire |
| approval requests (approve / deny) | a request message kind plus a response path (interactive) |
| task-failed alerts | a failure signal: a manager lifecycle event or a presence status |
| unclaimed-anycast / status roll-up | mostly derivable from existing traffic; a `MeshView` signal |
| per-conversation unread | per-viewer client state, not really protocol |

## Principles

- **Derive once, render many.** Classification, coalescing, sorting, id→name, rate, windowing, and
  the operator signals all live in `MeshView`. A surface only *lays out* the model; it never
  re-derives it. New surfaces are thin clients.
- **Presentation stays per-surface.** Colour palette, layout, CSS, keybindings, and input handling
  belong to each renderer, not the model.
- **No fallbacks.** If the observer cannot do what a surface needs, throw; do not silently degrade.
- **Status is shape *and* colour.** `● working · ◐ waiting · ○ idle · ⨯/⊘ offline`, never colour
  alone (accessibility).
- **Never render what the wire cannot say.** A surface shows a value only if the protocol actually
  carries it. Where it does not, say so plainly — an agent whose harness never reported a model
  reads *"not reported"*, never a guessed default; a heartbeat age is labelled as a heartbeat age,
  never as a blocked-duration. A confident wrong number costs more trust than an honest gap.
- **`open` attention is silent.** `attention: "open"` and an absent `attention` mean the same thing
  (receives everything), so neither renders a badge. Only `dnd` and `focus` surface — a marker on
  every peer is noise, and the point of the signal is that it stands out.

For the operator-facing walkthrough of these surfaces, see [Watch a mesh](watch-a-mesh.md).
