// The dashboard's data logic: the bootstrap reads, the order machines, the live feed and the two
// writes the page makes (deleting a channel and posting as the operator). It reads only through the
// injected `Api` and writes only to the store, so the smoke suites drive it in Node over a fake `Api`.
//
// Ported from the old plain-JS pages: `refresh()`, `select()`, `onMessage()` and `deleteChannel()`
// from the console page, and the rule from the graph page that a live feed outranks a bootstrap
// read issued before it.
import type { ActivityEntry, ActivityPage, ChannelInfo, CotalMessage, FeedMessage, MembershipSnapshot, Meta, PresenceView, RosterEntry, SendAnswer } from "../api/types.js";
import { composeKey, refusalText, type ComposeTarget } from "../lib/compose.js";
import { createEventOrder, type EventOrder, type FeedEntryLike, type OrderNote } from "../lib/eventOrder.js";
import { displayNameOf, nameIndex } from "../lib/names.js";
import { presenceViewMark } from "../lib/roster.js";
import { refreshAll, type StaleMark } from "../lib/snapshot.js";
import type { Store } from "./store.js";
import type { ChannelRow, DashboardState, Draft, Outgoing, StoredMessage } from "./types.js";

/** The server's reads and its two writes. Each read throws on a refusal (see `readJson`), and `send`
 *  throws `SendRefused` with the status and the server's text. */
export interface Api {
  meta(): Promise<Meta>;
  roster(): Promise<RosterEntry[]>;
  channels(): Promise<ChannelInfo[]>;
  activity(limit: number): Promise<ActivityPage>;
  dms(limit: number): Promise<CotalMessage[]>;
  history(channel: string, limit: number): Promise<CotalMessage[]>;
  membership(): Promise<MembershipSnapshot>;
  deleteChannel(channel: string): Promise<{ ok: true; channel: string; purged: number }>;
  send(target: ComposeTarget, text: string): Promise<SendAnswer>;
}

export interface Controller {
  refresh(): Promise<void>;
  open(channel: string | null): Promise<void>;
  onRoster(roster: RosterEntry[]): void;
  onPresenceView(view: PresenceView): void;
  onMessage(e: FeedMessage): void;
  onMembership(m: MembershipSnapshot): void;
  onMembershipFailed(reason: string): void;
  deleteChannel(channel: string): Promise<void>;
  /** Post `text` to `target` as the operator. The box empties and the post shows faded until the
   *  server answers. A refusal puts the text back in the box with the refusal said under it, and
   *  rethrows the server's error. */
  send(target: ComposeTarget, text: string): Promise<void>;
  /** What the reader has typed for `target`. Editing a refused draft clears the refusal. */
  draft(target: ComposeTarget, text: string): void;
}

/** `createOrder` builds the order machine for a lane: the feed's, or the open channel's. The
 *  default is `createEventOrder`; the suites pass a factory that records what was armed. */
export interface ControllerOptions {
  createOrder?: (lane: "feed" | "open") => EventOrder;
  /** The time a live frame is stamped with when it arrives. Defaults to `Date.now`. */
  clock?: () => number;
}

type Entry = ActivityEntry | FeedMessage;
/** The payload fields the ingress overwrites and dedupes on. `channel` is the publisher's claim
 *  until the ingress replaces it. */
type Wire = { id?: string; channel?: string };

const ACTIVITY_CAP = 500;
const NOTES_CAP = 50;
/** A target nothing has been typed for. */
const BLANK: Draft = { text: "", outgoing: [] };

