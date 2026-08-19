/**
 * A CHANNEL NAME THE WIRE WOULD REWRITE ADDRESSES A DIFFERENT CHANNEL THAN IT NAMES.
 *
 * The dashboard takes a channel name from the caller in two places: the path segment of
 * `/api/channels/<name>/history`, and the JSON body of `POST /api/channel/delete`. Both handed it
 * straight to core, and core builds a channel's subject through `token()`, which REWRITES anything
 * outside `[A-Za-z0-9_-]` to `_` instead of refusing it. So two different names are one channel on
 * the wire, while the dashboard answers with whichever one the caller typed.
 *
 * MEASURED against the shipped routes on a local broker before this existed, with one message
 * seeded on `abc_`:
 *
 *   GET /api/channels/abc%E2%80%AE/history   200, and it returned `abc_`'s message.
 *   POST /api/channel/delete {"channel":"abc<U+202E>"}
 *                                            200 {"ok":true,"channel":"abc<U+202E>","purged":1},
 *                                            and `abc_`'s message was gone.
 *
 * That second one is a destructive route on a dashboard holding a god-view cred: a caller names one
 * channel and a different channel is purged, and the answer reports the name that was typed. Making
 * that answer render readably (Cotal #711, the sibling suite here) would have made the lie legible
 * without removing it, which is why the name is refused instead.
 *
 * Core already owns the rule and wrote it for the same aliasing gap on the ACL side:
 * `assertValidChannel` rejects, fail-loud, anything `token()` would silently rewrite. The dashboard
 * simply never asked it. The refusal is a 400 built through the same quoter as every other refusal,
 * so the name it names is readable.
 *
 * WHAT THIS DOES NOT CLAIM: the rewrite in `token()` is unchanged and is not this suite's subject.
 * Only the two caller-facing boundaries are closed here.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:web-channel-alias
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { isReachable, setupSpaceStreams, CotalEndpoint, newIdentity } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async (): Promise<number> => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
});

/** Built at runtime, never typed into this file: a suite about invisible characters that contains
 *  them is a suite whose own source cannot be reviewed by eye. */
const cp = (n: number): string => String.fromCodePoint(n);
const pct = (s: string): string =>
  [...Buffer.from(s, "utf8")].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");

const RLO = cp(0x202e);          // right-to-left override: `token()` rewrites it to `_`
const REAL = "abc_";             // ...so this is the channel it aliases onto
const SPOOF = "abc" + RLO;
const MSG = "seeded on the real channel";

const PORT = await freePort();
const SPACE = "chalias";
const SERVER = `nats://127.0.0.1:${PORT}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let webChild: ReturnType<typeof spawn> | undefined;
try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const seed = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: [REAL], consume: false,
    registerPresence: false, card: { id: newIdentity().id, name: "seed", kind: "endpoint" } });
  seed.on("error", () => {});
  await seed.start();
  await seed.multicast(MSG, { channel: REAL });
  await seed.stop();

  const WEB_PORT = await freePort();
  let log = "";
  webChild = spawn(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./run-web.mts", import.meta.url)),
    "--server", SERVER, "--space", SPACE, "--port", String(WEB_PORT), "--no-open",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  webChild.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
  webChild.stderr?.on("data", (d: Buffer) => { log += d.toString(); });

  let served = false;
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/roster`).catch(() => undefined);
    if (r?.status === 200) { served = true; break; }
    await wait(250);
  }

  const get = async (p: string): Promise<{ status: number; body: Buffer }> => {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}${p}`);
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  };
  const del = async (channel: string): Promise<{ status: number; body: Buffer }> => {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/channel/delete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel }),
    });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  };
  /** Does the REAL channel still hold the seeded message? The whole suite turns on this question,
   *  so it is one helper and not four hand-rolled reads. */
  const realStillHasIt = async (): Promise<boolean> =>
    (await get(`/api/channels/${REAL}/history?limit=20`)).body.toString("utf8").includes(MSG);

  console.log("1. the ground truth this suite is about");
  ok("1.0 the shipped `web` entry point serves at all", served, log.slice(-300));
  ok("1.1 CONTROL: the real channel exists and its history route returns the seeded message, so every cell below is about the NAME and not about an empty broker",
    await realStillHasIt());

  console.log("2. the read boundary");
  {
    const r = await get(`/api/channels/${pct(SPOOF)}/history?limit=20`);
    ok("2.1 a name the wire would rewrite is REFUSED at the history route, rather than quietly reading the channel it aliases onto",
      r.status === 400 && !r.body.toString("utf8").includes(MSG),
      { status: r.status, body: r.body.toString("utf8").slice(0, 140) });
    ok("2.2 ...and that refusal carries no RAW class member, so an operator reading it sees which codepoint was in the name",
      !r.body.includes(Buffer.from(RLO, "utf8")) && r.body.toString("utf8").includes("\\u202e"),
      r.body.toString("utf8").slice(0, 140));
  }
  ok("2.3 CONTROL: the ordinary name still reads after the refusal, so 2.1 refused a NAME and did not break the route",
    await realStillHasIt());

  console.log("3. the destructive boundary");
  {
    const r = await del(SPOOF);
    ok("3.1 the delete route REFUSES the aliasing name",
      r.status === 400, { status: r.status, body: r.body.toString("utf8").slice(0, 140) });
    ok("3.2 ...and the channel it would have aliased onto still holds its message: the refusal happened BEFORE the purge, not after",
      await realStillHasIt());
    ok("3.3 ...and the refusal names the codepoint as an escape rather than echoing it raw",
      !r.body.includes(Buffer.from(RLO, "utf8")) && r.body.toString("utf8").includes("\\u202e"),
      r.body.toString("utf8").slice(0, 140));
  }
  {
    // Behaviour that must SURVIVE the new refusal. `assertValidChannel` admits `*` and `>` as whole
    // segments, so a wildcard still reaches the delete route's own refusal and keeps its own words.
    // Without this cell, tightening the name check into "no wildcards either" would look free.
    const r = await del("abc.*");
    ok("3.4 CONTROL: a WILDCARD is still refused by the delete route's own wildcard message, not swallowed by the name check",
      r.status === 400 && r.body.toString("utf8").includes("wildcard"),
      { status: r.status, body: r.body.toString("utf8").slice(0, 140) });
  }

  console.log("4. the delete route still deletes");
  {
    const r = await del(REAL);
    ok("4.1 the ordinary name is purged, so the two refusals above are about the NAME and not a delete route that stopped working",
      r.status === 200 && r.body.toString("utf8").includes('"purged"'),
      { status: r.status, body: r.body.toString("utf8").slice(0, 140) });
    ok("4.2 ...and the message really is gone afterwards",
      !(await realStillHasIt()));
  }
} finally {
  webChild?.kill("SIGKILL");
  release();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(`web channel alias: ${failed === 0 ? `${cells} cells OK` : `${failed} of ${cells} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
