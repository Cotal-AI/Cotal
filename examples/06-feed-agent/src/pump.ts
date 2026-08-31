import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import Parser from "rss-parser";
import { parseICS, type CalendarComponent, type ParameterValue, type VEvent } from "node-ical";
import { CotalEndpoint, DEFAULT_SERVER, isReachable } from "@cotal-ai/core";

/**
 * The pump: poll every feed in `subscriptions.yaml`, publish each item it has not seen before as
 * one message on that subscription's channel.
 *
 * Deliberately dumb. It fetches, normalizes RSS and iCal into the same {@link Item}, drops what it
 * already published (`state/seen.json`), and multicasts the rest. No model, no judgment, no memory
 * beyond the seen set — so a run is reproducible and a bug is a bug, not a bad sample. Everything
 * interesting (offline peers catching up, a late joiner reading history as history) is the mesh's
 * job, not this file's. Deciding *what* to subscribe to is the feedkeeper agent's job.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DEFAULT_CONFIG = join(ROOT, "subscriptions.yaml");
const SEEN_FILE = join(ROOT, "state", "seen.json");

const SEEN_CAP = 2000;      // newest N keys kept; older items can never come back on a live feed
const MAX_PER_PASS = 10;    // a first pass on a busy feed would otherwise dump a whole page into the channel
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_LOOP_MIN = 15;

type Kind = "auto" | "rss" | "ical";

interface Subscription {
  url: string;
  channel: string;
  kind?: Kind;
  filter?: string[];
  label?: string;
}

/** One feed entry, RSS and iCal flattened to the same shape. */
interface Item {
  id: string;
  title: string;
  url: string;
  when?: string;
  source: string;
}

type Publish = (channel: string, text: string) => Promise<void>;

const rss = new Parser({ timeout: FETCH_TIMEOUT_MS });

const hostOf = (url: string): string => new URL(url).host.replace(/^www\./, "");

/** Node's fetch reports every transport problem as a bare "fetch failed" and hides the reason
 *  (DNS, TLS, reset) on `cause`, which is the only part worth reading when a feed goes quiet. */
function reason(e: unknown): string {
  const err = e as Error & { cause?: Error };
  return err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
}

/** iCal text properties arrive either bare or wrapped with their parameters (LANGUAGE, ALTREP…). */
const icalText = (v: ParameterValue | undefined): string => (typeof v === "string" ? v : (v?.val ?? ""));

const isEvent = (c: CalendarComponent | undefined): c is VEvent => (c as VEvent | undefined)?.type === "VEVENT";

function loadSubscriptions(file: string): Subscription[] {
  const doc = parseYaml(readFileSync(file, "utf8")) as { subscriptions?: unknown } | null;
  const list = doc?.subscriptions;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`no subscriptions in ${file} - add one under "subscriptions:" (every entry needs a url and a channel)`);
  return list.map((entry, i) => {
    const sub = entry as Partial<Subscription>;
    if (!sub?.url || !sub.channel) throw new Error(`subscription #${i + 1} in ${file} needs both "url" and "channel"`);
    // A typo like `kind: ics` would otherwise be treated as RSS and fail later as a parse error.
    if (sub.kind && !["auto", "rss", "ical"].includes(sub.kind))
      throw new Error(`subscription #${i + 1} in ${file}: kind "${sub.kind}" is not auto, rss, or ical`);
    return { ...sub, url: sub.url, channel: sub.channel } as Subscription;
  });
}

async function fetchFeed(url: string): Promise<{ body: string; contentType: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": "cotal-feed-pump" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { body: await res.text(), contentType: res.headers.get("content-type") ?? "" };
}

/** `kind: auto` asks the response what it is: content-type first, then the extension, then the body. */
function detectKind(sub: Subscription, contentType: string, body: string): "rss" | "ical" {
  if (sub.kind && sub.kind !== "auto") return sub.kind;
  if (/text\/calendar/i.test(contentType)) return "ical";
  if (/\.ics(\?|#|$)/i.test(sub.url)) return "ical";
  return body.trimStart().startsWith("BEGIN:VCALENDAR") ? "ical" : "rss";
}

async function fromRss(body: string, sub: Subscription): Promise<Item[]> {
  const feed = await rss.parseString(body);
  const source = sub.label ?? feed.title?.trim() ?? hostOf(sub.url);
  return (feed.items ?? []).flatMap((it) => {
    const title = it.title?.trim();
    const id = it.guid ?? it.link ?? title;
    return title && id ? [{ id, title, url: it.link ?? "", when: it.isoDate ?? it.pubDate, source }] : [];
  });
}

/** Luma and most other exporters omit the URL property and put the event link in the description
 *  instead, so every event would otherwise share the calendar's own link. */
function eventUrl(ev: VEvent, sub: Subscription): string {
  if (ev.url) return ev.url;
  const found = /https?:\/\/\S+/.exec(icalText(ev.description));
  return found ? found[0].replace(/[).,]+$/, "") : sub.url;
}

/** Only events that have not finished yet, soonest first: a calendar carries its whole past, and
 *  nobody wants last year's meetups replayed into a channel. */
function fromIcal(body: string, sub: Subscription): Item[] {
  const cal = parseICS(body);
  const named = cal.vcalendar?.type === "VCALENDAR" ? cal.vcalendar["WR-CALNAME"] : undefined;
  const source = sub.label ?? named ?? hostOf(sub.url);
  const now = Date.now();
  return Object.values(cal)
    .filter(isEvent)
    .filter((ev) => (ev.end ?? ev.start).getTime() >= now)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((ev) => ({
      id: ev.uid,
      title: icalText(ev.summary) || "(untitled event)",
      url: eventUrl(ev, sub),
      when: ev.start.toISOString(),
      source,
    }));
}

async function collect(sub: Subscription): Promise<Item[]> {
  const { body, contentType } = await fetchFeed(sub.url);
  return detectKind(sub, contentType, body) === "ical" ? fromIcal(body, sub) : await fromRss(body, sub);
}

const keyOf = (sub: Subscription, item: Item): string =>
  createHash("sha1").update(`${sub.url}\n${item.id}`).digest("hex").slice(0, 16);

/** Keywords match at a word START, so a short one like "ai" hits "AI agents" and "AI-native" but not
 *  "Bailout" or "detail", while "agent" still hits "agents" and "agentic". */
const matches = (title: string, filter?: string[]): boolean =>
  !filter?.length || filter.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(title));