export function createController(store: Store<DashboardState>, api: Api, opts: ControllerOptions = {}): Controller {
  const createOrder = opts.createOrder ?? (() => createEventOrder());
  const now = opts.clock ?? Date.now;

  // One machine per bootstrap, re-armed BEFORE its fetch starts, so frames arriving during the fetch
  // are held rather than ordered against a baseline that has not been established yet. The feed's
  // machine exists from the start, so an arrival before the first bootstrap is held too.
  let feedOrder = createOrder("feed");
  let openOrder = createOrder("open");
  /** In-flight bootstrap, so a second caller shares it instead of arming a rival machine. */
  let refreshing: Promise<void> | null = null;
  /** The in-flight channel bootstrap, so a second open of the same channel shares it. */
  let selecting: { key: string; promise: Promise<void> } | null = null;
  /** Only the latest open applies its result. */
  let loadSeq = 0;
  // THE BOOTSTRAP MUST NOT OUTRANK THE LIVE FEED. Every bootstrap read is issued before its value is
  // applied, so a snapshot is at least as old as the moment it was asked for, while a feed event is
  // newer than that. Both `roster` and `membership` events carry a FULL snapshot, so once the feed
  // has spoken for a source, that source's bootstrap value or refusal is stale on arrival and is
  // dropped. What is superseded is the source, not the snapshot: a refusal obeys the same rule.
  const liveApplied = new Set<string>();
  const supersededByFeed = <T>(name: string, apply: (v: T) => void) => (v: T) => { if (!liveApplied.has(name)) apply(v); };
  /** When each source last read successfully, by its stale-mark name, so a refusal can say how old
   *  the data it left on screen is. */
  const lastGood = new Map<string, number>();
  /** Clear the first-read wait for the sources that have now landed. */
  const answered = (roster: boolean, channels: boolean) =>
    store.set((s) => ({ loading: { roster: s.loading.roster && !roster, channels: s.loading.channels && !channels } }));

  /** Gap and prefix notes, newest last. Kept rather than logged: a gap that only reaches the
   *  console is a gap nobody sees. */
  const noteOrder = (notes: OrderNote[]) => {
    if (notes.length) store.set((s) => ({ orderNotes: [...s.orderNotes, ...notes].slice(-NOTES_CAP) }));
  };
  /** Mark ONE source, or clear it, leaving every other source's mark alone. */
  const markStale = (name: string, entry: StaleMark | undefined) =>
    store.set((s) => {
      const rest = s.stale.filter((m) => m.name !== name);
      return { stale: entry ? [...rest, entry] : rest };
    });
  const unreadable = (reason: string) => store.set((s) => ({ membership: { snapshot: s.membership.snapshot, unreadable: reason } }));
  /** Rewrite one target's draft, leaving every other draft alone. */
  const putDraft = (key: string, edit: (d: Draft) => Draft) =>
    store.set((s) => ({ drafts: { ...s.drafts, [key]: edit(s.drafts[key] ?? BLANK) } }));
  /** Numbers each post the composer sends, for its row's key. */
  let posted = 0;
  /** Drop every answered post whose message the page now holds, in Activity, the DMs or the open
   *  channel: its own row draws it from then on. Run after the feed, after a bootstrap and after a
   *  channel load, because a post the feed missed while it was down comes back through a read. */
  const pruneDelivered = () => {
    const s = store.get();
    if (!Object.values(s.drafts).some((d) => d.outgoing.some((o) => o.id !== undefined))) return;
    const held = new Set<string>();
    for (const list of [s.activity, s.dms, s.open?.messages ?? []] as { msg?: { id?: string } }[][])
      for (const e of list) if (e?.msg?.id) held.add(e.msg.id);
    const delivered = (o: Outgoing) => o.id !== undefined && held.has(o.id);
    if (!Object.values(s.drafts).some((d) => d.outgoing.some(delivered))) return;
    store.set((st) => ({ drafts: Object.fromEntries(Object.entries(st.drafts).map(([k, d]) => [k, { ...d, outgoing: d.outgoing.filter((o) => !delivered(o)) }])) }));
  };

  /** Close the open channel. A load still in flight no longer owns the view, so it is superseded. */
  const close = () => {
    loadSeq++;
    selecting = null;
    store.set({ open: null });
  };

  async function open(key: string | null): Promise<void> {
    if (key === null) return close();
    store.set((s) => ({ unread: { ...s.unread, [key]: 0 } }));
    // SINGLE FLIGHT PER CHANNEL, for the reason the feed has one. `refresh()` re-opens the open
    // channel on every poll, so two bootstraps for the SAME channel overlap routinely, and a second
    // arm would orphan the frames the first machine holds.
    if (selecting && selecting.key === key) return selecting.promise;
    const seq = ++loadSeq;
    // HELD, and only when it belongs to THIS channel. A fresh selection must not inherit the last
    // channel's messages, so a switch holds nothing and starts empty.
    const cur = store.get().open;
    const held = cur?.channel === key ? cur.messages : [];
    // ARMED BEFORE THE FETCH IS ISSUED. Held in a LOCAL as well, so this bootstrap settles the
    // machine it armed even if an open of another channel has since rebound `openOrder`.
    const order = createOrder("open");
    openOrder = order;
    let release!: () => void;
    const mine = { key, promise: new Promise<void>((r) => (release = r)) };
    selecting = mine;
    // A REOPEN KEEPS WHAT IS ON SCREEN until its history lands, the keep-last-good rule the refused
    // read already follows. `refresh()` reopens the open channel on every feed open, so clearing
    // here would draw an empty list on each reconnect.
    store.set({ open: { channel: key, messages: held } });
    let msgs: StoredMessage[] = [];
    let refused: string | null = null;
    try {
      // A history row carries no subject, so it has no verified sender: `senderId` stays unset.
      msgs = (await api.history(key, 200)).map((msg) => ({ msg }));
    } catch (err) {
      // A REFUSED READ KEEPS WHAT THE READER ALREADY HAD. The held messages take the place of the
      // history that could not be read, so the merge below is the same as on the successful path.
      refused = err instanceof Error ? err.message : String(err);
      msgs = held;
      noteOrder([{ type: "backfill-failed", channel: key, reason: refused }]);
    } finally {
      // SETTLED ON EVERY PATH, INCLUDING THE STALE ONE. A superseded load must not rebind the view it
      // no longer owns, and it must still drain the machine it armed.
      const settled = order.backfill(msgs as unknown as FeedEntryLike[]);
      if (seq === loadSeq) {
        noteOrder(settled.notes);
        // Chat that arrived live during this fetch is only in the open view, released frames are only
        // in `settled.emit`, and both have to survive. The held rows are still in the view too, and
        // they are what the history replaces: a held row the history no longer has must go, so only
        // the rows added after the hold (by identity) count as live.
        const kept = new Set(held);
        const live = store.get().open?.channel === key ? store.get().open!.messages.filter((m) => !kept.has(m)) : [];
        const merged = settled.emit.slice() as unknown as StoredMessage[];
        const ids = new Set(merged.map((m) => m.msg.id));
        for (const m of live) if (m && !ids.has(m.msg.id)) merged.push(m);
        store.set({ open: { channel: key, messages: merged.slice(-ACTIVITY_CAP) } });
        pruneDelivered();
        // SAID, NOT JUST KEPT. Retention without the mark shows old messages as though they were current.
        const history = `#${key} history`;
        if (!refused) lastGood.set(history, now());
        const lastRead = lastGood.get(history);
        markStale(history, refused ? { kind: "refused", name: history, reason: refused, ...(lastRead === undefined ? {} : { lastRead }) } : undefined);
      }
      if (selecting === mine) selecting = null;
      release();
    }
  }

  async function refresh(): Promise<void> {
    // SINGLE FLIGHT. Arming a machine and settling it are two ends of ONE bootstrap, and the startup
    // calls this twice (once at boot, once when the feed opens). A second arm while the first is
    // fetching would leave the first machine, and what it holds, unreachable.
    if (refreshing) return refreshing;
    let release!: () => void;
    refreshing = new Promise<void>((r) => (release = r));
    feedOrder = createOrder("feed");
    // The batch the settle will use. A refused activity read settles on empty, which is the
    // machine's specified empty-history arm rather than a shortcut.
    let batch: Entry[] = [];
    let activityPage: ActivityPage | null = null;
    try {
      // A FAILED READ KEEPS WHAT IS ON SCREEN. `refreshAll` reads every source concurrently, applies
      // ONLY the ones that succeeded, and returns what did not land.
      const sources = [
        // The operator's id is kept from whichever says it first: this read or a post's answer.
        { name: "space", read: () => api.meta(), apply: (meta: Meta) => store.set((s) => ({ space: meta.space, post: meta.post, operatorId: s.operatorId ?? meta.operatorId ?? null })) },
        // ONCE THE FEED HAS SPOKEN FOR A SOURCE, ITS READ IS NOT MADE AT ALL. Its value would be
        // dropped on arrival (the feed's snapshot is newer than any read), so it would cost a broker
        // call per poll for nothing, and its refusal would still reach the header as a stale mark.
        // Roster and membership are the two sources the feed speaks for.
        ...(liveApplied.has("peers")
          ? []
          : [{ name: "peers", read: () => api.roster(), apply: supersededByFeed("peers", (roster: RosterEntry[]) => store.set({ roster })) }]),
        { name: "channels", read: () => api.channels(), apply: (channels: ChannelInfo[]) => store.set({ channels }) },
        // Like channel history, a DM history row carries no verified sender.
        { name: "direct messages", read: () => api.dms(500), apply: (dms: CotalMessage[]) => store.set({ dms: dms.map((msg) => ({ msg })) }) },
        // Always read: the Activity view and the Needs card both draw it. An envelope, never a bare
        // array, so a caller that ignores `partial` breaks here instead of drawing a short page.
        { name: "activity", read: () => api.activity(200), apply: (p: ActivityPage) => { batch = p.entries; activityPage = p; } },
        // Skipped once the feed has spoken for it, as the roster read is.
        ...(liveApplied.has("membership")
          ? []
          : [{ name: "membership", read: () => api.membership(), apply: supersededByFeed("membership", (m: MembershipSnapshot) => store.set({ membership: { snapshot: m } })) }]),
      ];
      const refused: StaleMark[] = await refreshAll(sources);
      const landedAt = now();
      const landed = new Set(sources.map((s) => s.name).filter((name) => !refused.some((r) => r.name === name)));
      for (const name of landed) lastGood.set(name, landedAt);
      answered(landed.has("peers"), landed.has("channels"));
      // A REFUSAL OF A READ THE FEED HAS SINCE OUTRANKED IS A FACT ABOUT THAT ONE READ. It is neither
      // marked nor allowed to set `unreadable`: the header would call the roster or membership stale,
      // and the pill unreadable, over a feed that is delivering it. The read that was already in
      // flight when the feed spoke lands here; later polls never issue it. `liveApplied` holds only
      // the sources the feed speaks for, so no other refusal is dropped.
      const stale: StaleMark[] = refused.filter((m) => !liveApplied.has(m.name));
      // Each refusal says when its source last landed, which is how old the data it left on screen is.
      for (const m of stale) {
        const at = lastGood.get(m.name);
        if (at !== undefined) m.lastRead = at;
      }
      // A PARTIAL PAGE IS NOT A REFUSAL AND IS NOT SILENCE. Its entries are applied; the reader is
      // told which sources did not answer in time, on the same marker as a refusal, with the counts
      // for its second line and each missing source's reason, one per line, for its tooltip.
      const pg = activityPage as ActivityPage | null;
      if (pg && pg.partial)
        stale.push({
          kind: "partial",
          name: "activity",
          reason: pg.missing.map((m) => `${m}: ${pg.reasons[m]}`).join("\n"),
          read: pg.read,
          of: pg.of,
          missing: pg.missing.slice(),
        });
      const rosterView = store.get().stale.find((s) => s.name === "roster");
      if (rosterView && !stale.some((s) => s.name === "roster")) stale.push(rosterView);
      store.set({ stale });
      const membershipRefused = stale.find((s) => s.name === "membership");
      if (membershipRefused) unreadable(membershipRefused.reason);
      // The order machine's own failure arm keeps its own note: a refused history read is what makes
      // a backfill incomplete. The other sources are carried by the stale marker.
      const backfillRefused = stale.find((s) => s.name === "activity" && s.kind !== "partial");
      if (backfillRefused) noteOrder([{ type: "backfill-failed", reason: backfillRefused.reason }]);
      const openNow = store.get().open;
      if (openNow) void open(openNow.channel);
      // THE SETTLE RUNS IN THE `finally`, ON EVERY EXIT PATH, including a throw from anything between
      // the arm and here. Its first line is the live feed's trust rule: the backfill is tagged with the
      // channel the server derived from the subject, so the payload claim is overwritten at ingress.
    } finally {
      for (const e of batch) if (e?.msg) (e.msg as Wire).channel = (e as { channel?: string }).channel;
      const settled = feedOrder.backfill(batch);
      noteOrder(settled.notes);
      // MERGED, NOT ASSIGNED OVER. Live frames were held and come back in `settled.emit` in seq
      // order; live chat passed straight through and is only in the store. The backfill is the base
      // and unseen live arrivals follow it, newest last, deduped by id.
      const merged = settled.emit.slice() as Entry[];
      const ids = new Set(merged.map((e) => (e?.msg as Wire | undefined)?.id));
      for (const e of store.get().activity) if (e && e.msg && !ids.has(e.msg.id)) merged.push(e);
      store.set({ activity: merged.slice(-ACTIVITY_CAP) });
      pruneDelivered();
      refreshing = null;
      release();
    }
  }

  function onMessage(e: FeedMessage): void {
    const msg = e.msg as Wire;
    // Stamped on arrival, before the order machine can hold the frame, so a held frame keeps the time it came.
    e.arrivedAt = now();
    // TRUST IS DECIDED ONCE, HERE, AND UNCONDITIONALLY. The server sends the channel it took from the
    // SUBJECT, which the publish grant covers; `msg.channel` is the publisher's claim. A guarded
    // overwrite fails open on DMs and anycast, where there is no authoritative channel and the
    // forged one would survive. A non-chat message keeps `undefined`, which is the truth.
    msg.channel = e.channel;
    // ORDERED, NOT JUST DEDUPED. A frame arriving before the backfill it belongs after is held here
    // and released by `backfill()` in seq order; everything else passes through, deduped by id.
    const fed = feedOrder.live(e);
    noteOrder(fed.notes);
    store.set((s) => {
      const activity = s.activity.slice();
      for (const x of fed.emit as Entry[]) {
        if (activity.some((a) => a.msg.id === x.msg.id)) continue;
        activity.push(x);
        if (activity.length > ACTIVITY_CAP) activity.shift();
      }
      // The DM keeps the sender the server read off the subject, which the payload cannot forge.
      const dms = e.mode === "unicast" && !s.dms.some((d) => d.msg.id === msg.id) ? [...s.dms, { msg: e.msg, senderId: e.senderId }] : s.dms;
      return { activity, dms };
    });
    pruneDelivered();
    const channel = msg.channel;
    if (!channel) return;
    // A live message can beat the next channel read. Keep its count; its policy stays unknown until
    // the server supplies the row.
    store.set((s) => {
      const i = s.channels.findIndex((c) => c.channel === channel);
      const channels: ChannelRow[] = s.channels.slice();
      if (i === -1) channels.push({ channel, messages: 1 });
      else channels[i] = { ...channels[i], messages: (channels[i].messages ?? 0) + 1 };
      return { channels };
    });
    if (store.get().open?.channel === channel) {
      // The open channel runs the same race: its history read is issued with the feed already open.
      // Ordered as a stored message, so the verified sender travels with it through the machine.
      const stored: StoredMessage = { msg: e.msg, senderId: e.senderId };
      const sel = openOrder.live(stored as unknown as FeedEntryLike);
      noteOrder(sel.notes);
      store.set((s) => {
        if (s.open?.channel !== channel) return {};
        const messages = s.open.messages.slice();
        for (const m of sel.emit as unknown as StoredMessage[]) {
          messages.push(m);
          if (messages.length > ACTIVITY_CAP) messages.shift();
        }
        return { open: { channel, messages } };
      });
    } else {
      store.set((s) => ({ unread: { ...s.unread, [channel]: (s.unread[channel] ?? 0) + 1 } }));
    }
  }

  return {
    refresh,
    open,
    onRoster(roster) {
      liveApplied.add("peers");
      store.set({ roster });
      answered(true, false);
    },
    onPresenceView(view) {
      // The observer's own watch, not a peer. A stale view keeps the last-known rows and names the
      // roster source stale; it never empties `roster`.
      store.set({ presenceView: view });
      markStale("roster", presenceViewMark(view));
    },
    onMessage,
    onMembership(m) {
      liveApplied.add("membership");
      store.set({ membership: { snapshot: m } });
    },
    onMembershipFailed(reason) {
      liveApplied.add("membership");
      unreadable(reason);
    },
    async deleteChannel(name) {
      if (!name) return;
      // The UI confirms first. A refusal throws, so the dialog can show the server's message.
      await api.deleteChannel(name);
      store.set((s) => ({
        channels: s.channels.filter((c) => c.channel !== name),
        unread: Object.fromEntries(Object.entries(s.unread).filter(([k]) => k !== name)),
        activity: s.activity.filter((e) => (e.msg as Wire).channel !== name),
        // A refused history read of this channel marked it stale; the channel is gone, so the mark goes.
        stale: s.stale.filter((m) => m.name !== `#${name} history`),
      }));
      if (store.get().open?.channel === name) close();
    },
    async send(target, text) {
      const key = composeKey(target);
      // The button is disabled while a post is in flight, so a second one is a defect in the page.
      if ((store.get().drafts[key] ?? BLANK).outgoing.some((o) => o.id === undefined)) throw new Error("a post to this target is already in flight");
      const mine: Outgoing = { seq: ++posted, text, ts: now() };
      putDraft(key, (d) => ({ text: "", outgoing: [...d.outgoing, mine] }));
      let answer: SendAnswer;
      try {
        answer = await api.send(target, text);
      } catch (err) {
        const s = store.get();
        const where = target.kind === "msg" ? `#${target.channel}` : displayNameOf(target.to, nameIndex(s.roster), s.operatorId);
        // THE DRAFT SURVIVES A REFUSAL. What was typed since the send stays after it.
        putDraft(key, (d) => ({ text: d.text ? `${text}\n${d.text}` : text, refused: refusalText(where, err), outgoing: d.outgoing.filter((o) => o !== mine) }));
        throw err;
      }
      store.set((st) => ({
        operatorId: st.operatorId ?? answer.operatorId,
        drafts: {
          ...st.drafts,
          [key]: { ...(st.drafts[key] ?? BLANK), outgoing: (st.drafts[key] ?? BLANK).outgoing.map((o) => (o === mine ? { ...o, id: answer.id } : o)) },
        },
      }));
      // The feed may have delivered the post before the answer came, and then its row shows it.
      pruneDelivered();
    },
    draft(target, text) {
      putDraft(composeKey(target), (d) => ({ text, outgoing: d.outgoing }));
    },
  };
}
