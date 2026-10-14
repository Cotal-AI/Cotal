/**
 * A FAILED POLL MUST NOT EMPTY THE DASHBOARD.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED, against a real `cotal web` observing a local broker behind
 * a 160ms-RTT, 128 KiB/s link, with 40 channels, 12000 chat messages, 2000 DMs and 5 live peers:
 * `/api/activity?limit=100` answered 500 `{"error":"timeout"}` after 15.94s. `/graph` then threw
 * `TypeError: chans is not iterable` out of its bootstrap, showed no peers and no channel hubs, and
 * sat at `disconnected` forever because `connect()` ran only as `load().then(connect)`. `/` threw
 * `Uncaught TypeError: activity is not iterable` fifteen times in twenty-five seconds.
 *
 * BOTH ARE ONE BUG WITH TWO ENDINGS, and it is not "the page mishandles an error". `fetch()` does
 * NOT reject on a 500, and this server's 500 body is `{"error": "..."}`, which is valid JSON. So
 * `fetch(u).then((r) => r.json())` RESOLVES, with the refusal, and the page stores it as the
 * snapshot. Nothing on either page ever consulted `r.status`, so the only fact that separated a
 * refusal from data never reached the code, and the `.catch(() => [])` guards that look like they
 * cover it never fired: there was nothing to catch.
 *
 * SO TWO RULES, AND THE ORDER IS THE FIX. A non-200 becomes a THROW that names its condition; a
 * throwing read leaves the value the page already holds alone and is reported STALE. Either alone is
 * not enough: the status check without retention converts a silent corruption into a visible wipe,
 * and retention without the status check keeps nothing, because the refusal was never a failure.
 *
 * WHAT THIS SUITE DRIVES. `client/src/lib/snapshot.ts` is imported as the client bundle imports it,
 * and the dashboard controller (`client/src/state/controller.ts`), which reads every source through
 * it, is built over a fake `Api` and driven through its methods (§3.6, §4, §5). Nothing is restated.
 * The boot and the HTTP gate are driven the same way: `startDashboard` (`state/boot.ts`) and
 * `httpApi` (`api/http.ts`) are imported, so §3.7, §3.9, §3.11 and §5.3 read what ships. What the
 * stale line and the document title SAY is driven (`staleView` and `documentTitle` in
 * `client/src/lib/shellText.ts`, §3.12 and §5.5 to §5.5d); that the shell draws them is read off
 * `client/src/App.tsx` (§3.3 to §3.5, §5.10).
 *
 * WHAT IT DOES NOT CLAIM. No DOM and no browser: it measures the state transition and its seam, not
 * the pixels. That both page scripts REACH this module is asserted structurally (§3) rather than by
 * executing them here. `event-order`, `channel-authority` and `membership-refusal` each drive the
 * shipped `refresh()` / boot source through this file, which is where that reachability is executed.
 *
 * Run: pnpm smoke:web-snapshot
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, refreshAll, staleLabel, type Source, type StaleMark } from "../client/src/lib/snapshot.js";
import { documentTitle, staleView } from "../client/src/lib/shellText.js";
import type { CotalMessage } from "../client/src/api/types.js";
import { httpApi } from "../client/src/api/http.js";
import type { Api } from "../client/src/state/controller.js";
import { startDashboard } from "../client/src/state/boot.js";
import { createStore } from "../client/src/state/store.js";
import { initialState } from "../client/src/state/types.js";
import { bootReads, gate, harness, page } from "./controller-harness.js";

const here = dirname(fileURLToPath(import.meta.url));

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

const SNAP = { readJson, refreshAll, staleLabel };
ok("0.2 the module exports its three entry points", typeof readJson === "function" && typeof refreshAll === "function" && typeof staleLabel === "function");

/** A response carrying only the three members `readJson` reads, typed as the `Response` it accepts. */
const res = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
    return body;
  },
}) as unknown as Response;

// ── 1. A REFUSAL IS NOT DATA ────────────────────────────────────────────────────────────────────
// The exact body the dashboard's own 500 handler writes. It PARSES, which is the whole reason the
// shipped pages could not tell it from a snapshot.
{
  let threw: Error | undefined;
  try { await SNAP.readJson(res(500, { error: "timeout" }), "activity"); } catch (e) { threw = e as Error; }
  ok("1.1 a 500 whose body is valid JSON is a REFUSAL, not a value", threw !== undefined);
  ok("1.2 the refusal names the source and the status", Boolean(threw && /activity/.test(threw.message) && /500/.test(threw.message)), threw?.message);
  ok("1.3 and carries the server's own error text, so a caller that only logs it still says something true",
    Boolean(threw && /timeout/.test(threw.message)), threw?.message);

  let threw503: Error | undefined;
  try { await SNAP.readJson(res(503, undefined), "membership"); } catch (e) { threw503 = e as Error; }
  ok("1.4 a refusal whose body is NOT JSON still refuses (the status is the fact that matters)",
    Boolean(threw503 && /membership/.test(threw503.message) && /503/.test(threw503.message)), threw503?.message);

  // POSITIVE CONTROL. Without it, 1.1 would also pass against a `readJson` that refuses everything.
  const value = await SNAP.readJson(res(200, [{ channel: "general" }]), "channels");
  ok("1.5 CONTROL: a 200 is parsed and returned", Array.isArray(value) && (value as unknown[]).length === 1, value);
}

