import { CotalEndpoint, isEventChannel, parseSubject, partsToText, spacePrefix, chatSubject, type CotalMessage, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  connectOrThrow,
  endpointAuth,
  exitCode,
  jsonFlag,
  plainFlag,
  presentationOf,
  renderReport,
  streamRecord,
  targetFlags,
  writeResult,
  writeStreamRecord,
  type Cell,
  type Connection,
  type OutputWarning,
  type Report,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { purgeHistory } from "./clean.js";

const dmsFlag = { name: "dms", type: "boolean", description: "also read DM history (needs a DM read grant); with clear, also clear DMs" } as const;
const forceFlag = { name: "force", type: "boolean", description: "clear: required - clear without prompting" } as const;
const sinceFlag = { name: "since", type: "string", value: "<time|seq>", description: "only messages after a time (ISO 8601, or an age such as 30m, 2h, 1d) or a chat stream sequence" } as const;
const limitFlag = { name: "limit", type: "string", value: "<n>", description: "how many of the newest retained messages to read, 1 to 1000 (default 50)" } as const;
const fromFlag = { name: "from", type: "string", value: "<name>", description: "keep messages from this sender name or id (filters the window)" } as const;
const grepFlag = { name: "grep", type: "string", value: "<text>", description: "keep messages whose text contains this, case-insensitive (filters the window)" } as const;
const followFlag = { name: "follow", type: "boolean", description: "keep listening and print each new message (NDJSON with --json)" } as const;
export const historyFlags = [...targetFlags, dmsFlag, forceFlag, sinceFlag, limitFlag, fromFlag, grepFlag, followFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
/** How many message ids a follow remembers to drop duplicates: a re-tap after a reconnect and the
 *  snapshot both overlap the live feed. */
const SEEN_IDS = 10_000;

/** One retained message as `history` reports it. `seq` is the chat stream sequence; DMs and reads
 *  mediated by the delivery daemon carry none. */
export interface HistoryItem {
  readonly seq: number | null;
  readonly id: string;
  readonly ts: string;
  readonly channel: string | null;
  readonly to: string | null;
  readonly from: { readonly id: string; readonly name: string };
  readonly text: string;
}

/** What `cotal history` read: the newest `limit` retained messages of its selection, oldest first,
 *  then filtered by `--since`, `--from` and `--grep`. It never claims complete history: `olderRetained`
 *  says whether retained messages older than the window exist, `reachesSince` whether the window goes
 *  back to `--since`, and `retention` names the limits that remove messages and each sender whose
 *  older messages a channel has lost to them. */
export interface HistoryResult {
  readonly kind: "history";
  readonly channels: string[];
  readonly dms: boolean;
  readonly window: {
    readonly limit: number;
    readonly read: number;
    readonly olderRetained: boolean | null;
    readonly since: string | null;
    readonly reachesSince: boolean | null;
    readonly from: string | null;
    readonly grep: string | null;
  };
  readonly retention: {
    readonly perSender: number | null;
    readonly maxAgeMs: number | null;
    readonly gaps: { readonly channel: string; readonly sender: string; readonly name: string | null; readonly retained: number }[];
  } | null;
  readonly replay: { readonly channel: string; readonly replay: boolean | null; readonly window: string | null }[];
  readonly denied: string[];
  readonly items: HistoryItem[];
}

type Since = { kind: "seq"; seq: number; text: string } | { kind: "time"; ms: number; text: string };

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw usage(`--limit takes a whole number from 1 to ${MAX_LIMIT}, not "${raw}"`);
  return n;
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseSince(raw: string | undefined, now: number): Since | undefined {
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw)) return { kind: "seq", seq: Number(raw), text: raw };
  const age = /^(\d+)([smhd])$/.exec(raw);
  if (age) return { kind: "time", ms: now - Number(age[1]) * UNIT_MS[age[2]!]!, text: new Date(now - Number(age[1]) * UNIT_MS[age[2]!]!).toISOString() };
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return { kind: "time", ms: at, text: new Date(at).toISOString() };
  throw usage(`--since takes a time (ISO 8601, or an age such as 30m, 2h, 1d) or a chat stream sequence, not "${raw}"`);
}