function render(item: Item): string {
  const url = item.url ? ` — ${item.url}` : "";
  const when = item.when ? ` (${new Date(item.when).toISOString().slice(0, 16).replace("T", " ")} UTC)` : "";
  return `[${item.source}] ${item.title}${url}${when}`;
}

function loadSeen(file: string): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(file, "utf8")) as string[]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Set(); // first run
    throw e;
  }
}

function saveSeen(file: string, seen: Set<string>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify([...seen].slice(-SEEN_CAP))}\n`);
}

/** One pass over every subscription. A feed that is down is logged and skipped: the others still run. */
async function runPass(subs: Subscription[], seen: Set<string>, publish: Publish): Promise<number> {
  let published = 0;
  for (const sub of subs) {
    let items: Item[];
    try {
      items = await collect(sub);
    } catch (e) {
      console.error(`  ✗ ${sub.label ?? sub.url}: ${reason(e)}`);
      continue;
    }
    const fresh = items.filter((i) => matches(i.title, sub.filter) && !seen.has(keyOf(sub, i))).slice(0, MAX_PER_PASS);
    const name = sub.label ?? items[0]?.source ?? hostOf(sub.url);
    console.log(`  ${name} → #${sub.channel}: ${fresh.length} new of ${items.length}`);
    for (const item of fresh) {
      await publish(sub.channel, render(item));
      seen.add(keyOf(sub, item));
      published++;
    }
  }
  return published;
}

async function main(): Promise<void> {
  // `--loop` may be bare (default cadence) or carry minutes; parseArgs needs the value spelled out.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const bare = argv.indexOf("--loop");
  if (bare >= 0 && (argv[bare + 1] === undefined || argv[bare + 1].startsWith("-")))
    argv.splice(bare + 1, 0, String(DEFAULT_LOOP_MIN));

  const { values } = parseArgs({ args: argv, options: {
    config: { type: "string" }, space: { type: "string" }, server: { type: "string" },
    once: { type: "boolean" }, loop: { type: "string" }, "dry-run": { type: "boolean" },
  } });

  const subs = loadSubscriptions(values.config ?? DEFAULT_CONFIG);
  const everyMs = values.once || !values.loop ? 0 : Number(values.loop) * 60_000; // 0 ⇒ single pass, the default
  if (values.loop && !values.once && !(everyMs > 0)) throw new Error(`--loop takes minutes, got "${values.loop}"`);

  if (values["dry-run"]) {
    // No mesh at all: print the lines a real run would publish and leave state/seen.json alone.
    const printed = await runPass(subs, new Set(loadSeen(SEEN_FILE)), async (channel, text) => {
      console.log(`  → #${channel}  ${text}`);
    });
    console.log(`dry run: ${printed} message(s) would be published (state untouched)`);
    return;
  }

  const space = values.space ?? (process.env.COTAL_SPACE?.trim() || "demo");
  const server = values.server ?? (process.env.COTAL_SERVERS?.trim() || DEFAULT_SERVER);
  if (!(await isReachable(server))) {
    console.error(`Can't reach NATS at ${server}. Run: pnpm cotal up`);
    process.exit(1);
  }

  const ep = new CotalEndpoint({
    space,
    servers: server,
    channels: [...new Set(subs.map((s) => s.channel))],
    card: { name: "feed-pump", kind: "endpoint", description: "Publishes new items from the subscribed feeds." },
    consume: false,
    registerPresence: true,
    watchPresence: false,
  });
  ep.on("error", (e: Error) => console.error(`mesh: ${e.message}`));
  await ep.start();
  console.log(`feed pump → space "${space}" at ${server} — ${subs.length} subscription(s)`);

  const seen = loadSeen(SEEN_FILE);
  const pass = async (): Promise<void> => {
    const published = await runPass(subs, seen, async (channel, text) => void (await ep.multicast(text, { channel })));
    saveSeen(SEEN_FILE, seen);
    console.log(`published ${published} message(s)`);
  };

  await pass();
  if (!everyMs) return void (await ep.stop());

  console.log(`looping every ${everyMs / 60_000} min — Ctrl-C to stop`);
  const timer = setInterval(() => void pass(), everyMs);
  const stop = (): void => {
    clearInterval(timer);
    void ep.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
