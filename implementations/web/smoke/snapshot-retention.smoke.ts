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
 * NOT reject on a 500, and this server's 500 body is `{"error": "..."}` — valid JSON. So
 * `fetch(u).then((r) => r.json())` RESOLVES, with the refusal, and the page stores it as the
 * snapshot. Nothing on either page ever consulted `r.status`, so the only fact that separated a
 * refusal from data never reached the code, and the `.catch(() => [])` guards that look like they
 * cover it never fired: there was nothing to catch.
 *
 * SO TWO RULES, AND THE ORDER IS THE FIX. A non-200 becomes a THROW that names its condition; a
 * throwing read leaves the value the page already holds alone and is reported STALE. Either alone is
 * not enough — the status check without retention converts a silent corruption into a visible wipe,
 * and retention without the status check keeps nothing, because the refusal was never a failure.
 *
 * WHAT THIS SUITE DRIVES. `snapshot.js` is READ OFF DISK and evaluated in a `vm` context with a stub
 * `window`, exactly as the classic `<script>` runs in the page, and it is reached through the REAL
 * `PAGE` export, so a module the server does not serve fails here. Nothing is restated.
 *
 * WHAT IT DOES NOT CLAIM. No DOM and no browser: it measures the state transition and its seam, not
 * the pixels. That both page scripts REACH this module is asserted structurally (§3) rather than by
 * executing them here — `event-order`, `channel-authority` and `membership-refusal` each drive the
 * shipped `refresh()` / boot source through this file, which is where that reachability is executed.
 *
 * Run: pnpm smoke:web-snapshot
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { PAGE } from "../src/web.js";

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

interface Source { name: string; read(): Promise<unknown>; apply(v: unknown): void }
interface Api {
  readJson(res: { ok: boolean; status: number; json(): Promise<unknown> }, what: string): Promise<unknown>;
  refreshAll(sources: Source[]): Promise<{ name: string; reason: string }[]>;
  staleLabel(stale: { name: string; reason: string }[]): string;
}

/** The file as the page runs it: a classic script against a bare `window`, reached through the route
 *  table the server serves it from rather than through a path this suite spells itself. */
function load(): Api {
  const route = PAGE["/snapshot.js"];
  ok("0.1 the server serves /snapshot.js (a module no route reaches is a module no page runs)", Boolean(route), Object.keys(PAGE));
  const ctx: { window: Record<string, unknown> } = { window: {} };
  const c = createContext(ctx);
  runInContext(readFileSync(route.path, "utf8"), c, { filename: "snapshot.js" });
  return ctx.window.COTAL_SNAPSHOT as Api;
}

const SNAP = load();
ok("0.2 the file publishes its three entry points on window", Boolean(SNAP?.readJson && SNAP?.refreshAll && SNAP?.staleLabel));

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
    return body;
  },
});

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
// Concurrency, asserted by construction rather than by a clock: every read is entered before any of
// them is allowed to finish. A sequential chain cannot satisfy this, and a timing threshold would be
// measuring the machine this suite runs on.
{
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mk = (name: string): Source => ({
    name,
    read: async () => { entered++; if (entered === 3) release(); await gate; return name; },
    apply: () => {},
  });
  const p = SNAP.refreshAll([mk("a"), mk("b"), mk("c")]);
  await gate;
  ok("2.11 all three reads are in flight together (a sequential chain could not enter the third)", entered === 3, entered);
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
  ok("3.2 a stale set NAMES its sources", SNAP.staleLabel([{ name: "peers", reason: "x" }, { name: "activity", reason: "y" }]) === "stale: peers, activity",
    SNAP.staleLabel([{ name: "peers", reason: "x" }, { name: "activity", reason: "y" }]));
}
/** CODE ONLY. These pages document the defect they fixed by quoting the shape that caused it, so a
 *  scan over raw source matches the comment describing the bug and reports the bug as present. That
 *  is not a hypothetical: every one of the three structural cells below failed on its own file's
 *  prose before this existed. Comments are removed first, and the control at 3.10 proves the scan
 *  still finds the shape in code. */
const codeOnly = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

{
  const indexHtml = readFileSync(PAGE["/"].path, "utf8");
  const graphHtml = readFileSync(PAGE["/graph"].path, "utf8");
  const appJs = codeOnly(readFileSync(join(webSrc, "app.js"), "utf8"));
  const graphJs = codeOnly(readFileSync(join(webSrc, "graph.js"), "utf8"));
  ok("3.3 the console page loads it", indexHtml.includes('<script src="/snapshot.js"></script>'));
  ok("3.4 the graph page loads it", graphHtml.includes('<script src="/snapshot.js"></script>'));
  ok("3.5 both pages carry the stale marker element it drives", indexHtml.includes('id="stale"') && graphHtml.includes('id="stale"'));
  ok("3.6 the console page reads every source through it", appJs.includes("SNAP.refreshAll(") && appJs.includes("SNAP.readJson("));
  ok("3.7 the graph page reads every source through it", graphJs.includes("SNAP.refreshAll(") && graphJs.includes("SNAP.readJson("));
  // The shape that caused the wipe, in the files that had it: a response body consumed with no
  // status check. A survivor here is a poll that can still store a refusal as data.
  const rawJson = /fetch\([^)]*\)\s*\)\s*\.json\(\)|fetch\([^)]*\)\.then\(\s*\(?r\)?\s*=>\s*r\.json\(\)/g;
  ok("3.8 no unguarded `fetch(...).json()` survives on the console page", (appJs.match(rawJson) ?? []).length === 0, appJs.match(rawJson));
  ok("3.9 no unguarded `fetch(...).json()` survives on the graph page", (graphJs.match(rawJson) ?? []).length === 0, graphJs.match(rawJson));
  // CONTROL for 3.8/3.9: the pattern must be able to find the shape it is looking for.
  ok("3.10 CONTROL: that pattern DOES match the shape it forbids",
    ('const x = await (await fetch("/api/roster")).json();'.match(rawJson) ?? []).length === 1);
  ok("3.10b CONTROL: and the comment stripper does not eat code (a scan over an empty string finds nothing)",
    codeOnly('a(); // fetch(x).json()\nconst u = "http://x";').includes("a();") && !codeOnly('a(); // fetch(x).json()').includes("fetch"));
  // The graph page's boot must not be able to skip the live feed again.
  ok("3.11 the graph page connects whatever the boot reported (the wipe was `load().then(connect)`)",
    /load\(\)\s*\.catch\([\s\S]{0,80}?\)\s*\.then\(connect\)/.test(graphJs) && !/load\(\)\.then\(connect\)/.test(graphJs));
}

console.log(`\nweb snapshot-retention smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