function itemOf(msg: CotalMessage, where: { seq?: number; channel?: string }): HistoryItem {
  return {
    seq: where.seq ?? null,
    id: msg.id,
    ts: new Date(msg.ts).toISOString(),
    channel: where.channel ?? msg.channel ?? null,
    to: msg.to ?? null,
    from: { id: msg.from.id, name: msg.from.name },
    text: partsToText(msg.parts),
  };
}

/** The window filters: `--since` against the sequence or time, `--from` against the sender's name or
 *  id, `--grep` against the text. */
function keep(item: HistoryItem, since: Since | undefined, from: string | undefined, grep: string | undefined): boolean {
  if (since?.kind === "seq" && (item.seq === null || item.seq <= since.seq)) return false;
  if (since?.kind === "time" && Date.parse(item.ts) <= since.ms) return false;
  if (from !== undefined && item.from.name !== from && item.from.id !== from) return false;
  if (grep !== undefined && !item.text.toLowerCase().includes(grep.toLowerCase())) return false;
  return true;
}

const denial = (e: unknown): boolean => /permission|not authori[sz]ed|read acl|may not read/i.test(e instanceof Error ? e.message : String(e));

/** `cotal history [channel]`: the newest retained messages in the selected space within the caller's
 *  read grant, or `history clear`. */