// ── 2. A REFUSED READ LEAVES WHAT IS ON SCREEN ALONE ────────────────────────────────────────────
{
  const held = { peers: ["alice", "bob"], channels: ["general"] };
  const applied: string[] = [];
  const stale = await SNAP.refreshAll([
    {
      name: "peers",
      read: async () => { throw new Error("peers refused with HTTP 500: timeout"); },
      apply: (v) => { applied.push("peers"); held.peers = v as string[]; },
    },
    {
      name: "channels",
      read: async () => ["general", "incidents"],
      apply: (v) => { applied.push("channels"); held.channels = v as string[]; },
    },
  ]);
  ok("2.1 a refused source's apply is NEVER called, so its last good value cannot be overwritten",
    applied.includes("peers") === false, applied);
  ok("2.2 and the value the page already held is byte-identical afterwards",
    JSON.stringify(held.peers) === JSON.stringify(["alice", "bob"]), held.peers);
  ok("2.3 the refusal is REPORTED, by source name", stale.length === 1 && stale[0].name === "peers", stale);
  ok("2.4 and the report carries the reason, not just the fact", /HTTP 500: timeout/.test(stale[0]?.reason ?? ""), stale[0]?.reason);
  // The other direction, in the same run: one source refusing must not hold back a source that worked.
  ok("2.5 a SIBLING that succeeded still lands while another source is refusing", applied.includes("channels"), applied);
  ok("2.6 and its value is the one that was read", JSON.stringify(held.channels) === JSON.stringify(["general", "incidents"]), held.channels);
}
// CONTROL: the same harness with nothing refusing. Without it, 2.1 could be passing because this
// harness never applies anything at all.
{
  const applied: string[] = [];
  const stale = await SNAP.refreshAll([
    { name: "peers", read: async () => ["alice"], apply: () => applied.push("peers") },
    { name: "channels", read: async () => [], apply: () => applied.push("channels") },
  ]);
  ok("2.7 CONTROL: with nothing refusing, every source is applied", applied.length === 2, applied);
  ok("2.8 CONTROL: and nothing is reported stale", stale.length === 0, stale);
}
// EVERY source refusing is the case the graph page hit, where three of six reads failed at once.
{
  const applied: string[] = [];
  const stale = await SNAP.refreshAll([
    { name: "peers", read: async () => { throw new Error("a"); }, apply: () => applied.push("peers") },
    { name: "channels", read: async () => { throw new Error("b"); }, apply: () => applied.push("channels") },
  ]);
  ok("2.9 with EVERY source refusing, nothing is applied and the whole set is reported", applied.length === 0 && stale.length === 2, { applied, stale });
  ok("2.10 refreshAll RESOLVES rather than rejecting, so a caller cannot be skipped by one bad read",
    Array.isArray(stale));
}
// Concurrency, asserted on a COUNT rather than on a duration: every read is entered before any of
// them is allowed to finish. The assertion is `entered === 3`, so nothing here measures the speed of
// the machine the suite runs on.
//
// THE BOUNDED WAIT IS LOAD-BEARING AND WAS EARNED. Waiting on the gate alone made a sequential
// implementation HANG instead of fail: the gate opens on the third entry, which a sequential chain
// never reaches, so the mutation proving this cell exited 13 with no assertion printed. A hang is
// not a red anyone can read. The race bounds the wait, and the release below lets both the correct
// and the broken implementation finish so the suite reports rather than stalls.
{
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mk = (name: string): Source<unknown> => ({
    name,
    read: async () => { entered++; if (entered === 3) release(); await gate; return name; },
    apply: () => {},
  });
  const p = SNAP.refreshAll([mk("a"), mk("b"), mk("c")]);
  await Promise.race([gate, new Promise((r) => setTimeout(r, 500))]);
  ok("2.11 all three reads are in flight together (a sequential chain could not enter the third)", entered === 3, entered);
  release();
  await p;
}
// A thrown non-Error must still produce a readable reason; the reason is rendered to a human.
{
  const stale = await SNAP.refreshAll([{ name: "peers", read: async () => { throw "plain string"; }, apply: () => {} }]);
  ok("2.12 a non-Error refusal still reports a readable reason", stale[0]?.reason === "plain string", stale);
}

