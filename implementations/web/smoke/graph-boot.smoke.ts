/**
 * THE LIVE FEED IS NOT GATED BEHIND THE SLOW BOOTSTRAP READ.
 *
 * The connection pill is driven by ONE thing: the feed opening. The old graph page booted as
 *
 *     load().catch((err) => console.error(err)).then(connect);
 *
 * so the feed was not opened until the ENTIRE bootstrap settled, and that bootstrap reads
 * `/api/activity` and `/api/dms`, both bounded by the aggregation deadline. On a slow link the pill
 * therefore stayed down for the whole load window. Reported from a real deployment observed across
 * a WAN link: "always showing disconnected, and taking long to show the graph".
 *
 * Measured in a real browser, both arms on one link and one corpus (Chrome, a local broker behind
 * 80ms each way, 40 channels with history): chained, the feed's `EventSource` was constructed at
 * t=8050ms; concurrent, at t=62ms, with the pill live at 89ms while the slowest read still ran to
 * 8066ms.
 *
 * WHAT THIS RUNS. `startDashboard` (client/src/state/boot.ts), the boot the client ships, over a
 * fake `openFeed` that records when it was called and a fake `Api` whose reads record when they were
 * issued and are held until a cell releases them. Nothing is restated: a cell over a hand-written
 * copy of the boot would pass whatever the real module did. Order is read off ONE shared event log,
 * so "the feed opened before any read was issued" is a comparison of two positions in it, and no
 * cell measures a wall clock.
 *
 * THE OLD GRAPH PAGE'S SCRIPT TRIPWIRE IS GONE. The page's cell 0.1 pinned the list of `<script>`
 * files the old graph page named, because the old harness executed them in a vm. There are no page scripts
 * any more, so that list has nothing to pin.
 *
 * NOT CARRIED OVER: cells 4.2/4.3 asserted that a unicast naming an unknown recipient does not draw
 * a node on the graph. The node rule belongs to the topology model, which lands in phase 2 and
 * brings that cell with it. What survives here is what the controller owns: the handler survives
 * the message, and the roster, the only source of who exists, is unchanged by it.
 *
 * Run: pnpm smoke:web-graph-boot
 */
import type { FeedHandlers } from "../client/src/api/feed.js";
import type { Api } from "../client/src/state/controller.js";
import { pillState } from "../client/src/lib/membership.js";
import { startDashboard } from "../client/src/state/boot.js";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";
import { bootReads, gate, page, unusedApi } from "./controller-harness.js";

let cells = 0, failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

/** Every event the feed can deliver, by the name of its handler. */
const FEED_EVENTS = ["open", "error", "roster", "presenceView", "membership", "membershipFailed", "message"] as const;

/** "The feed was opened before any bootstrap read was issued", read off a log. Applied to the shipped
 *  boot's log in 1.2 and to a chained boot's log in section 7, so the cell is shown to be able to
 *  tell the two apart. */
const feedFirst = (log: string[]) => log[0] === "openFeed" && log.slice(1).every((e) => e.startsWith("read:"));

/** The pill's clock. Every snapshot below is stamped relative to it. */
const NOW = 1_700_000_000_000;

/** THE STALE BOOTSTRAP IS NOT EMPTY, IT IS OLD. A REST snapshot captured before the live agent
 *  joined still HAS content: an agent that has since gone. An empty-list bootstrap can be beaten by
 *  a defence as narrow as "ignore an empty roster", so a suite built on one proves less than it
 *  reads; an OLDER NON-EMPTY snapshot can only be beaten by ordering. `local.O` is in the
 *  bootstrap and absent from the live roster, and the live roster is a FULL snapshot on every
 *  presence event, so it supersedes rather than merges: `local.O` is gone. */
const STALE_ROSTER = [{ card: { id: "local.O", name: "old", kind: "agent" }, status: "waiting", ts: 1 }] as never;
const STALE_MEMBERS = { asOf: 1, members: [{ id: "local.O", live: ["general"], durable: [], observedAt: 1 }] };
const liveRoster = (id: string, name: string) => [{ card: { id, name, kind: "agent" }, status: "waiting", ts: 2 }] as never;
const liveMembers = { asOf: NOW, members: [{ id: "local.X", live: ["general"], durable: [], observedAt: 1 }] };

