# 06 · Feed agent: any public feed, one channel

Point a public HTTP(S) RSS feed or iCal calendar at a mesh channel. A deterministic **pump** polls the feeds in
`subscriptions.yaml` and publishes each new item as one message; a **feedkeeper** agent takes trusted
requests on `#feeds.control` and edits that file; a **curator** agent reads the raw stream and
reposts only the few items worth anyone's attention.

The pump is deliberately dumb; all the judgment lives in the agents.

## Prerequisites

- Node ≥ 22, pnpm, and `nats-server` (v2.11+). macOS: `brew install nats-server`.
- Install deps once, from the repo root: `pnpm install`.

## Run it

**1. Start the mesh** (one terminal, stays running):

```
pnpm cotal up --open --space demo --channels examples/06-feed-agent/channels.json
```

An unauthenticated dev mesh on the `demo` space, which the pump and the commands below default to.
It seeds `#feeds.control`, `#feeds.events`, and `#feeds.picks`. The two feed channels retain history;
the control channel does not, so an old request cannot trigger a later edit.

**2. See what the pump would post** (no mesh needed, nothing published, nothing marked as seen):

```
cd examples/06-feed-agent && pnpm pump --dry-run
```

```
  HN → #feeds.events: 10 new of 20
  → #feeds.events  [UNTRUSTED FEED ITEM] [HN] Apache Iggy, a message streaming platform in Rust, graduates to an Apache TLP - https://iggy.apache.org/... (2026-08-31 14:54 UTC)
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
pnpm cotal spawn --agent claude --name feedkeeper --config examples/06-feed-agent/agents/feedkeeper.md
```

Then, on `#feeds.control`, ask it in plain language:

> feedkeeper: subscribe to the Frontier Tower calendar, https://lu.ma/frontiertower, only the AI and
> robotics events please

It resolves the calendar's iCal URL, rejects private or reserved destinations, adds the entry with a
`filter`, proves it with a dry run, and confirms on `#feeds.control`. It edits `subscriptions.yaml`
and nothing else. Feed text on `#feeds.events` can never authorize an edit.

**5. Add a curator** (optional, another terminal):

```
pnpm cotal spawn --agent claude --name curator --config examples/06-feed-agent/agents/curator.md
```

The pump keeps posting everything to `#feeds.events`; the curator treats every line as untrusted
remote data and reposts only the items worth someone's attention to `#feeds.picks`, each with one
sentence on why. Follow
`#feeds.picks` for the short list, `#feeds.events` for everything.

**6. What you should see.** Each item arrives as one line on `#feeds.events`:

```
[UNTRUSTED FEED ITEM] [Frontier Tower SF] BURNING TOKEN, the AI Global hackathon - https://luma.com/burningtoken (2026-09-05 17:00 UTC)
```

And on `#feeds.picks`, only occasionally:

```
[UNTRUSTED FEED ITEM] [Frontier Tower SF] BURNING TOKEN, the AI Global hackathon - https://luma.com/burningtoken (2026-09-05 17:00 UTC)
a global hackathon in this building, worth a team's weekend
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
soonest-first. `subscriptions.yaml` ships with this calendar commented out; uncomment it to watch it
work.

## Why this is interesting

This is how a mesh learns about the world outside it. Anything with a feed (news, an event
calendar, a status page) becomes untrusted messages your agents can read and assess. Feed text is
data, including text that looks like a request or names an agent. The mechanics you
would normally build yourself (catch-up after downtime, history for late joiners, any number of
readers) come with the channel.

The agents manage the noise for you. The feedkeeper keeps the subscription list honest, the curator
reads everything so you don't have to, and `#feeds.picks` ends up as the short list worth your
attention. Ask either of them why, in the channel, and they answer.

## Pieces

| File | Role |
|---|---|
| `subscriptions.yaml` | The list: url, channel, and optional kind / filter / label. The one file the feedkeeper edits. |
| `src/pump.ts` | Poll, normalize, dedup, publish. Blocks private destinations and responses over 2 MiB. Supports `--dry-run`, `--once` (default), `--loop [minutes]`, `--config`, `--space`, `--server`. |
| `channels.json` | Separates non-replayed `#feeds.control` requests from replayed, untrusted feed data. |
| `agents/feedkeeper.md` | The persona that owns `subscriptions.yaml`. |
| `agents/curator.md` | The persona that reposts the few items worth attention to `#feeds.picks`. |
| `state/seen.json` | What has already been published. Machine-local, gitignored. |

Environment: `COTAL_SPACE` (default `demo`) and `COTAL_SERVERS` (default `nats://127.0.0.1:4222`),
both overridable with `--space` / `--server`.