// ── 3. THE LABEL, AND THE WIRING ────────────────────────────────────────────────────────────────
{
  ok("3.1 nothing stale renders no label at all", SNAP.staleLabel([]) === "");
  ok("3.2 a stale set NAMES its sources", SNAP.staleLabel([{ kind: "refused", name: "peers", reason: "x" }, { kind: "refused", name: "activity", reason: "y" }]) === "stale: peers, activity",
    SNAP.staleLabel([{ kind: "refused", name: "peers", reason: "x" }, { kind: "refused", name: "activity", reason: "y" }]));
}
/** CODE ONLY. These pages document the defect they fixed by quoting the shape that caused it, so a
 *  scan over raw source matches the comment describing the bug and reports the bug as present. That
 *  is not a hypothetical: every one of the three structural cells below failed on its own file's
 *  prose before this existed. Comments are removed first, and the control at 3.10 proves the scan
 *  still finds the shape in code. */
const codeOnly = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

{
  const appSrc = readFileSync(join(here, "..", "client", "src", "App.tsx"), "utf8");
  ok("3.3 the shell draws its stale line through staleView, which says what staleLabel says",
    /\bstaleView\(/.test(appSrc) && staleView([{ kind: "refused", name: "peers", reason: "x" }]).text === staleLabel([{ kind: "refused", name: "peers", reason: "x" }]));
  ok("3.4 and the marks it draws are the store's, which the controller writes",
    /useStore\(store, \(s\) => s\.stale\)/.test(appSrc));
  ok("3.5 the shell carries the stale marker element it drives: hidden, tooltip and text all come from the view",
    /id="stale"/.test(appSrc) && /hidden=\{view\.hidden\}/.test(appSrc) && /title=\{view\.title\}/.test(appSrc) && /\{view\.text\}/.test(appSrc));
  // The boot reads every source through the controller, and the controller through `refreshAll`:
  // `startDashboard` holds no read of its own, and `httpApi` wraps every route in `readJson` (each
  // route is driven in `smoke:web-http-api`). What is asserted here is the wiring between them.
  const bootJs = codeOnly(readFileSync(join(here, "..", "client", "src", "state", "boot.ts"), "utf8"));
  const httpJs = codeOnly(readFileSync(join(here, "..", "client", "src", "api", "http.ts"), "utf8"));
  const feedJs = codeOnly(readFileSync(join(here, "..", "client", "src", "api", "feed.ts"), "utf8"));
  const ctlSrc = codeOnly(readFileSync(join(here, "..", "client", "src", "state", "controller.ts"), "utf8"));
  ok("3.7 the boot reads every source through the controller's refresh(), which reads them through refreshAll",
    bootJs.includes("controller.refresh()") && ctlSrc.includes("refreshAll(") && !/\bfetch\s*\(/.test(bootJs),
    { boot: bootJs.includes("controller.refresh()"), refreshAll: ctlSrc.includes("refreshAll("), fetch: /\bfetch\s*\(/.test(bootJs) });
  // The shape that caused the wipe, in the files that had it: a response body consumed with no
  // status check. A survivor here is a poll that can still store a refusal as data.
  // BALANCED ARGUMENTS, NOT "ANYTHING BUT A PAREN", and the difference was a live wipe. The first
  // cut spelled the fetch argument `[^)]*`, so the class ended at the FIRST `)` in the URL. Every
  // route this scan actually has to police is built with `encodeURIComponent(key)`, whose own `)`
  // sits inside that argument, so the pattern died there and reported zero on the one unguarded read
  // on either page: the selected channel's history. The guard was green because it could not see the
  // shape it exists to forbid. Two nesting levels are enough for every call form in these files, and
  // 3.10c/3.10d execute that rather than asserting it.
  const ARGS = String.raw`\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`;
  // AND WHITESPACE BEFORE `.then`, which is the second time this pattern was green over a live
  // survivor. The console page booted its space name with the fetch on one line and its `.then` on
  // the next, so the class could not reach it: a 500 whose body is JSON resolved as data and the
  // header read `· undefined` for the rest of the session. 3.10e executes the two-line form.
  const rawJson = new RegExp(`fetch${ARGS}\\s*\\)\\s*\\.json\\(\\)|fetch${ARGS}\\s*\\.then\\(\\s*\\(?r\\)?\\s*=>\\s*r\\.json\\(\\)`, "g");
  // The console page's reads are the controller's now, and it holds no `fetch` at all: every read
  // goes through the injected `Api`. That is all this cell proves, and it is true by design, so it
  // does not guard the status check. The HTTP status gate is `api/http.ts`'s, and
  // `smoke:web-http-api` drives httpApi(fakeFetch) for every route, with mutations that drop readJson.
  const controllerJs = codeOnly(readFileSync(join(here, "..", "client", "src", "state", "controller.ts"), "utf8"));
  ok("3.8 the controller holds no fetch; every read goes through the injected Api",
    !/\bfetch\s*\(/.test(controllerJs) && (controllerJs.match(rawJson) ?? []).length === 0, controllerJs.match(rawJson));
  // `http.ts` makes its requests through `fetchImpl`, so the fetch-shaped pattern below cannot match
  // it. What is true of it, and what this cell asserts, is that it consumes no body of its own: every
  // response goes to `readJson`, which is the status gate. `feed.ts` and `boot.ts` make no request.
  ok("3.9 http.ts consumes no response body itself (every read goes through readJson), and feed.ts and boot.ts hold no fetch",
    !/\.json\s*\(/.test(httpJs) && /\breadJson\b/.test(httpJs) && [feedJs, bootJs].every((src) => !/\bfetch\s*\(/.test(src) && (src.match(rawJson) ?? []).length === 0),
    { httpJson: httpJs.match(/\.json\s*\(/), feed: feedJs.match(rawJson), boot: bootJs.match(rawJson) });
  // CONTROL for 3.8: the pattern must be able to find the shape it is looking for.
  ok("3.10 CONTROL: that pattern DOES match the shape it forbids",
    ('const x = await (await fetch("/api/roster")).json();'.match(rawJson) ?? []).length === 1);
  ok("3.10b CONTROL: and the comment stripper does not eat code (a scan over an empty string finds nothing)",
    codeOnly('a(); // fetch(x).json()\nconst u = "http://x";').includes("a();") && !codeOnly('a(); // fetch(x).json()').includes("fetch"));
  // THE CONTROL THAT WAS MISSING, and its absence is why this suite reported a clean page while the
  // selected channel's history read was still consuming a 500 body. The forbidden shape written with
  // a CALL inside the fetch argument is the shape the real code uses.
  ok("3.10c CONTROL: the pattern sees the shape when the URL contains a nested call (the disarm that hid a real wipe)",
    ("const x = await (await fetch(`/api/channels/${encodeURIComponent(key)}/history?limit=200`)).json();".match(rawJson) ?? []).length === 1);
  ok("3.10d CONTROL: and when that nesting is two deep",
    ("const x = await (await fetch(`/a/${enc(f(k))}/b`)).json();".match(rawJson) ?? []).length === 1);
  ok("3.10e CONTROL: the pattern sees a fetch whose `.then` is on the NEXT line (the shape that hid the space-name read)",
    ('fetch("/api/meta")\n    .then((r) => r.json())'.match(rawJson) ?? []).length === 1);
  // The boot must not be able to skip OR DELAY the live feed. This cell used to REQUIRE
  // `load().catch(...).then(connect)`, the shape that guaranteed `connect` would RUN. The boot now
  // opens the feed FIRST, which guarantees it runs SOON as well, so the property is what is
  // asserted, and it is DRIVEN: `startDashboard` over a fake `openFeed` and an `Api` whose reads are
  // held. The feed is open while every read is still in flight, and the boot's source chains it
  // behind the bootstrap in no spelling.
  type BootDeps = Parameters<typeof startDashboard>[0];
  /** Run `boot` over a feed that counts its opens and reads that are held, and report what is true
   *  while every read is still in flight. */
  const whileReadsInFlight = async (boot: (deps: BootDeps) => { controller: { refresh(): Promise<void> } }) => {
    const held = gate<void>();
    let opened = 0;
    const slow = <T>(v: T) => async () => { await held.promise; return v; };
    const dash = boot({
      store: createStore(structuredClone(initialState)),
      api: { ...bootReads, roster: slow([]), channels: slow([]), dms: slow([]), activity: slow(page()) } as unknown as Api,
      openFeed: () => { opened++; return () => undefined; },
    });
    const openedWhileHeld = opened;
    held.resolve();
    await dash.controller.refresh();
    return { openedWhileHeld, openedAfter: opened };
  };
  const shipped = await whileReadsInFlight(startDashboard);
  ok("3.11 the boot opens the live feed WITHOUT waiting for the bootstrap (the wipe was `load().then(connect)`)",
    shipped.openedWhileHeld === 1 && !/\.then\(\s*\(\)\s*=>[^)]*openFeed/.test(bootJs), { shipped });
  // CONTROL for 3.11: the old shape, written out over the same recorder, is something the cell can see.
  // It opens the feed only once the bootstrap has settled.
  const chained = await whileReadsInFlight((deps) => {
    const { controller } = startDashboard({ ...deps, openFeed: () => () => undefined });
    void controller.refresh().then(() => deps.openFeed({} as never));
    return { controller };
  });
  ok("3.11b CONTROL: a boot that chains the feed behind the bootstrap has NOT opened it while the reads are in flight",
    chained.openedWhileHeld === 0, chained);
  ok("3.11c CONTROL: and the source pattern 3.11 forbids matches the shape it names",
    /\.then\(\s*\(\)\s*=>[^)]*openFeed/.test("void controller.refresh().then(() => { stopFeed = deps.openFeed(handlers); });"));
}

// -- 3.12 WHAT THE STALE LINE SAYS ----------------------------------------------------------------
// The line is a function of the marks and nothing else, so it is driven here in Node. It names every
// source with its reason in the tooltip, and a recovered poll leaves nothing behind (the old W12).
{
  const marks: StaleMark[] = [
    { kind: "refused", name: "peers", reason: "peers refused with HTTP 500: timeout" },
    { kind: "partial", name: "activity", reason: "1 of 2 sources answered within 8000ms" },
  ];
  const view = staleView(marks);
  ok("3.12 the line is shown and names every stale source", !view.hidden && /peers/.test(view.text) && /activity/.test(view.text), view);
  ok("3.12b and its tooltip carries each source's reason, one per line",
    view.title === "peers: peers refused with HTTP 500: timeout\nactivity: 1 of 2 sources answered within 8000ms", view.title);
  ok("3.12c and it is the same words as the label, which 3.1 to 3.2 pin", view.text === staleLabel(marks), view.text);
  // THE OLD W12, against the helper. Recovery has to ERASE the claim, not park it: hidden text and a
  // hidden tooltip come back the moment anything unhides the element, naming a source that recovered.
  const recovered = staleView([]);
  ok("3.12d recovery hides the line", recovered.hidden === true, recovered);
  ok("3.12e and CLEARS its label rather than only hiding it", recovered.text === "", recovered);
  ok("3.12f and its tooltip", recovered.title === "", recovered);
}

// The console page's poll is the controller's `refresh()`. Every one of its six sources refusing at
// once is the case the graph page hit: each is named, none is applied, and what was on screen stays.
{
  const refuse = (what: string) => async (): Promise<never> => { throw new Error(`${what} refused with HTTP 500: timeout`); };
  const all = harness({
    meta: refuse("space"), roster: refuse("peers"), channels: refuse("channels"),
    dms: refuse("direct messages"), activity: refuse("activity"), membership: refuse("membership"),
  });
  const held = [{ card: { id: "local.a", name: "a", kind: "agent" }, status: "idle", ts: 1 }] as never;
  all.store.set({ roster: held });
  const before = JSON.stringify(all.store.get().roster);
  await all.ctl.refresh();
  const names = all.store.get().stale.map((m) => m.name).sort();
  ok("3.6 the console page reads every source through it",
    JSON.stringify(names) === JSON.stringify(["activity", "channels", "direct messages", "membership", "peers", "space"])
      && JSON.stringify(all.store.get().roster) === before && all.store.get().space === null,
    { names, roster: all.store.get().roster });
}

// -- 4. THE OPEN CHANNEL'S HISTORY, DRIVEN ------------------------------------------------------
// The read behind the OPEN channel, which the structural cells above missed for as long as their
// pattern could not see a nested paren. It is not on the poll's source table, because `refresh()`
// reaches it indirectly: it re-opens the open channel on every poll, and `open()` clears the view
// before it reads. So on a link where this read keeps being refused, the channel the reader is
// looking at emptied once per poll.
//
// Measured on the old page before the fix, driving its `select()` against a 500 whose body is
// `{"error":"timeout"}`: the open channel ended `[]`, the last good message was gone, and NO
// backfill-failed note was raised, because a 500 does not reject and the catch never ran. The same
// stimulus as a THROW did raise the note. That gap between the two endings is the whole defect.
//
// These cells run the SHIPPED controller over a fake `Api`. A 500 reaches it as the throw `readJson`
// raises for one, so both endings are a rejected `history()` with a different message.
{
  type Msg = { id: string; seq: number };
  const msgs = (ms: Msg[]) => ms as unknown as CotalMessage[];
  const good = (ms: Msg[]) => async () => msgs(ms);
  const refuse500 = async (): Promise<never> => { throw new Error("#team.backend history refused with HTTP 500: timeout"); };
  const throws = async (): Promise<never> => { throw new Error("network down"); };
  const ids = (h: ReturnType<typeof harness>) => (h.store.get().open?.messages ?? []).map((m) => m.id);
  const label = (h: ReturnType<typeof harness>) => staleLabel(h.store.get().stale);
  /** One controller whose history read is whatever `next` currently says. */
  const channelPage = () => {
    let next: Api["history"] = good([]);
    const h = harness({ history: (c, n) => next(c, n) });
    return { h, set: (f: Api["history"]) => { next = f; } };
  };

  // A 500 WITH A JSON BODY, on the channel the reader is already looking at.
  {
    const { h, set } = channelPage();
    set(good([{ id: "m1", seq: 1 }]));
    await h.ctl.open("team.backend");
    const afterGood = ids(h);
    set(refuse500);
    await h.ctl.open("team.backend");
    ok("4.2 a good read puts the channel's history on screen", JSON.stringify(afterGood) === JSON.stringify(["m1"]), afterGood);
    ok("4.3 a REFUSED read (HTTP 500, JSON body) KEEPS it, which is the wipe this closes", ids(h).includes("m1"), ids(h));
    ok("4.4 and the refusal is SURFACED as a backfill failure, not swallowed",
      h.store.get().orderNotes.some((n) => n.type === "backfill-failed"), h.store.get().orderNotes);
    ok("4.5 and the marker NAMES the channel whose history is stale", label(h).includes("team.backend"), label(h));
  }
  // CONTROL: the throwing ending must behave the same. Before the fix these two diverged, and that
  // divergence is exactly what a status gate removes.
  {
    const { h, set } = channelPage();
    set(good([{ id: "m1", seq: 1 }]));
    await h.ctl.open("team.backend");
    set(throws);
    await h.ctl.open("team.backend");
    ok("4.6 CONTROL: a THROWN refusal keeps it too, so the two endings agree",
      ids(h).includes("m1") && h.store.get().orderNotes.some((n) => n.type === "backfill-failed"),
      { msgs: ids(h), notes: h.store.get().orderNotes });
  }
  // THE HAZARD RETENTION CREATES, executed rather than reasoned: keeping the last good messages must
  // never show one channel's history under another channel's name.
  {
    const { h, set } = channelPage();
    set(good([{ id: "a1", seq: 1 }]));
    await h.ctl.open("chan.A");
    set(refuse500);
    await h.ctl.open("chan.B");
    ok("4.7 a refused read on a DIFFERENT channel inherits nothing (retention is per channel)", !ids(h).includes("a1"), ids(h));
  }
  // RECOVERY: the next read that lands replaces the data and clears THIS channel's mark.
  {
    const { h, set } = channelPage();
    set(good([{ id: "m1", seq: 1 }]));
    await h.ctl.open("team.backend");
    set(refuse500);
    await h.ctl.open("team.backend");
    const markedWhileRefused = label(h).includes("team.backend");
    set(good([{ id: "m2", seq: 2 }]));
    await h.ctl.open("team.backend");
    ok("4.8 the mark is up while the read is refused", markedWhileRefused, label(h));
    ok("4.9 and a read that lands clears it", !label(h).includes("team.backend"), label(h));
    ok("4.10 and replaces the data rather than merging the stale copy forward", ids(h).includes("m2"), ids(h));
  }
  // ONE SOURCE'S MARK MUST NOT ERASE ANOTHER'S. `refresh()` marks the polled sources, then re-opens
  // the open channel, which marks one more. A whole-set write in either place drops the other's findings.
  {
    const h = harness({ ...bootReads, roster: async () => { throw new Error("boom"); }, history: refuse500 });
    await h.ctl.refresh();
    await h.ctl.open("team.backend");
    ok("4.11 a refused channel history does not erase the poll's other marks",
      label(h).includes("peers") && label(h).includes("team.backend"), label(h));
  }
}

// THE SPACE NAME IS A SOURCE, NOT A ONE-SHOT, and this section exists because the structural guard
// above was green while it was neither. It was read at boot with a bare fetch whose `.then` sat on
// the next line, so a 500 with a JSON body arrived as data and the header showed `· undefined` with
// no later poll to correct it. The controller reads it on every poll through `refreshAll`, and the
// header and the document title are both drawn from `space`, so `space` is what is graded.
//
// THE TITLE IS DRAWN FROM `space`, so a refusal that leaves `space` alone leaves the title alone.
// What the title says is `documentTitle` (`client/src/lib/shellText.ts`), driven below (5.5 to 5.5d);
// that the shell sets it is read off `App.tsx` (5.10).
{
  // The gate itself lives where the read is made, which is `httpApi`: a 500 whose body is JSON on
  // `/api/meta` must reach the caller as a refusal naming the read, never as a value. Driven here
  // for the space; every route is driven in `smoke:web-http-api`.
  {
    const refused = (async () => ({ ok: false, status: 500, json: async () => ({ error: "the space could not be read" }) })) as unknown as typeof fetch;
    let threw: Error | undefined;
    let value: unknown;
    try { value = await httpApi(refused).meta(); } catch (e) { threw = e as Error; }
    ok("5.3 and it reads through the gate rather than consuming the body directly",
      threw !== undefined && /space refused with HTTP 500: the space could not be read/.test(threw.message) && value === undefined,
      { threw: threw?.message, value });
  }

  let meta: Api["meta"] = async () => ({ space: "cotal-main", pid: 1 });
  let reads = 0;
  const h = harness({ ...bootReads, meta: () => { reads++; return meta(); } });
  await h.ctl.refresh();
  ok("5.1 the controller reads the space as one of its sources", reads === 1 && h.store.get().space === "cotal-main",
    { reads, space: h.store.get().space });
  {
    meta = async () => { throw new Error("space refused with HTTP 500: the space could not be read: timeout"); };
    await h.ctl.refresh();
    const stale = h.store.get().stale;
    ok("5.4 a 500 whose body is JSON does NOT become the space name", h.store.get().space === "cotal-main", h.store.get().space);
    ok("5.6 and the refusal is REPORTED, by source name", stale.length === 1 && stale[0].name === "space", stale);
    ok("5.7 carrying the server's own reason", stale[0]?.reason?.includes("the space could not be read"), stale[0]?.reason);
  }
  {
    meta = async () => ({ space: "cotal-next", pid: 1 });
    await h.ctl.refresh();
    ok("5.8 CONTROL: a read that LANDS replaces the name, so 5.4 is retention and not a stub",
      h.store.get().space === "cotal-next" && h.store.get().stale.length === 0,
      { space: h.store.get().space, stale: h.store.get().stale });
  }
  // THE OLD 5.5: "NOR THE DOCUMENT TITLE". A refusal must not change it, and in particular must not
  // write `Cotal · undefined`, which is what the page did when it consumed the 500 body as the space.
  {
    const landed = harness({ ...bootReads, meta: async () => ({ space: "cotal-main", pid: 1 }) });
    await landed.ctl.refresh();
    const before = documentTitle(landed.store.get().space);
    const failing = harness({ ...bootReads, meta: async () => { throw new Error("space refused with HTTP 500: timeout"); } });
    await failing.ctl.refresh();
    ok("5.5 a refused space read does not change the document title", before === "Cotal \u00b7 cotal-main" && !/undefined/.test(documentTitle(failing.store.get().space)),
      { before, after: documentTitle(failing.store.get().space) });
    // The same controller, first landing and then refusing, so the title is the LAST GOOD one.
    let meta: Api["meta"] = async () => ({ space: "cotal-main", pid: 1 });
    const both = harness({ ...bootReads, meta: () => meta() });
    await both.ctl.refresh();
    meta = async () => { throw new Error("space refused with HTTP 500: timeout"); };
    await both.ctl.refresh();
    ok("5.5b and one that landed first keeps the last good title through the refusal",
      documentTitle(both.store.get().space) === "Cotal \u00b7 cotal-main", documentTitle(both.store.get().space));
  }
  ok("5.5c before any read lands the title is the bare name, not `Cotal \u00b7 null`", documentTitle(null) === "Cotal", documentTitle(null));
  ok("5.5d CONTROL: a space the wire named is in the title", documentTitle("cotal-next") === "Cotal \u00b7 cotal-next", documentTitle("cotal-next"));
  {
    const appSrc = readFileSync(join(here, "..", "client", "src", "App.tsx"), "utf8");
    ok("5.10 the shell sets document.title from the store's space through documentTitle",
      /document\.title = documentTitle\(space\)/.test(appSrc) && /useStore\(store, \(s\) => s\.space\)/.test(appSrc));
  }
}


// -- 6. THE BOOTSTRAP MUST NOT OUTRANK THE LIVE FEED ----------------------------------------------
// Every bootstrap read is ISSUED before its value is applied, so a snapshot is at least as old as the
// moment the page asked for it, while a feed event is newer than that. The feed opens first, so a
// live `roster` or `membership` can land while those reads are in flight, and applying the older
// read afterwards would silently revert it. What is superseded is the SOURCE: a refusal obeys the
// same rule as a snapshot, in both directions.
{
  const amy = [{ card: { id: "local.amy", name: "amy", kind: "agent" }, status: "working", ts: 2 }] as never;
  const stale = [{ card: { id: "local.old", name: "old", kind: "agent" }, status: "idle", ts: 1 }] as never;
  {
    const g = gate<never>();
    const h = harness({ ...bootReads, roster: () => g.promise });
    const p = h.ctl.refresh();
    h.ctl.onRoster(amy);
    g.resolve(stale);
    await p;
    ok("6.1 a roster event that lands before the bootstrap roster read resolves wins",
      JSON.stringify(h.store.get().roster) === JSON.stringify(amy), h.store.get().roster);
  }
  {
    const h = harness({ ...bootReads, roster: async () => stale });
    await h.ctl.refresh();
    ok("6.2 CONTROL: with no live event the bootstrap roster applies", JSON.stringify(h.store.get().roster) === JSON.stringify(stale), h.store.get().roster);
  }
  {
    const g = gate<never>();
    const h = harness({ ...bootReads, membership: () => g.promise });
    const p = h.ctl.refresh();
    h.ctl.onMembership({ asOf: 5, members: [] });
    g.reject(new Error("membership refused with HTTP 503: membership-read-failed"));
    await p;
    ok("6.3 a live membership snapshot outranks a bootstrap refusal that lands after it",
      h.store.get().membership.unreadable === undefined && h.store.get().membership.snapshot?.asOf === 5, h.store.get().membership);
  }
  {
    const g = gate<never>();
    const h = harness({ ...bootReads, membership: () => g.promise });
    const p = h.ctl.refresh();
    h.ctl.onMembershipFailed("membership read timed out");
    g.resolve({ asOf: 1, members: [] } as never);
    await p;
    ok("6.4 a live membership refusal outranks a bootstrap snapshot that lands after it",
      h.store.get().membership.unreadable === "membership read timed out" && h.store.get().membership.snapshot === undefined, h.store.get().membership);
  }
  {
    const h = harness({});
    h.ctl.onMembership({ asOf: 5, members: [] });
    h.ctl.onMembershipFailed("membership read timed out");
    ok("6.5 a refusal keeps the last snapshot it cannot replace, and says it is unreadable",
      h.store.get().membership.snapshot?.asOf === 5 && h.store.get().membership.unreadable === "membership read timed out", h.store.get().membership);
  }
  {
    const h = harness({ ...bootReads, membership: async () => { throw new Error("membership refused with HTTP 503: membership-read-failed"); } });
    await h.ctl.refresh();
    ok("6.6 CONTROL: with no live event a bootstrap refusal does mark membership unreadable",
      /membership-read-failed/.test(h.store.get().membership.unreadable ?? ""), h.store.get().membership);
  }
  // ONCE THE FEED HAS SPOKEN FOR MEMBERSHIP, A POLL DOES NOT READ IT AGAIN. Every later read would be
  // dropped on arrival, so it is a broker call per poll for nothing, and a refusal of it would still
  // put a stale mark in the header beside a pill the feed keeps live.
  {
    let reads = 0;
    const h = harness({ ...bootReads, membership: async () => { reads++; throw new Error("membership refused with HTTP 503: membership-read-failed"); } });
    await h.ctl.refresh();
    const beforeFeed = { reads, marked: h.store.get().stale.some((m) => m.name === "membership") };
    ok("6.7 CONTROL: before the feed has spoken the poll reads membership, and its refusal is marked",
      beforeFeed.reads === 1 && beforeFeed.marked, beforeFeed);
    h.ctl.onMembership({ asOf: 5, members: [] });
    await h.ctl.refresh();
    await h.ctl.refresh();
    ok("6.8 after the feed has spoken for membership, a poll does NOT read it again, and the old refusal's mark is gone",
      reads === 1 && !h.store.get().stale.some((m) => m.name === "membership") && h.store.get().membership.snapshot?.asOf === 5,
      { reads, stale: h.store.get().stale });
  }
  {
    // The read that was ALREADY IN FLIGHT when the feed spoke cannot be skipped, so its refusal is
    // dropped from the marks instead.
    const g = gate<never>();
    const h = harness({ ...bootReads, membership: () => g.promise });
    const p = h.ctl.refresh();
    h.ctl.onMembership({ asOf: 5, members: [] });
    g.reject(new Error("membership refused with HTTP 503: membership-read-failed"));
    await p;
    ok("6.9 a refusal of a read the feed outranked while it was in flight leaves no stale mark",
      !h.store.get().stale.some((m) => m.name === "membership"), h.store.get().stale);
  }
}

// The shell cells above read `App.tsx` as text. Load the module as well, so an edit to the shell
// reaches this suite by import and not only by a file read (see `load-shell.mjs`).
{
  const { shell } = await import("./load-shell.mjs");
  ok("the shell module loads under Node and exports App", typeof shell.App === "function");
}

console.log(`\nweb snapshot-retention smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
