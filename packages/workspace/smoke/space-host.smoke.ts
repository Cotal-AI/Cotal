/**
 * The shared multi-space host, `runSpaceHost`, driven directly with lanes whose open and close this
 * suite controls, so each lifecycle rule is checked against what the host does rather than what a
 * daemon prints.
 *
 * Cells: a host with per-space settings hands each lane its entry's settings and reopens only a lane
 * whose entry changed; servable startup serves the spaces that open and retries the rest; the
 * acknowledgment names the manifest's SHA-256 only once every space it does not name has closed; a
 * lane whose close rejects holds back every acknowledgment, is not opened again while it may still
 * serve, and is closed on a retry; the default startup refuses unless every space opens and closes
 * what it opened; a host that cannot write its acknowledgment refuses to start; an open that hangs
 * holds back neither the other spaces nor the ready line, is not started twice, and its late lane
 * is taken, or closed when its space has gone or the host refused; a manifest that drops a space
 * whose open is still running is acknowledged only once that open has settled and any lane it
 * produced is closed, including when that open settles while the pass is inside another lane's
 * close.
 *
 * Run: pnpm smoke:space-host
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { runSpaceHost, type SpaceLane, type SpaceSettings } from "../src/space-host.js";

const { check, finish } = createSuite();
const dir = mkdtempSync(join(tmpdir(), "space-host-"));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return true; await wait(50); }
  return test();
};
const write = (path: string, doc: unknown): string => {
  const text = JSON.stringify(doc);
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
  return createHash("sha256").update(text).digest("hex");
};
const applied = (path: string): string | undefined => {
  try { return (JSON.parse(readFileSync(`${path}.applied`, "utf8")) as { sha256?: string }).sha256; } catch { return undefined; }
};

/** What happened to the lanes of one space, in order. */
type Event = { space: string; what: "open" | "open-failed" | "closed" | "close-rejected"; port?: number };
const events: Event[] = [];
const count = (space: string, what: Event["what"]) => events.filter((e) => e.space === space && e.what === what).length;
/** Per space: how many opens to fail, how many closes to reject, how long a close takes, a promise
 *  an open waits on before it returns (a hung open, released by the cell), and a hook that runs once
 *  as a close starts, which a cell uses to make something happen while the host awaits that close. */
const faults = new Map<string, { openFailures?: number; closeRejections?: number; closeMs?: number; holdOpen?: Promise<void>; onClose?: () => void }>();
/** How many times each space's open was entered, held ones included. */
const starts = new Map<string, number>();
const logLines: string[] = [];

const openStub = async (space: string, settings: { port: number }): Promise<SpaceLane> => {
  starts.set(space, (starts.get(space) ?? 0) + 1);
  const f = faults.get(space) ?? {};
  if (f.holdOpen) await f.holdOpen;
  if ((f.openFailures ?? 0) > 0) {
    f.openFailures!--;
    events.push({ space, what: "open-failed" });
    throw new Error("stub open failure");
  }
  events.push({ space, what: "open", port: settings.port });
  let settle!: (what: string) => void;
  const lost = new Promise<string>((r) => { settle = r; });
  let closed = false;
  return {
    space,
    lost,
    close: async () => {
      if (closed) return;
      // Read when the close runs: a cell sets a lane's close faults after the lane opened.
      const fc = faults.get(space) ?? {};
      const hook = fc.onClose;
      fc.onClose = undefined;
      hook?.();
      if (fc.closeMs) await wait(fc.closeMs);
      if ((fc.closeRejections ?? 0) > 0) {
        fc.closeRejections!--;
        events.push({ space, what: "close-rejected" });
        throw new Error("stub close failure");
      }
      closed = true;
      events.push({ space, what: "closed" });
      settle("a deliberate close");
    },
  };
};
const settings: SpaceSettings<{ port: number }> = {
  parse(_space, fields) {
    if (Object.keys(fields).some((k) => k !== "port") || typeof fields.port !== "number") throw new Error("an entry takes a numeric port");
    return { port: fields.port };
  },
  across(all) {
    if (new Set([...all.values()].map((s) => s.port)).size !== all.size) throw new Error("two spaces name one port");
  },
};
const entries = (ports: Record<string, number>) => ({ version: 2, spaces: Object.entries(ports).map(([space, port]) => ({ space, port })) });

