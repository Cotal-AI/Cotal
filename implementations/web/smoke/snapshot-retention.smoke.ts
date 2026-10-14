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
 * The structural cells on the old pages stay on those pages until their replacements land: Task 7
 * (the boot and `api/http.ts`) re-homes §3.11 and §5.3, and Task 8 (the shell) re-homes §3.3 to
 * §3.5 and §3.7.
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
import { LEGACY_PAGE_FILES } from "../src/web.js";
import { readJson, refreshAll, staleLabel, type Source } from "../client/src/lib/snapshot.js";
import type { CotalMessage } from "../client/src/api/types.js";
import type { Api } from "../client/src/state/controller.js";
import { bootReads, gate, harness } from "./controller-harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, "..", "src", "web");

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
  const indexHtml = readFileSync(LEGACY_PAGE_FILES["/"].path, "utf8");
  const graphHtml = readFileSync(LEGACY_PAGE_FILES["/graph"].path, "utf8");
  const graphJs = codeOnly(readFileSync(join(webSrc, "graph.js"), "utf8"));
  ok("3.3 the console page loads it", indexHtml.includes('<script src="/snapshot.js"></script>'));
  ok("3.4 the graph page loads it", graphHtml.includes('<script src="/snapshot.js"></script>'));
  ok("3.5 both pages carry the stale marker element it drives", indexHtml.includes('id="stale"') && graphHtml.includes('id="stale"'));
  ok("3.7 the graph page reads every source through it", graphJs.includes("SNAP.refreshAll(") && graphJs.includes("SNAP.readJson("));
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
  // does not guard the status check. The HTTP status gate moves to api/http.ts in Task 7, which adds
  // a cell over httpApi(fakeFetch) for every route and a mutation that drops readJson.
  const controllerJs = codeOnly(readFileSync(join(here, "..", "client", "src", "state", "controller.ts"), "utf8"));
  ok("3.8 the controller holds no fetch; every read goes through the injected Api",
    !/\bfetch\s*\(/.test(controllerJs) && (controllerJs.match(rawJson) ?? []).length === 0, controllerJs.match(rawJson));
  ok("3.9 no unguarded `fetch(...).json()` survives on the graph page", (graphJs.match(rawJson) ?? []).length === 0, graphJs.match(rawJson));
  // CONTROL for 3.8/3.9: the pattern must be able to find the shape it is looking for.
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
  // The graph page's boot must not be able to skip OR DELAY the live feed. This cell used to REQUIRE
  // `load().catch(...).then(connect)`, the shape that guaranteed `connect` would RUN. The page now
  // opens the feed FIRST, which guarantees it runs SOON as well, so the old assertion had turned
  // into a requirement to keep the weaker boot. What survives is the property, restated against the
  // boot that ships: the feed is opened, and it is chained behind the bootstrap in no spelling.
  ok("3.11 the graph page opens the live feed WITHOUT waiting for the boot (the wipe was `load().then(connect)`)",
    /connect\(\);\s*\n\s*load\(\)/.test(graphJs) && !/\.then\(\s*connect\s*\)/.test(graphJs));
  ok("3.11b CONTROL: the chained shape 3.11 forbids is one this pattern can still see",
    /\.then\(\s*connect\s*\)/.test("load().catch((err) => console.error(err)).then(connect);"));
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
// TWO RENDER GUARANTEES ARE NOT PINNED HERE, because there is no renderer yet. The old 5.5 ("nor the
// document title") is folded into 5.4, which checks `space`, the value the title is drawn from. The
// old W12 mutation proved that recovery CLEARS the marker's label and tooltip rather than only hiding
// the element. The shell (Task 8) re-pins both against what it renders.
{
  const appSrc = readFileSync(join(webSrc, "app.js"), "utf8");
  // The gate itself lives where the read is made. On the old page that is this line, and Task 7
  // re-homes this cell onto `api/http.ts`, whose `Api` wraps every route in `readJson`.
  ok("5.3 and it reads through the gate rather than consuming the body directly",
    /readJson\(await fetch\("\/api\/meta"\)/.test(appSrc));

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
}

console.log(`\nweb snapshot-retention smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