export async function history(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof historyFlags>;
  const [first, ...rest] = args.positionals;
  if (first === "clear") {
    if (v.json || v.plain) throw usage("history clear writes no structured or plain report yet; drop --json and --plain");
    if (!v.force) {
      console.error(c.red("refusing to clear history without --force"));
      console.error(c.dim("usage: cotal history clear --force [--dms] [--space <s>] [--server <url>]"));
      process.exit(1);
    }
    await purgeHistory(v);
    return;
  }
  const presentation = presentationOf(v);
  if (rest.length) throw usage(`history reads one channel at a time; got ${args.positionals.length} names`);
  if (v.force) throw usage("--force applies to `history clear` only");
  const channel = first;
  if (channel !== undefined && v.dms) throw usage("name a channel or pass --dms, not both: --dms adds DMs to the history of every channel");
  const now = Date.now();
  const limit = parseLimit(v.limit);
  const since = parseSince(v.since, now);
  if (since?.kind === "seq" && v.dms) throw usage("a sequence is a position in the chat stream, and DMs are another stream; give --since a time");

  const conn = await connectOrThrow(v, v.dms ? "admin" : "observer");
  const target = { space: conn.space, channel: channel ?? null, dms: Boolean(v.dms) };
  const errors: string[] = [];
  const ep = new CotalEndpoint({
    space: conn.space,
    servers: conn.server,
    ...endpointAuth(conn),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    card: { name: "history", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => errors.push(e.message));
  try {
    await ep.start();
  } catch (e) {
    await ep.stop().catch(() => {});
    throw e;
  }
  let stopping = false;
  try {
    // A follow taps before it reads, so nothing sent between the read and the tap is lost; the
    // snapshot and the live feed are reconciled by message id.
    const live = v.follow ? openLive(ep, conn, channel, Boolean(v.dms)) : undefined;
    const { result, warnings } = await readWindow(ep, conn, { channel, dms: Boolean(v.dms), limit, since, from: v.from, grep: v.grep, target });
    const partial = warnings.length
      ? { message: `history could not read ${warnings.length === 1 ? "one part" : `${warnings.length} parts`} of what it reports; the warnings name ${warnings.length === 1 ? "it" : "each"}` }
      : undefined;
    const completeness = partial ? "partial" : "complete";
    if (live && presentation === "json") {
      // A follow's snapshot is its first record, and the exit says what `writeResult` would have.
      writeStreamRecord(streamRecord("history", "snapshot", target, { ...result, completeness, warnings }));
      process.exitCode = partial ? exitCode("partial", "OPERATION_PARTIAL") : exitCode("ok");
    } else {
      writeResult(presentation, { command: "history", target, result, completeness, warnings, ...(partial ? { partial } : {}) }, (r) => historyView(r, conn.space));
    }
    if (!live) return;
    await live.follow(result.items, (item) => keep(item, undefined, v.from, v.grep), presentation, target, () => stopping);
  } finally {
    stopping = true;
    await ep.stop().catch(() => {});
  }
}

interface WindowRequest {
  readonly channel: string | undefined;
  readonly dms: boolean;
  readonly limit: number;
  readonly since: Since | undefined;
  readonly from: string | undefined;
  readonly grep: string | undefined;
  readonly target: unknown;
}

export async function readWindow(ep: CotalEndpoint, conn: Connection, req: WindowRequest): Promise<{ result: HistoryResult; warnings: OutputWarning[] }> {
  const warnings: OutputWarning[] = [];
  const user = conn.mode === "user";
  if (user && req.dms)
    throw new CommandFailure("refused", "PERMISSION_DENIED", "DM history is readable only with the space signer's audit credential; a user-auth identity holds no DM read grant", { target: req.target });
  if (user && req.since?.kind === "seq")
    throw new CommandFailure("refused", "UNSUPPORTED", "a user-auth identity reads history through the delivery daemon, which reports no stream sequence; give --since a time", { target: req.target });

  // The channel list with its retained counts. A named channel needs it only for the count, so a
  // failure there is a part not read; reading every channel needs it to know what to read.
  let listed: { channel: string; messages: number }[] | undefined;
  try {
    listed = (await ep.listChannels()).filter((row) => !isEventChannel(row.channel));
  } catch (e) {
    if (req.channel === undefined) {
      if (denial(e)) throw new CommandFailure("refused", "PERMISSION_DENIED", `this identity may not list the channels of ${conn.space}: ${(e as Error).message}`, { target: req.target });
      throw e;
    }
    warnings.push({ code: "CHANNELS_UNREAD", target: req.target, message: `the channel list could not be read, so its retained count is unknown: ${(e as Error).message}` });
  }
  const channels = req.channel !== undefined ? [req.channel] : (listed ?? []).map((row) => row.channel);

  let read: HistoryItem[] = [];
  let olderRetained: boolean | null = null;
  const denied: string[] = [];
  if (!user) {
    let rows: { channel: string; seq: number; msg: CotalMessage }[];
    try {
      rows = await ep.multiChannelHistory(channels, { limit: req.limit });
    } catch (e) {
      if (denial(e)) throw new CommandFailure("refused", "PERMISSION_DENIED", `this identity may not read ${req.channel ? `#${req.channel}` : "channel history"} in ${conn.space}: ${(e as Error).message}`, { target: req.target });
      if (/wildcard|not a valid channel|channel name/i.test((e as Error).message)) throw usage((e as Error).message);
      throw e;
    }
    read = rows.map((row) => itemOf(row.msg, { seq: row.seq, channel: row.channel }));
    const retained = listed ? listed.filter((row) => channels.includes(row.channel)).reduce((sum, row) => sum + row.messages, 0) : undefined;
    olderRetained = retained === undefined ? null : retained > read.length;
    if (req.dms) {
      const dms = (await ep.dmHistory({ limit: req.limit })).map((msg) => itemOf(msg, {}));
      const merged = [...read, ...dms].sort((a, b) => a.ts.localeCompare(b.ts));
      if (dms.length === req.limit || merged.length > req.limit) olderRetained = true;
      read = merged.slice(-req.limit);
    }
  } else {
    // A user-auth identity reads through the delivery daemon, which checks its read grant on every
    // call. A channel outside the grant is refused, never an empty page.
    let incomplete = false;
    for (const ch of channels) {
      try {
        const page = await ep.readHistory(ch, { limit: req.limit });
        read.push(...page.items.map((msg) => itemOf(msg, { channel: ch })));
        if (!page.complete) incomplete = true;
      } catch (e) {
        if (req.channel !== undefined) {
          if (denial(e)) throw new CommandFailure("refused", "PERMISSION_DENIED", `this identity may not read #${ch} in ${conn.space}: ${(e as Error).message}`, { target: req.target });
          throw e;
        }
        if (denial(e)) denied.push(ch);
        else warnings.push({ code: "CHANNEL_UNREAD", target: { space: conn.space, channel: ch }, message: `#${ch} could not be read: ${(e as Error).message}` });
      }
    }
    if (denied.length)
      warnings.push({ code: "CHANNELS_DENIED", target: req.target, message: `this identity may not read ${denied.length === 1 ? "one channel" : `${denied.length} channels`} (${denied.map((ch) => `#${ch}`).join(", ")}), so their messages are not shown` });
    read.sort((a, b) => a.ts.localeCompare(b.ts));
    olderRetained = incomplete || read.length > req.limit;
    read = read.slice(-req.limit);
  }

  let retention: HistoryResult["retention"] = null;
  try {
    const held = await ep.chatRetention();
    const names = new Map(read.map((item) => [item.from.id, item.from.name]));
    retention = {
      perSender: held.perSender,
      maxAgeMs: held.maxAgeMs,
      gaps: held.perSender === null
        ? []
        : held.senders
            .filter((s) => channels.includes(s.channel) && s.messages >= held.perSender!)
            .map((s) => ({ channel: s.channel, sender: s.sender, name: names.get(s.sender) ?? null, retained: s.messages })),
    };
  } catch (e) {
    warnings.push({ code: "RETENTION_UNREAD", target: req.target, message: `the chat stream's retention could not be read, so gaps it left are unknown: ${(e as Error).message}` });
  }

  // Each channel's replay policy, read from the registry: the endpoint's watch cache may not have
  // caught up this soon after start.
  const replay = await Promise.all(
    channels.map(async (ch): Promise<HistoryResult["replay"][number]> => {
      try {
        return { channel: ch, ...(await ep.channelReplayPolicy(ch)) };
      } catch (e) {
        warnings.push({ code: "REPLAY_UNREAD", target: { space: conn.space, channel: ch }, message: `#${ch}'s replay policy could not be read: ${(e as Error).message}` });
        return { channel: ch, replay: null, window: null };
      }
    }),
  );

  // Whether the window goes back to `--since`: it does when nothing older is retained, or when its
  // oldest message is at or before the point asked for. Otherwise messages in between may be missing.
  const oldest = read[0];
  const before = (since: Since, item: HistoryItem) => (since.kind === "seq" ? item.seq !== null && item.seq <= since.seq + 1 : Date.parse(item.ts) <= since.ms);
  const reachesSince = req.since === undefined ? null : olderRetained === false || (oldest !== undefined && before(req.since, oldest)) ? true : olderRetained === null ? null : false;
  return {
    warnings,
    result: {
      kind: "history",
      channels,
      dms: req.dms,
      window: { limit: req.limit, read: read.length, olderRetained, since: req.since?.text ?? null, reachesSince, from: req.from ?? null, grep: req.grep ?? null },
      retention,
      replay,
      denied,
      items: read.filter((item) => keep(item, req.since, req.from, req.grep)),
    },
  };
}

/** The live half of `--follow`: taps the selection's subjects, re-taps after the connection is
 *  re-established (a rebuild drops the old subscriptions), and records that gap. */
function openLive(ep: CotalEndpoint, conn: Connection, channel: string | undefined, dms: boolean) {
  const queue: { item?: HistoryItem; gap?: string; error?: string }[] = [];
  let wake: (() => void) | undefined;
  const push = (entry: { item?: HistoryItem; gap?: string; error?: string }) => {
    queue.push(entry);
    wake?.();
  };
  const prefix = spacePrefix(conn.space);
  const tapAll = () => {
    ep.tap((subject, msg) => {
      if (!msg) return;
      const p = parseSubject(subject);
      if (p?.kind === "chat") push({ item: itemOf(msg, { channel: p.rest }) });
      else if (p?.kind === "inst") push({ item: itemOf(msg, {}) });
    }, { subject: channel !== undefined ? chatSubject(conn.space, "*", "*", channel) : `${prefix}.chat.>` });
    if (dms) ep.tap((subject, msg) => { if (msg && parseSubject(subject)?.kind === "inst") push({ item: itemOf(msg, {}) }); }, { subject: `${prefix}.inst.>` });
  };
  let down = false;
  ep.on("connection", ({ connected }: { connected: boolean }) => {
    if (!connected) {
      down = true;
      return;
    }
    if (!down) return;
    down = false;
    tapAll();
    push({ gap: "the connection was re-established; messages sent while it was down are not shown" });
  });
  ep.on("error", (e: Error) => push({ error: e.message }));
  tapAll();

  return {
    async follow(snapshot: HistoryItem[], match: (item: HistoryItem) => boolean, presentation: "json" | "rich" | "plain", target: unknown, stopped: () => boolean): Promise<void> {
      const seen = new Set(snapshot.map((item) => item.id));
      const remember = (id: string) => {
        seen.add(id);
        if (seen.size > SEEN_IDS) seen.delete(seen.values().next().value!);
      };
      const end = new Promise<string>((resolve) => {
        process.once("SIGINT", () => resolve("interrupted"));
        process.once("SIGTERM", () => resolve("terminated"));
      });
      let ended: string | undefined;
      void end.then((reason) => {
        ended = reason;
        wake?.();
      });
      const line = (cell: Cell) => process.stdout.write(`${renderReport({ sections: [{ blocks: [{ kind: "lines", lines: [cell] }] }] }, presentation === "rich" ? "rich" : "plain")}\n`);
      for (;;) {
        while (queue.length) {
          const entry = queue.shift()!;
          if (entry.item) {
            if (seen.has(entry.item.id) || !match(entry.item)) continue;
            remember(entry.item.id);
            if (presentation === "json") writeStreamRecord(streamRecord("history", "event", target, entry.item));
            else line(itemLine(entry.item));
          } else if (entry.gap) {
            if (presentation === "json") writeStreamRecord(streamRecord("history", "gap", target, { reason: entry.gap }));
            else line({ text: `gap: ${entry.gap}`, tone: "waiting" });
          } else if (entry.error) {
            if (presentation === "json") writeStreamRecord(streamRecord("history", "error", target, { code: "OPERATION_FAILED", message: entry.error }));
            else process.stderr.write(`${c.red(`! ${entry.error}`)}\n`);
          }
        }
        if (ended || stopped()) break;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
      if (presentation === "json") writeStreamRecord(streamRecord("history", "end", target, { reason: ended ?? "stopped" }));
    },
  };
}

function where(item: HistoryItem): string {
  return item.channel !== null ? `#${item.channel}` : `DM to ${item.to ?? "?"}`;
}

function itemLine(item: HistoryItem): Cell {
  return `${item.ts}  ${where(item)}  ${item.from.name}: ${item.text}`;
}

function historyView(r: HistoryResult, space: string): Report {
  const scope = r.channels.length === 1 && !r.dms ? `#${r.channels[0]}` : r.dms ? "every channel and DMs" : "every channel";
  const notes: Cell[] = [];
  const filtered = r.window.since !== null || r.window.from !== null || r.window.grep !== null;
  notes.push({ text: `${r.items.length} ${r.items.length === 1 ? "message" : "messages"}${filtered ? ` of the ${r.window.read} read` : ""}: the newest retained in ${scope} of ${space}, up to --limit ${r.window.limit}`, tone: "hint" });
  if (r.window.olderRetained === true) notes.push({ text: "older retained messages are not shown; raise --limit (up to 1000) to read further back", tone: "hint" });
  if (r.window.olderRetained === null) notes.push({ text: "whether older retained messages exist is unknown", tone: "waiting" });
  if (r.window.reachesSince === false) notes.push({ text: `the window does not reach back to --since ${r.window.since}; messages between them are not shown`, tone: "waiting" });
  if (r.retention) {
    const limits = [r.retention.perSender !== null ? `${r.retention.perSender} per sender on each channel` : null, r.retention.maxAgeMs !== null ? `${Math.round(r.retention.maxAgeMs / 3_600_000)}h` : null].filter(Boolean);
    notes.push({ text: `retention: ${limits.length ? limits.join(", ") : "no limit set"}; history is what remains, not every message sent`, tone: "hint" });
    for (const gap of r.retention.gaps)
      notes.push({ text: `gap: #${gap.channel} holds ${gap.retained} from ${gap.name ?? gap.sender}, the per-sender limit, so their older messages there are gone`, tone: "waiting" });
  }
  if (r.dms) notes.push({ text: "DM retention gaps are not reported", tone: "hint" });
  for (const row of r.replay) notes.push({ text: `#${row.channel} replay to new members: ${row.replay === null ? "unknown" : row.replay ? `on${row.window ? ` (${row.window})` : ""}` : "off"}`, tone: "hint" });
  for (const ch of r.denied) notes.push({ text: `#${ch}: not readable by this identity`, tone: "failed" });
  return {
    sections: [
      {
        blocks: [
          ...(r.items.length
            ? [{
                kind: "table" as const,
                columns: [{ key: "ts", label: "TIME" }, { key: "where", label: "WHERE" }, { key: "from", label: "FROM" }, { key: "text", label: "MESSAGE" }],
                rows: r.items.map((item) => ({ ts: item.ts, where: where(item), from: item.from.name, text: item.text })),
              }]
            : []),
          { kind: "lines" as const, lines: notes },
        ],
      },
    ],
  };
}

