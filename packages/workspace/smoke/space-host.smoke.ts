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
 * what it opened; a host that cannot write its acknowledgment refuses to start.
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
/** Per space: how many opens to fail, how many closes to reject, and how long a close takes. */
const faults = new Map<string, { openFailures?: number; closeRejections?: number; closeMs?: number }>();
const logLines: string[] = [];

const openStub = async (space: string, settings: { port: number }): Promise<SpaceLane> => {
  const f = faults.get(space) ?? {};
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

  // ---- a signal closes every lane ---------------------------------------------------------------------
  process.kill(process.pid, "SIGTERM");
  const code = await host.ended;
  check("SIGTERM closes every lane and ends the host with 0", code === 0 && host.lanes.size === 0 && count("a", "closed") === 2 && count("c", "closed") === 2, { code, events: events.slice(-3) });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
finish();
