/**
 * m10 — WHY TWO PRESENCE VIEWS DISAGREE, driven rather than reasoned.
 *
 * Observed live: `cotal endpoints` and `cotal_roster` reported different populations (1 offline
 * record against 3). Read first, and the obvious explanation is WRONG: they do not filter
 * differently. Both call the SAME accessor — `ep.getRoster()` (`commands/endpoints.ts:10`,
 * `tool-specs.ts:244` via `agent.roster()`). So the difference cannot be in the rendering.
 *
 * THE HYPOTHESIS UNDER TEST IS AGE, NOT FILTER:
 *   `cotal endpoints` opens a TRANSIENT endpoint, calls `waitForPresenceSnapshot()`, prints, stops
 *   — a fresh read of the KV on every invocation.
 *   `cotal_roster` reads a LONG-LIVED session's roster, maintained incrementally by the presence
 *   watcher since the session connected, possibly hours earlier.
 *
 * If those two can disagree at one instant, then a supervisor watching a long-lived session sees a
 * CACHE, and this lane's whole feature — "a self-disconnect must be observable to the supervisor" —
 * is only as good as that cache. This program has already paid for a presence view served from
 * cache for fourteen hours.
 *
 * PREDICTIONS, WRITTEN BEFORE THE RUN:
 *   P1 both views name the SAME population.
 *   P2 both agree on the status of a peer that departed GRACEFULLY (it published its own offline).
 *   P3 both agree on the status of a peer that was HARD-KILLED (no farewell — this is the case that
 *      must fall back on TTL/heartbeat, and the one where a cache is most likely to be stale).
 *
 * REFUTED IF any of the three disagree — and a disagreement is the FINDING, not a failure of the
 * probe, so each is reported with both views printed side by side rather than as a bare boolean.
 *
 * CONTROL: the long-lived view must have seen the full population BEFORE anyone departs. Without
 * that, "L is missing someone" is indistinguishable from "L never saw them", and the interesting
 * conclusion would be drawn from a fixture that never worked.
 *
 * Run: node_modules/.bin/tsx .meshctl-measurement/meshctl-m10-twoviews.smoke.ts
 * Needs `nats-server` on PATH. Local-only, loopback-only.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

for (const k of Object.keys(process.env)) if (/^COTAL_(SERVERS|CREDS|SPACE|NAME|ID|CONTROL_|LIFECYCLE)/.test(k)) delete process.env[k];

const pickFreePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const LIVE = "broker.cotal.ai";
if (SERVER.includes(LIVE)) throw new Error(`REFUSING: ${SERVER} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVER)) throw new Error(`REFUSING: ${SERVER} is not loopback`);
console.log(`[safety] dialling ${SERVER} — asserted not ${LIVE}, loopback only; inherited COTAL_* deleted`);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const SPACE = "meshctl-twoviews";
const store = mkdtempSync(join(tmpdir(), "meshctl-m10-"));
writeFileSync(join(store, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(store, "nats.conf")], { stdio: "ignore", detached: true });
const pgid = nats.pid!;

async function main(): Promise<void> {
  const { CotalEndpoint } = await import("@cotal-ai/core");
  for (let i = 0; i < 80; i++) {
    try { const e = new CotalEndpoint({ space: SPACE, servers: SERVER, card: { name: "probe", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false }); await e.start(); await e.stop(); break; } catch { await sleep(150); }
  }

  const peer = (name: string) => {
    const e = new CotalEndpoint({
      space: SPACE, servers: SERVER, card: { name, kind: "agent", role: "worker" },
      channels: ["general"], consume: false, registerPresence: true, watchPresence: false,
    });
    // The hard-kill arm severs the socket deliberately, and `mesh connection closed` is emitted as
    // an 'error' event — unhandled, that is an uncaught exception that kills the whole run before
    // any comparison is made. Handled here so the KILL is the experiment rather than the crash.
    e.on("error", () => { /* expected on the severed arm; the other peers never emit */ });
    return e;
  };

  // THE LONG-LIVED VIEW — what `cotal_roster` reads: connected once, then never re-snapshotted.
  const L = new CotalEndpoint({
    space: SPACE, servers: SERVER, card: { name: "long-lived-observer", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  await L.start();

  const graceful = peer("peer-graceful"), hardkill = peer("peer-hardkill"), stays = peer("peer-stays");
  await graceful.start(); await hardkill.start(); await stays.start();
  await sleep(3000);

  const view = (roster: any[]) => new Map<string, string>(
    roster.map((p) => [String(p.card?.name ?? p.name), String(p.status)]),
  );
  const Lview = () => view(L.getRoster() as any[]);

  // CONTROL FIRST: without this, "L is missing someone" cannot be told from "L never saw them".
  const before = Lview();
  const sawAll = ["peer-graceful", "peer-hardkill", "peer-stays"].every((n) => before.has(n));
  check("M10-C CONTROL: the long-lived view saw the FULL population before anyone departed (so a later absence is drift, not a view that never worked)",
    sawAll, { before: [...before] });

  // Depart two ways. The graceful one publishes its own offline; the hard-killed one cannot, and
  // must be noticed some other way — that asymmetry is the point.
  await graceful.stop();
  // A hard kill with no farewell: drop the socket under it rather than calling stop().
  try { ((hardkill as any).nc ?? (hardkill as any).conn)?.close?.(); } catch { /* best effort */ }
  try { await (hardkill as any).nc?.closed?.(); } catch { /* best effort */ }
  await sleep(6000);

  // THE FRESH VIEW — what `cotal endpoints` does, verbatim: transient, snapshot, print, stop.
  const T = new CotalEndpoint({
    space: SPACE, servers: SERVER, card: { name: "transient-observer", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  await T.start();
  await (T as any).waitForPresenceSnapshot();
  const Tview = view(T.getRoster() as any[]);
  const Lafter = Lview();

  console.log(`\n  long-lived  (cotal_roster's source)  : ${JSON.stringify([...Lafter])}`);
  console.log(`  fresh snapshot (cotal endpoints')    : ${JSON.stringify([...Tview])}\n`);

  const names = (m: Map<string, string>) => [...m.keys()].filter((n) => n.startsWith("peer-")).sort();
  check("M10-1 both views name the SAME population",
    JSON.stringify(names(Lafter)) === JSON.stringify(names(Tview)), { longLived: names(Lafter), fresh: names(Tview) });
  check("M10-2 both views agree on the GRACEFUL departure's status",
    Lafter.get("peer-graceful") === Tview.get("peer-graceful"), { longLived: Lafter.get("peer-graceful"), fresh: Tview.get("peer-graceful") });
  check("M10-3 both views agree on the HARD-KILLED peer's status (no farewell was published)",
    Lafter.get("peer-hardkill") === Tview.get("peer-hardkill"), { longLived: Lafter.get("peer-hardkill"), fresh: Tview.get("peer-hardkill") });
  console.log(`  ▸ RECORDED (not asserted) — the statuses themselves, which are a separate question from whether the two views AGREE:\n` +
    `      graceful  long-lived=${Lafter.get("peer-graceful")}  fresh=${Tview.get("peer-graceful")}\n` +
    `      hardkill  long-lived=${Lafter.get("peer-hardkill")}  fresh=${Tview.get("peer-hardkill")}\n` +
    `      stays     long-lived=${Lafter.get("peer-stays")}  fresh=${Tview.get("peer-stays")}`);

  // ---- M10-4: HOW LONG DOES A SILENT DEATH READ AS PRESENT? ------------------------------------
  // The comparison above says the two views AGREE. It does not say they are RIGHT: both report the
  // hard-killed peer as `idle`, i.e. present, six seconds after its socket was severed. That is
  // exactly the shape this lane's feature must not manufacture — "an agent that goes dark on
  // request must not be indistinguishable from one that crashed" — but six seconds may simply be
  // less than the heartbeat, so a claim here would be a claim about my own sleep() and nothing else.
  //
  // So the DEADLINE is measured instead of asserted. Poll both views until the killed peer stops
  // reading as present, or until the bound. RECORDED, NOT ASSERTED: I have established no correct
  // value for this, and the bound is my patience, not a specification.
  const t0 = Date.now();
  let flipL = -1, flipT = -1;
  const BOUND_MS = 90_000;
  while (Date.now() - t0 < BOUND_MS && (flipL < 0 || flipT < 0)) {
    await sleep(2000);
    if (flipL < 0 && Lview().get("peer-hardkill") === "offline") flipL = Date.now() - t0;
    const T2 = new CotalEndpoint({
      space: SPACE, servers: SERVER, card: { name: "transient-poll", kind: "endpoint" },
      channels: [], consume: false, registerPresence: false, watchPresence: true,
    });
    T2.on("error", () => { /* transient */ });
    await T2.start();
    await (T2 as any).waitForPresenceSnapshot();
    if (flipT < 0 && view(T2.getRoster() as any[]).get("peer-hardkill") === "offline") flipT = Date.now() - t0;
    await T2.stop();
  }
  const say = (ms: number) => (ms < 0 ? `STILL PRESENT after ${Math.round((Date.now() - t0) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
  console.log(`\n  ▸ RECORDED (not asserted) — how long a peer that died WITHOUT a farewell keeps reading as present:\n` +
    `      long-lived view : ${say(flipL)}\n` +
    `      fresh snapshot  : ${say(flipT)}\n` +
    `      (bound ${BOUND_MS / 1000}s — this is the limit of the observation, NOT a specification)`);
  check("M10-4 the two views agree on WHETHER the silent death has been noticed yet (they may both be wrong, but they must not disagree)",
    (flipL < 0) === (flipT < 0), { flipL, flipT });

  await T.stop(); await stays.stop(); await L.stop();
  try { await hardkill.stop(); } catch { /* already gone */ }

  console.log(`\nM10 TWO-VIEWS ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("SMOKE ERROR:", e); process.exitCode = 1; })
  .finally(async () => {
    try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 20 && nats.exitCode === null && nats.signalCode === null; i++) await sleep(100);
    try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(process.exitCode ?? 0);
  });
