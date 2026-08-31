# 06 · Feed agent — any feed, one channel

Point an RSS feed or an iCal calendar at a mesh channel. A deterministic **pump** polls the feeds in
`subscriptions.yaml` and publishes each new item as one message; a **feedkeeper** agent sits in the
channel and edits that file when someone asks it to.

Two moving parts, deliberately split: the pump has no judgment, and the agent does no plumbing.

## Prerequisites

- Node ≥ 22, pnpm, and `nats-server` (v2.11+). macOS: `brew install nats-server`.
- Install deps once, from the repo root: `pnpm install`.

## Run it

**1. Start the mesh** (one terminal — stays running):

```
pnpm cotal up --channels examples/06-feed-agent/channels.json
```

That seeds `#feeds.events` with replay on, so an agent joining tomorrow still sees what was posted
today.

**2. See what the pump would post** — no mesh needed, nothing published, nothing marked as seen:

```
cd examples/06-feed-agent && pnpm pump --dry-run
```

```
  HN → #feeds.events: 10 new of 20
  → #feeds.events  [HN] Apache Iggy, a message streaming platform in Rust, graduates to an Apache TLP — https://iggy.apache.org/… (2026-08-31 14:54 UTC)
  …
dry run: 10 message(s) would be published (state untouched)
```

**3. Pump it for real** (from the same directory):

```
pnpm pump                # one pass, then exit
pnpm pump --loop         # every 15 minutes until Ctrl-C
pnpm pump --loop 60      # …or your own cadence
```

Published items are recorded in `state/seen.json`, so a second pass posts only what is actually new.
The file is machine-local and gitignored; delete it to replay a feed from scratch.

**4. Let an agent manage the subscriptions** (another terminal):

```
cotal spawn --agent claude --name feedkeeper --config examples/06-feed-agent/agents/feedkeeper.md
```

Then, on `#feeds.events`, ask it in plain language:

> feedkeeper: subscribe to the Frontier Tower calendar, https://lu.ma/frontiertower — only the AI and
> robotics events please

It resolves the calendar's iCal URL, adds the entry with a `filter`, proves it with a dry run before
claiming anything, and confirms in the channel. It edits `subscriptions.yaml` and nothing else.

**5. What you should see.** Each item arrives as one line on `#feeds.events`:

```
[Frontier Tower SF] BURNING TOKEN, the AI Global hackathon — https://luma.com/burningtoken (2026-09-05 17:00 UTC)
```

Join late (`pnpm cotal join --space demo --name reader`) and the backlog is there, as history rather
than as a burst of new messages.

## Luma calendars

Any public Luma calendar publishes an iCal feed, no scraping and no API key. Open the calendar page
(for example `https://lu.ma/frontiertower`), click **Add iCal Subscription** in the sidebar, and copy
the URL it hands your calendar app. It looks like:

```
https://api.lu.ma/ics/get?entity=calendar&id=cal-Sl7q1nHTRXQzjP2
```

Drop that into `subscriptions.yaml` with `kind: ical`. The feed carries every published event on the
calendar, past ones included, so the pump keeps only events that have not finished yet and posts them
soonest-first. `subscriptions.yaml` ships with this calendar commented out — uncomment it to watch it
work.

## Why this is interesting

The pump is boring on purpose. It fetches, normalizes RSS and iCal into the same shape, drops what it
has already published, and multicasts the rest. No model, no memory, no retry logic worth the name. A
feed being down is a logged line and the next feed still runs.

Everything that would normally be hard is the mesh's job instead of the pump's. It publishes once and
stops caring: an agent that was offline catches up when it returns, a late joiner reads the backlog as
history instead of a flood of pings, and adding a second consumer costs the pump nothing. Delivery
semantics are a property of the channel, not something each integration reimplements badly.

That leaves the agent with only the part that actually needs judgment — which feeds are worth
following, and which items are worth anyone's attention. The feedkeeper never touches the wire.

## Pieces

| File | Role |
|---|---|
| `subscriptions.yaml` | The list: url, channel, and optional kind / filter / label. The one file the agent edits. |
| `src/pump.ts` | Poll, normalize, dedup, publish. Supports `--dry-run`, `--once` (default), `--loop [minutes]`, `--config`, `--space`, `--server`. |
| `channels.json` | Seeds `#feeds.events` with replay on. |
| `agents/feedkeeper.md` | The persona that owns `subscriptions.yaml`. |
| `state/seen.json` | What has already been published. Machine-local, gitignored. |

Environment: `COTAL_SPACE` (default `demo`) and `COTAL_SERVERS` (default `nats://127.0.0.1:4222`),
both overridable with `--space` / `--server`.