try {
  // ---- a settings host with servable startup ------------------------------------------------------
  const manifest = join(dir, "spaces.json");
  faults.set("c", { openFailures: 1 });
  const startSha = write(manifest, entries({ a: 1, b: 2, c: 3 }));
  const host = await runSpaceHost({
    manifest, settings, startup: "servable", open: openStub,
    label: "stub host", entry: "stub --spaces", serving: "serving", log: (l) => logLines.push(l),
  });
  check("servable startup opens the spaces that open and names every space it was given",
    host.lanes.size === 2 && host.lanes.has("a") && host.lanes.has("b") && host.named.join(",") === "a,b,c", [...host.lanes.keys()]);
  check("each lane received its own entry's settings", events.find((e) => e.space === "a" && e.what === "open")?.port === 1 && events.find((e) => e.space === "b" && e.what === "open")?.port === 2);
  check("the startup manifest is acknowledged by its SHA-256 before any retry", applied(manifest) === startSha);
  check("the space that failed is retried and opens", await until(() => count("c", "open") === 1, 8_000) && count("c", "open-failed") === 1, events);

  // ---- a changed entry reopens only that lane ------------------------------------------------------
  const movedSha = write(manifest, entries({ a: 9, b: 2, c: 3 }));
  check("a changed entry closes and reopens that lane with its new settings, and only that lane",
    await until(() => applied(manifest) === movedSha && count("a", "open") === 2, 5_000)
    && events.filter((e) => e.space === "a" && e.what === "open").at(-1)?.port === 9 && count("a", "closed") === 1 && count("b", "open") === 1 && count("b", "closed") === 0, events);

  // ---- the acknowledgment waits for the close -------------------------------------------------------
  faults.set("b", { closeMs: 400 });
  const removeSha = write(manifest, entries({ a: 9, c: 3 }));
  let closedWhenAcknowledged: boolean | undefined;
  await until(() => {
    if (applied(manifest) !== removeSha) return false;
    closedWhenAcknowledged = count("b", "closed") === 1;
    return true;
  }, 5_000);
  check("a removal is acknowledged only after the removed lane's close resolved", closedWhenAcknowledged === true, events.slice(-3));

  // ---- a close that rejects holds back the acknowledgment -------------------------------------------
  faults.set("c", { closeRejections: 2 });
  const withoutC = write(manifest, entries({ a: 9 }));
  check("a lane whose close rejects is not acknowledged as removed",
    await until(() => count("c", "close-rejected") === 1, 5_000) && (await wait(500), applied(manifest) !== withoutC), { applied: applied(manifest), events: events.slice(-3) });
  // A port of its own, so this manifest's digest differs from every one acknowledged before it.
  const readdC = write(manifest, entries({ a: 9, c: 7 }));
  check("the next pass retries the close, and while it still rejects the space is neither opened again nor acknowledged",
    await until(() => count("c", "close-rejected") === 2, 5_000) && (await wait(500), count("c", "open") === 1 && applied(manifest) !== readdC), events.slice(-3));
  check("a later retry closes the lane, then opens the space again and acknowledges the manifest",
    await until(() => applied(manifest) === readdC && count("c", "open") === 2, 15_000)
    && events.findIndex((e) => e.space === "c" && e.what === "closed") < events.findLastIndex((e) => e.space === "c" && e.what === "open"), events.slice(-4));
  check("the host said why it acknowledged nothing", logLines.some((l) => l.includes(`space "c" did not confirm its lane closed`)));

  // ---- the default startup is all or nothing -------------------------------------------------------
  const strict = join(dir, "strict.json");
  faults.set("y", { openFailures: 1 });
  write(strict, entries({ x: 4, y: 5 }));
  let refusal: string | undefined;
  try {
    await runSpaceHost({ manifest: strict, settings, open: openStub, label: "strict host", entry: "strict --spaces", serving: "serving", log: (l) => logLines.push(l) });
  } catch (e) { refusal = e instanceof Error ? e.message : String(e); }
  await wait(1000);
  check("the default startup refuses when a space cannot open, closes the lane it opened, and opens nothing after",
    refusal?.includes('space "y" could not be served') === true && refusal.includes("no lane was left running") && count("x", "open") === 1 && count("x", "closed") === 1 && count("y", "open") === 0, { refusal, events: events.filter((e) => e.space === "x" || e.space === "y") });

  // ---- a host that cannot write its acknowledgment refuses ------------------------------------------
  const locked = join(dir, "locked");
  mkdirSync(locked);
  write(join(locked, "spaces.json"), entries({ z: 6 }));
  chmodSync(locked, 0o555);
  let lockedRefusal: string | undefined;
  try {
    await runSpaceHost({ manifest: join(locked, "spaces.json"), settings, startup: "servable", open: openStub, label: "locked host", entry: "locked --spaces", serving: "serving", log: (l) => logLines.push(l) });
  } catch (e) { lockedRefusal = e instanceof Error ? e.message : String(e); }
  chmodSync(locked, 0o755);
  check("a host that cannot write its acknowledgment refuses to start and opens no lane",
    lockedRefusal?.includes("cannot write") === true && lockedRefusal.includes("no lane was opened") && count("z", "open") === 0, lockedRefusal);

  // ---- an open that hangs holds back neither the other spaces nor the ready line --------------------
  const slow = join(dir, "slow.json");
  let releaseH!: () => void;
  faults.set("h", { holdOpen: new Promise<void>((r) => { releaseH = r; }) });
  const slowSha = write(slow, entries({ h: 11, i: 12 }));
  const t0 = Date.now();
  const slowHost = await runSpaceHost({
    manifest: slow, settings, startup: "servable", openDeadlineSeconds: 1, open: openStub,
    label: "slow host", entry: "slow --spaces", serving: "serving", log: (l) => logLines.push(l),
  });
  const startupMs = Date.now() - t0;
  check("servable startup returns at the deadline with the other spaces served while one open hangs",
    startupMs >= 1_000 && startupMs < 2_500 && slowHost.lanes.has("i") && !slowHost.lanes.has("h") && slowHost.opening.has("h") && applied(slow) === slowSha, { startupMs, lanes: [...slowHost.lanes.keys()] });
  check("the host said which space did not open within the deadline", logLines.some((l) => l.includes('space "h" did not open within 1s')));
  const movedI = write(slow, entries({ h: 11, i: 13 }));
  check("a later pass reconciles the other spaces and does not start a second open for the hung one",
    await until(() => applied(slow) === movedI && count("i", "open") === 2, 5_000) && starts.get("h") === 1, { starts: starts.get("h"), events: events.slice(-3) });
  releaseH();
  check("the open that settles after its deadline is taken as that space's lane, opened once",
    await until(() => slowHost.lanes.has("h"), 3_000) && !slowHost.opening.has("h") && count("h", "open") === 1 && starts.get("h") === 1 && logLines.some((l) => l.includes('space "h" opened after its deadline')), events.slice(-3));

  // ---- a removal is not acknowledged while the removed space's open is still running (#5079) -----------
  let releaseJ!: () => void;
  faults.set("j", { holdOpen: new Promise<void>((r) => { releaseJ = r; }) });
  write(slow, entries({ h: 11, i: 13, j: 14 }));
  await until(() => logLines.some((l) => l.includes('space "j" did not open within 1s')), 5_000);
  const withoutJ = write(slow, entries({ h: 11, i: 13 }));
  await wait(1_500);
  check("a manifest that drops a space is not acknowledged while that space's open is still running",
    applied(slow) !== withoutJ && slowHost.opening.has("j") && count("j", "open") === 0,
    { applied: applied(slow), withoutJ, opening: [...slowHost.opening] });
  check("the host said which dropped space's open holds the acknowledgment back",
    logLines.some((l) => l.includes('space(s) "j" left the manifest while still opening')), logLines.slice(-3));
  const withM = write(slow, entries({ h: 11, i: 13, m: 15 }));
  check("another space still opens while a dropped space's pending open holds the acknowledgment",
    await until(() => count("m", "open") === 1, 5_000) && (await wait(300), applied(slow) !== withM),
    { applied: applied(slow), events: events.slice(-2) });
  releaseJ();
  let closedWhenApplied: boolean | undefined;
  check("the manifest is acknowledged on the pass after the late lane closed, and that lane never served",
    await until(() => { if (applied(slow) !== withM) return false; closedWhenApplied = count("j", "closed") === 1; return true; }, 8_000)
    && closedWhenApplied === true && count("j", "open") === 1 && !slowHost.lanes.has("j") && !slowHost.opening.has("j"),
    { closedWhenApplied, events: events.slice(-3) });

  // ---- a dropped space whose late open fails releases the acknowledgment without the retry wait --------
  let releaseN!: () => void;
  faults.set("n", { holdOpen: new Promise<void>((r) => { releaseN = r; }), openFailures: 1 });
  const withN = write(slow, entries({ h: 11, i: 13, m: 15, n: 16, o: 18 }));
  await until(() => logLines.some((l) => l.includes('space "n" did not open within 1s')), 5_000);
  check("a space the manifest still names holds back nothing while its open runs past the deadline",
    await until(() => applied(slow) === withN, 5_000) && slowHost.opening.has("n") && slowHost.lanes.has("o"), { applied: applied(slow), opening: [...slowHost.opening] });
  const withoutN = write(slow, entries({ h: 11, i: 13, m: 15, o: 18 }));
  await wait(1_000);
  check("a dropped space holds the acknowledgment back even when its open will fail",
    applied(slow) !== withoutN && slowHost.opening.has("n"), { applied: applied(slow), opening: [...slowHost.opening] });
  const releasedAt = Date.now();
  releaseN();
  const appliedAfterFail = await until(() => applied(slow) === withoutN, 8_000);
  check("a late open that fails for a dropped space releases the acknowledgment without waiting out the retry, and the space is not opened again",
    appliedAfterFail && Date.now() - releasedAt < 3_000 && count("n", "open-failed") === 1 && count("n", "open") === 0 && starts.get("n") === 1,
    { ms: Date.now() - releasedAt, starts: starts.get("n"), events: events.slice(-2) });

  // ---- an open that settles inside another lane's close is closed before anything is acknowledged -----
  let releaseR!: () => void;
  faults.set("r", { holdOpen: new Promise<void>((r) => { releaseR = r; }) });
  write(slow, entries({ h: 11, i: 13, m: 15, o: 18, r: 19, u: 20 }));
  await until(() => logLines.some((l) => l.includes('space "r" did not open within 1s')), 5_000);
  check("the pass that drops two spaces starts with one open pending and the other lane up",
    slowHost.opening.has("r") && slowHost.lanes.has("u"), { opening: [...slowHost.opening], lanes: [...slowHost.lanes.keys()] });
  // u's close releases r's open, so the host takes r's lane while it is inside u's close, after the
  // pass listed what it would close and after it read which spaces were still opening. r's own close
  // is slow enough to be seen, so a pass that acknowledged before closing r would be caught here.
  faults.set("u", { closeMs: 600, onClose: () => releaseR() });
  faults.get("r")!.closeMs = 400;
  const withoutRU = write(slow, entries({ h: 11, i: 13, m: 15, o: 18 }));
  let bothClosedWhenApplied: boolean | undefined;
  check("an open that settles inside another lane's close is closed before the manifest is acknowledged",
    await until(() => { if (applied(slow) !== withoutRU) return false; bothClosedWhenApplied = count("r", "closed") === 1 && count("u", "closed") === 1; return true; }, 15_000)
    && bothClosedWhenApplied === true && !slowHost.lanes.has("r") && !slowHost.opening.has("r") && count("r", "open") === 1 && starts.get("r") === 1,
    { bothClosedWhenApplied, events: events.slice(-4) });

  // ---- the default startup refuses a hung open at the deadline ------------------------------------------
  const strictSlow = join(dir, "strict-slow.json");
  let releaseK!: () => void;
  faults.set("k", { holdOpen: new Promise<void>((r) => { releaseK = r; }) });
  write(strictSlow, entries({ k: 21, l: 22 }));
  let slowRefusal: string | undefined;
  try {
    await runSpaceHost({ manifest: strictSlow, settings, openDeadlineSeconds: 1, open: openStub, label: "strict slow host", entry: "strict-slow --spaces", serving: "serving", log: (l) => logLines.push(l) });
  } catch (e) { slowRefusal = e instanceof Error ? e.message : String(e); }
  check("the default startup refuses when a space does not open within the deadline and opens nothing after",
    slowRefusal?.includes('space "k" did not open within 1s') === true && slowRefusal.includes("no lane was left running") && starts.get("l") === undefined, slowRefusal);
  releaseK();
  check("the lane that open settles with after the refusal is closed, not served",
    await until(() => count("k", "closed") === 1, 3_000) && count("k", "open") === 1, events.slice(-2));

  // ---- a signal closes every lane, including one still opening when it lands (#4959) -----------------
  const stopping = join(dir, "stopping.json");
  write(stopping, entries({ p: 41 }));
  const stopHost = await runSpaceHost({
    manifest: stopping, settings, startup: "servable", openDeadlineSeconds: 2, open: openStub,
    label: "stopping host", entry: "stopping --spaces", serving: "serving", log: (l) => logLines.push(l),
  });
  let releaseQ!: () => void;
  faults.set("q", { holdOpen: new Promise<void>((r) => { releaseQ = r; }) });
  write(stopping, entries({ p: 41, q: 42 }));
  check("a reconcile pass is inside the open of a space when the signal lands", await until(() => starts.get("q") === 1, 5_000), starts.get("q"));
  process.kill(process.pid, "SIGTERM");
  let endedBeforeRelease = false;
  const stopEnded = stopHost.ended.then((c) => { if (!releasedQ) endedBeforeRelease = true; return c; });
  let releasedQ = false;
  await wait(300);
  releasedQ = true;
  releaseQ();
  const [code, stopCode] = await Promise.all([host.ended, stopEnded]);
  check("SIGTERM closes every lane and ends the host with 0", code === 0 && host.lanes.size === 0 && count("a", "closed") === 2 && count("c", "closed") === 2, { code, events: events.slice(-3) });
  check("the stop waits for the open in flight, closes the lane it opens, and never serves it",
    stopCode === 0 && !endedBeforeRelease && count("q", "open") === 1 && count("q", "closed") === 1 && count("p", "closed") === 1 && stopHost.lanes.size === 0,
    { stopCode, endedBeforeRelease, events: events.slice(-4) });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
finish();