/** A FRESH DASHBOARD: its own store, its own feed, its own held reads. A section that needs a
 *  different boot ordering than the section before it cannot reuse a settled one, and one that
 *  quietly did would be asserting about a dashboard whose bootstrap had already applied. */
function newDashboard(opts: { refuseMembershipRead?: boolean } = {}) {
  /** One log for everything that happens, in order: `openFeed`, then each read as it is ISSUED. */
  const log: string[] = [];
  const held = gate<void>();
  const store = createStore<DashboardState>(structuredClone(initialState));
  /** Every read waits for `held`, which models the slow link: nothing answers until a cell lets it. */
  const slow = <T>(name: string, value: () => T) => async (): Promise<T> => {
    log.push(`read:${name}`);
    await held.promise;
    return value();
  };
  const api: Api = {
    meta: slow("meta", () => ({ space: "s", pid: 1 })),
    roster: slow("roster", () => STALE_ROSTER),
    channels: slow("channels", () => []),
    activity: slow("activity", () => page()),
    dms: slow("dms", () => []),
    history: async () => { throw new Error("history not expected in this boot"); },
    membership: slow("membership", () => {
      if (opts.refuseMembershipRead) throw new Error("membership refused with HTTP 503: membership read refused");
      return STALE_MEMBERS;
    }),
    deleteChannel: async () => { throw new Error("deleteChannel not expected in this boot"); },
  };
  let handlers: FeedHandlers | null = null;
  let opened = 0;
  let closed = 0;
  const dash = startDashboard({
    store,
    api,
    openFeed: (h) => {
      opened++;
      log.push("openFeed");
      handlers = h;
      return () => { closed++; };
    },
  });
  const thrown: string[] = [];
  /** Deliver one feed event through the handler the dashboard registered, recording a throw rather
   *  than letting it escape, so "did this break the page" is an assertion and not a crashed suite. */
  const deliver = <K extends keyof FeedHandlers>(kind: K, ...args: Parameters<FeedHandlers[K]>) => {
    try { (handlers![kind] as (...a: unknown[]) => void)(...args); }
    catch (e) { thrown.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  /** Let every held read answer, and wait for the bootstrap to apply. */
  const release = async () => { held.resolve(); await dash.controller.refresh(); };
  const pill = () => pillState(store.get().membership, NOW);
  return { log, store, dash, deliver, release, pill, thrown, stats: () => ({ opened, closed }), registered: () => handlers };
}

async function main() {
  console.log("0. the harness is the boot, not a stand-in for it");
  {
    const d = newDashboard();
    ok("0.1 the boot registered a handler for every feed event, so no delivery below is a silent no-op",
      FEED_EVENTS.every((k) => typeof (d.registered() as unknown as Record<string, unknown>)?.[k] === "function"),
      { registered: Object.keys(d.registered() ?? {}), expected: FEED_EVENTS });
    ok("0.2 the pill reports from the first moment, before any feed event or read: no feed yet reads traffic-only",
      d.pill() === "traffic-only", d.pill());
    await d.release();
  }

  console.log("1. the feed opens without waiting for the bootstrap read");
  const d1 = newDashboard();
  // Nothing has been released: every bootstrap read is still in flight.
  ok("1.1 THE FEED IS OPEN while the bootstrap read is still in flight, so the pill is not stuck at disconnected",
    d1.stats().opened === 1 && d1.log.some((e) => e.startsWith("read:")) && d1.store.get().space === null,
    { log: d1.log, space: d1.store.get().space });
  ok("1.2 and it opened BEFORE any bootstrap read had been issued, not merely early",
    feedFirst(d1.log), d1.log);

  // ── 2. OPENING FIRST MUST NOT BREAK WHAT OPENING LAST PROTECTED ──────────────────────────────
  //
  // Connecting BEFORE the bootstrap means live events can now arrive while the state they write
  // is still empty, which the chained boot made impossible by construction. That is the hazard this
  // order introduces, so it gets a cell rather than a reading of the source: drive a roster, a
  // membership and a message event in while every read is still in flight, and require the
  // dashboard to survive all three.
  console.log("2. a live event that arrives before the bootstrap finishes does not break the dashboard");
  const early = {
    roster: liveRoster("local.X", "aa"),
    membership: liveMembers,
    message: { mode: "chat" as const, channel: "general", msg: { id: "m", ts: 1, from: { id: "local.X", name: "aa" }, parts: [{ kind: "text", text: "hi" }] } as never },
  };
  d1.deliver("roster", early.roster);
  d1.deliver("membership", early.membership);
  d1.deliver("message", early.message);
  ok("2.1 a roster, membership and message event delivered BEFORE any read answered are all survived",
    d1.thrown.length === 0, d1.thrown);
  ok("2.2 and the feed had registered a handler for each of them, so 2.1 is not vacuous",
    (["roster", "membership", "message"] as const).every((k) => typeof (d1.registered() as unknown as Record<string, unknown>)?.[k] === "function"));
  ok("2.3 the reads were still in flight while those events were handled, which is the whole point",
    d1.store.get().space === null && d1.store.get().channels.length === 1 /* only the live message's own row */,
    { space: d1.store.get().space, channels: d1.store.get().channels });
  ok("2.4 the live roster is already the roster, with no read answered", d1.store.get().roster.length === 1, d1.store.get().roster);

  // POSITIVE CONTROL: the arm has to be able to observe a feed that opens at all, or 1.1 would pass
  // vacuously on a boot that never connects. Release the reads and confirm they did land, so the
  // ordering above was a real race and not a dead harness.
  await d1.release();
  ok("1.3 control: the bootstrap reads DID answer, so 1.1 measured a race and not a broken harness",
    d1.store.get().space === "s", d1.store.get().space);
  ok("1.4 control: the feed was opened exactly once, not re-opened per read", d1.stats().opened === 1, d1.stats());
  ok("1.5 control: the six bootstrap reads were each issued once", d1.log.filter((e) => e.startsWith("read:")).length === 6, d1.log);

  // ── 3. EARLY LIVE TRUTH MUST SURVIVE THE LATE BOOTSTRAP ──────────────────────────────────────
  //
  // Surviving the event is not the same as keeping it, and this is the half the first version of
  // this suite missed. `refreshAll` awaits EVERY read and only then applies each one, and the feed
  // and the bootstrap carry a FULL snapshot each. So a snapshot requested BEFORE a live event lands
  // is applied AFTER it and silently wins, unless the boot carries the rule. Opening the feed first
  // is what creates this ordering; the chained boot could not produce it.
  console.log("3. the live snapshot is not overwritten by an older bootstrap snapshot");
  const rosterNames = () => d1.store.get().roster.map((r) => r.card.name);
  ok("3.1 THE AGENT THE FEED ANNOUNCED IS STILL ON THE ROSTER after every bootstrap read has applied",
    rosterNames().includes("aa"), rosterNames());
  // CONTROL: prove the roster takes a live write at all, or 3.1 could pass by never changing
  // anything and never failing for the reason it names.
  d1.deliver("roster", liveRoster("local.Y", "zz"));
  ok("3.2 control: a roster delivered AFTER the bootstrap does apply, so 3.1 tests ordering and not a dead store",
    d1.store.get().roster.map((r) => r.card.name).includes("zz"), d1.store.get().roster.map((r) => r.card.name));
  // MEMBERSHIP IS A SECOND, INDEPENDENT HALF OF THE SAME RULE, and 3.1 is blind to it: with the
  // roster half guarded the roster stays right even when the membership has been wrongly replaced,
  // so a mutation of the membership half SURVIVED until this cell existed. The pill is the right
  // observable because a reverted membership reads exactly like the symptom that started this
  // work: a live feed reported as traffic-only or stale.
  ok("3.3 the membership PILL still reports the live feed, not the older bootstrap's stale snapshot",
    d1.pill() === "live", d1.pill());
  // AND THE RULE IS DROP, NOT MERGE, which 3.1 alone cannot tell apart. The bootstrap here is not
  // empty, it is OLD: it names an agent the live snapshot no longer carries. Since the feed sends
  // the WHOLE roster on every presence event, an agent missing from it is genuinely gone, so an
  // implementation that merged the two snapshots instead of dropping the older one would keep 3.1
  // green and resurrect a departed agent. Read at the same moment as 3.1.
  ok("3.4 and the agent only the STALE bootstrap knew about is not resurrected onto the roster",
    !d1.store.get().roster.some((r) => r.card.name === "old"), d1.store.get().roster.map((r) => r.card.name));
  ok("3.5 and the membership the bootstrap read carried (asOf 1) did not replace the live one",
    d1.store.get().membership.snapshot?.asOf === NOW, d1.store.get().membership);

  // ── 4. A UNICAST NAMING SOMEONE THE ROSTER HAS NEVER SEEN INVENTS NOTHING ────────────────────
  //
  // Opening the feed first lets a message name a recipient before any roster has introduced them,
  // which the chained boot made impossible by construction. The handler must survive it, and the
  // roster, the only source of who exists, must not gain an entry out of a message's own metadata.
  console.log("4. a unicast naming an unknown recipient neither crashes nor invents an agent");
  const ABSENT = "local.UZZ7QK4A5MHTKC3PZWL6RGYD4XN2VJBQF5HSEMR7TW6YUAO3IPCD";
  const rosterBefore = JSON.stringify(d1.store.get().roster);
  const thrownBefore = d1.thrown.length;
  d1.deliver("message", { mode: "unicast", msg: { id: "u", ts: Date.now(),
    from: { id: "local.Y", name: "zz" }, to: ABSENT, parts: [{ kind: "text", text: "hi" }] } as never });
  ok("4.1 the handler survives a recipient no roster has ever introduced", d1.thrown.length === thrownBefore, d1.thrown.slice(thrownBefore));
  ok("4.2 (roster half; the node half returns in phase 2 Task 7) and the unknown recipient did NOT enter the roster", JSON.stringify(d1.store.get().roster) === rosterBefore
    && !d1.store.get().roster.some((r) => r.card.id === ABSENT), d1.store.get().roster);
  // CONTROL: the SAME id, announced by a roster, IS on the roster. So 4.2 goes red when an entry is
  // invented, rather than passing because an id could never have been there in the first place.
  d1.deliver("roster", [{ card: { id: ABSENT, kind: "agent" }, status: "waiting", ts: 1 }] as never);
  ok("4.3 (roster half; the node half returns in phase 2 Task 7) control: that same id, once a roster announces it, IS on the roster",
    d1.store.get().roster.some((r) => r.card.id === ABSENT), d1.store.get().roster);

  // ── 5. THE MEMBERSHIP SOURCE SPEAKS TWICE, AND BOTH SENTENCES OBEY THE ORDERING RULE ─────────
  //
  // `membership` is not one signal. It is a source with TWO live sentences and TWO bootstrap ones:
  // a snapshot, and a REFUSAL. Section 3 covers the snapshot pair, and a rule written onto the
  // snapshot's apply covers exactly that and not a refusal. So both refusals slip past it, in
  // opposite directions, and each puts a false claim into the header pill: the one place this
  // dashboard is asked to say how far to trust what it is showing.
  //
  // Two dashboards, read twice: once the instant the live sentence lands, once after the bootstrap
  // has settled on top of it. The first read of each pair is what makes the second one mean something.
  console.log("5. a membership REFUSAL obeys the same ordering rule as a membership snapshot");
  // 5a: the LIVE sentence is the refusal. The server tells the feed it could not read membership;
  // the membership read was issued BEFORE that and answers after it, and a snapshot clears the
  // refusal, so an older success would erase a newer refusal.
  const liveRefused = newDashboard();
  // 5b: the MIRROR, which is where a one-directional rule always breaks next. The live snapshot is
  // good and the BOOTSTRAP read refuses. Its failure path runs after every read settles, so a
  // dashboard whose feed is delivering membership perfectly well announces that it cannot read
  // membership at all. On the slow link this whole lane is about, that read is the one most likely
  // to refuse.
  const bootRefused = newDashboard({ refuseMembershipRead: true });
  liveRefused.deliver("membershipFailed", "membership read failed");
  bootRefused.deliver("membership", { asOf: NOW, members: [{ id: "local.X", live: ["general"], durable: [], observedAt: 1 }] });
  ok("5.1 the live REFUSAL reaches the pill at once, so 5.2 has something to survive with",
    liveRefused.pill() === "unreadable", liveRefused.pill());
  ok("5.3 the live SNAPSHOT reaches the pill at once, so 5.4 has something to survive with",
    bootRefused.pill() === "live", bootRefused.pill());
  await liveRefused.release();
  await bootRefused.release();
  ok("5.2 AND THE REFUSAL SURVIVES the older successful bootstrap read landing on top of it",
    liveRefused.pill() === "unreadable", liveRefused.pill());
  ok("5.4 AND THE SNAPSHOT SURVIVES the bootstrap read refusing after it, which is a fact about that one read",
    bootRefused.pill() === "live", bootRefused.pill());

  console.log("6. the feed's connection state, its reconnect and its close");
  {
    const d = newDashboard();
    ok("6.0 before the feed first opens the dashboard is connecting, not disconnected", d.store.get().connection === "connecting", d.store.get().connection);
    d.deliver("error");
    ok("6.0b and a failed first attempt is still connecting: nothing has dropped yet", d.store.get().connection === "connecting", d.store.get().connection);
    await d.release();
    const readsBefore = d.log.filter((e) => e === "read:meta").length;
    d.deliver("open");
    ok("6.1 a feed open marks the dashboard connected", d.store.get().connection === "connected", d.store.get().connection);
    // READ BEFORE ANYTHING ELSE CALLS refresh(): the reads are issued synchronously, so the count
    // here is what the open handler itself did, and a later `refresh()` in this cell cannot stand in for it.
    ok("6.2 and runs the bootstrap again, because a reconnect may have missed events",
      d.log.filter((e) => e === "read:meta").length === readsBefore + 1, d.log);
    await d.dash.controller.refresh();
    d.deliver("error");
    ok("6.3 a feed error after an open marks it reconnecting", d.store.get().connection === "reconnecting", d.store.get().connection);
    d.deliver("error");
    ok("6.3b and a second error while it retries is still reconnecting", d.store.get().connection === "reconnecting", d.store.get().connection);
    d.deliver("open");
    const readsAfterReconnect = d.log.filter((e) => e === "read:meta").length;
    await d.dash.controller.refresh();
    ok("6.4 and a reconnect marks it connected again, and reads again",
      d.store.get().connection === "connected" && readsAfterReconnect === readsBefore + 2, { connection: d.store.get().connection, readsAfterReconnect, readsBefore });
    d.dash.stop();
    ok("6.5 stop() closes the feed it opened, once", d.stats().closed === 1, d.stats());
  }

  // CONTROL for 1.2: the chained shape the old page had, `load().then(connect)`, written as a log.
  // The same predicate that passes the shipped boot rejects it, so 1.2 is not a predicate that
  // accepts every order.
  console.log("7. control: the chained boot the old page had is told apart from the shipped one");
  {
    const chained = ["read:meta", "read:roster", "openFeed"];
    ok("7.1 CONTROL: a log where the feed opens AFTER the reads is not feed-first", !feedFirst(chained), chained);
    ok("7.2 CONTROL: a log where the feed is never opened is not feed-first either", !feedFirst(["read:meta"]));
    ok("7.3 CONTROL: and the shipped boot's log is", feedFirst(d1.log), d1.log);
  }

  // `refresh()` does not reject on a refused read (`refreshAll` turns it into a stale mark), so what
  // can reject it is a defect: an `apply` or a store subscriber that throws. The boot calls it
  // without awaiting, so that rejection would be unhandled. It has to be visible instead.
  console.log("8. a refresh that rejects is made visible and is not left unhandled");
  {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    const quiet = () => new Promise<void>((r) => setTimeout(r, 20));
    const boot = (space: string) => {
      const store = createStore<DashboardState>(structuredClone(initialState));
      store.subscribe(() => { if (store.get().space === "boom") throw new Error("a subscriber that throws"); });
      startDashboard({ store, api: { ...unusedApi, ...bootReads, meta: async () => ({ space, pid: 1 }) }, openFeed: () => () => undefined });
    };
    try {
      boot("fine");
      await quiet();
      ok("8.1 CONTROL: a healthy boot logs nothing and rejects nothing", logged.length === 0 && unhandled.length === 0, { logged, unhandled });
      boot("boom");
      await quiet();
      ok("8.2 a refresh that rejects reaches the console, with the defect's own message",
        logged.length >= 1 && logged.some((a) => a.some((x) => x instanceof Error && /a subscriber that throws/.test(x.message))), logged);
      ok("8.3 and is not left as an unhandled rejection", unhandled.length === 0, unhandled.map(String));
    } finally {
      console.error = realError;
      process.off("unhandledRejection", onUnhandled);
    }
  }
}

await main();
console.log(failed === 0 ? `web graph boot: ${cells} cells OK` : `web graph boot: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
