/**
 * WHAT THE DASHBOARD CAN POST AS, decided once at startup and reported in `/api/meta`.
 *
 * `cotal send` mints a fresh operator credential with a NEW identity on every call, so an agent's
 * replies to two sends land in two DM threads. The dashboard instead holds ONE operator for the
 * life of the process: on a static-auth mesh its credential is minted at startup, before the seed
 * is dropped, and on an open mesh it keeps one id. It joins the roster only on the first post.
 *
 * Section 1 is the decision itself, as a function, because a per-user sign-in mesh needs an auth
 * service this suite does not stand up. Sections 2 to 4 run the SHIPPED `web` entry point
 * (`run-web.mts`) against real brokers: an open one, a static-auth one recorded in a scratch
 * registry, and the static one again through a raw `--creds` file. Section 5 drives the poster's
 * lazy start in-process, because the route that posts arrives with the send task, and section 6
 * pins the credential's lifetime against the reconnect fence in core.
 *
 * COTAL_HOME and XDG_CONFIG_HOME are scratch, and every child runs from a scratch directory, so no
 * lookup reaches the operator's own `~/.cotal`. Kills only the processes it spawns. Needs
 * nats-server on PATH. Run: pnpm smoke:web-post-capability
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PortInUseError, SMOKE_BROKER_TOKEN, freePort, onFreePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

const base = mkdtempSync(join(tmpdir(), "cotal-postcap-"));
const home = join(base, "home");
const xdg = join(base, "xdg");
const work = join(base, "work");
for (const d of [home, xdg, work]) mkdirSync(d, { recursive: true });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";

const { CotalEndpoint, createSpaceAuth, credsClaims, isReachable, mintCreds, mintLifecycleUid, newIdentity, probeConnect, serverConfig, setupSpaceStreams } =
  await import("@cotal-ai/core");
const { authDir, recordMesh, saveSpaceAuth } = await import("@cotal-ai/workspace");
const { OPERATOR_TTL_SECONDS, POSTER_STOPPED, POST_OFF_CREDS, POST_OFF_USER, mintOperatorCred, operatorPoster, postCapability } = await import("../src/web.js");

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) { console.log(`  ok ${name}`); return; }
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Web { child: ChildProcess; port: number; cookie: string; log: () => string }
type Row = { card: { id: string; name?: string; role?: string }; status: string };

const kids: ChildProcess[] = [];
const releases: Array<() => void> = [];
const stores: string[] = [];

/** One `cotal web` child, signed in through its own launch link, from the scratch directory. */
async function startWeb(args: string[]): Promise<Web> {
  let log = "";
  let launchUrl: string | undefined;
  let child: ChildProcess | undefined;
  const port = await onFreePort(async (p) => {
    // tsx by its resolved path: the child runs from the scratch directory, where a bare `tsx` does
    // not resolve.
    child = spawn(process.execPath, [
      "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./run-web.mts", import.meta.url)),
      ...args, "--port", String(p), "--no-open",
    ], { cwd: work, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    kids.push(child);
    child.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
    const taken = `Port ${p} is in use`;
    for (let i = 0; i < 200 && launchUrl === undefined && !log.includes(taken) && child.exitCode === null; i++) {
      launchUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+/)?.[0];
      await wait(250);
    }
    if (launchUrl === undefined && log.includes(taken)) throw new PortInUseError(p, log);
    return p;
  });
  const exchange = launchUrl === undefined ? undefined : await fetch(launchUrl, { redirect: "manual" }).catch(() => undefined);
  const session = /(?:^|,\s*)cotal_web_session=([^;]+)/.exec(exchange?.headers.get("set-cookie") ?? "")?.[1];
  return { child: child!, port, cookie: `cotal_web_session=${session}`, log: () => log };
}
const getJson = async (w: Web, path: string): Promise<unknown> => {
  const r = await fetch(`http://127.0.0.1:${w.port}${path}`, { headers: { cookie: w.cookie } }).catch(() => undefined);
  return r?.ok ? r.json() : undefined;
};
const meta = (w: Web) => getJson(w, "/api/meta") as Promise<Record<string, unknown> | undefined>;
const roster = async (w: Web) => ((await getJson(w, "/api/roster")) ?? []) as Row[];
/** Polls the dashboard's roster until `bot` shows, so an absent operator is measured on a roster
 *  that is demonstrably live and not on one that has not filled yet. */
async function rosterOnceBotShows(w: Web, botId: string): Promise<Row[] | undefined> {
  for (let i = 0; i < 80; i++) {
    const rows = await roster(w);
    if (rows.some((r) => r.card.id === botId && r.status !== "offline")) return rows;
    await wait(150);
  }
  return undefined;
}
const stopWeb = async (w: Web) => {
  w.child.kill("SIGTERM");
  for (let i = 0; i < 40 && w.child.exitCode === null && w.child.signalCode === null; i++) await wait(100);
  if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL");
};

async function startBroker(args: (store: string) => string[], server: string, creds?: string): Promise<void> {
  const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  stores.push(store);
  const broker = spawn("nats-server", args(store), { stdio: "ignore" });
  kids.push(broker);
  releases.push(teardownOnSignal(broker, store));
  for (let i = 0; i < 80; i++) {
    const p = creds ? await probeConnect(server, { creds, timeoutMs: 400 }) : { ok: await isReachable(server) };
    if (p.ok) return;
    await wait(150);
  }
  throw new Error(`nats-server did not start at ${server}`);
}

try {
  // ---- 1. the decision ---------------------------------------------------------------------------
  console.log("1. the decision");
  ok("1.1 a mesh the dashboard holds its own way onto can post, as a participant", same(postCapability(undefined, false), { mode: "participant" }));
  ok("1.2 a raw --creds file turns posting off, with the reason it gives", same(postCapability("/x.creds", false), { mode: "off", reason: POST_OFF_CREDS }));
  ok("1.3 a per-user sign-in mesh turns posting off, with the reason it gives", same(postCapability(undefined, true), { mode: "off", reason: POST_OFF_USER }));

  // ---- 2. an open mesh ---------------------------------------------------------------------------
  console.log("2. an open mesh");
  const openPort = await freePort();
  const OPEN = `nats://127.0.0.1:${openPort}`;
  await startBroker((s) => ["-p", String(openPort), "-js", "-sd", s, "-a", "127.0.0.1"], OPEN);
  await setupSpaceStreams({ servers: OPEN, space: "postopen" });
  const openWeb = await startWeb(["--server", OPEN, "--space", "postopen"]);
  const openMeta = await meta(openWeb);
  ok("2.0 the shipped `web` entry point serves on the open mesh", openMeta !== undefined, openWeb.log().slice(-400));
  ok("2.1 an open mesh reports participant, with no operatorId before a post",
    same(openMeta?.post, { mode: "participant" }) && openMeta !== undefined && !("operatorId" in openMeta), openMeta);
  const openBot = new CotalEndpoint({ space: "postopen", servers: OPEN, card: { name: "bot", kind: "agent" }, channels: [], consume: false, registerPresence: true, watchPresence: false });
  openBot.on("error", () => {});
  await openBot.start();
  const openRows = await rosterOnceBotShows(openWeb, openBot.card.id);
  ok("2.2 on an open mesh the operator is not on the roster before a post, on a roster that shows a peer that joined after it",
    openRows !== undefined && !openRows.some((r) => r.card.name === "operator" || r.card.role === "operator"), openRows);
  await openBot.stop();
  await stopWeb(openWeb);

  // ---- 3. a static-auth mesh ---------------------------------------------------------------------
  console.log("3. a static-auth mesh");
  const SPACE = "poststatic";
  const root = join(base, "root");
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(root), auth);
  const staticPort = await freePort();
  const STATIC = `nats://127.0.0.1:${staticPort}`;
  const probe = await mintCreds(auth, newIdentity(), "provisioner");
  await startBroker((s) => {
    const conf = join(s, "server.conf");
    writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: staticPort, storeDir: s, host: "127.0.0.1" }));
    return ["-c", conf];
  }, STATIC, probe);
  await setupSpaceStreams({ servers: STATIC, space: SPACE, creds: probe });
  recordMesh({ space: SPACE, server: STATIC, root, mode: "auth", ts: new Date().toISOString() });

  const staticWeb = await startWeb(["--space", SPACE]);
  const m1 = await meta(staticWeb);
  const m2 = await meta(staticWeb);
  ok("3.0 the shipped `web` entry point serves on the static mesh", m1 !== undefined, staticWeb.log().slice(-400));
  ok("3.1 a static mesh reports participant with an operatorId, the same across two /api/meta reads",
    same(m1?.post, { mode: "participant" }) && typeof m1?.operatorId === "string" && m1.operatorId === m2?.operatorId,
    { m1, m2 });
  ok("3.2 the operatorId names a minted credential's identity, not a self-assigned one",
    typeof m1?.operatorId === "string" && /^local\.U[A-Z2-7]{55}$/.test(m1.operatorId), m1?.operatorId);
  const staticBot = new CotalEndpoint({
    space: SPACE, servers: STATIC, creds: await mintCreds(auth, newIdentity(), "operator", { expiresInSeconds: 600 }),
    lifecycleUid: mintLifecycleUid(), card: { name: "bot", kind: "endpoint" }, channels: [], consume: false, registerPresence: true, watchPresence: false,
  });
  staticBot.on("error", () => {});
  await staticBot.start();
  const staticRows = await rosterOnceBotShows(staticWeb, staticBot.card.id);
  ok("3.3 on a static mesh the operator is not on the roster before a post, on a roster that shows a peer that joined after it",
    staticRows !== undefined && !staticRows.some((r) => r.card.id === m1?.operatorId || r.card.name === "operator"), staticRows);
  await staticBot.stop();
  await stopWeb(staticWeb);

  // ---- 4. a raw --creds file ---------------------------------------------------------------------
  console.log("4. a raw --creds file");
  const credsFile = join(base, "admin.creds");
  writeFileSync(credsFile, await mintCreds(auth, newIdentity(), "admin"), { mode: 0o600 });
  const credsWeb = await startWeb(["--creds", credsFile, "--server", STATIC, "--space", SPACE]);
  const credsMeta = await meta(credsWeb);
  ok("4.0 the shipped `web` entry point serves on a --creds file", credsMeta !== undefined, credsWeb.log().slice(-400));
  ok("4.1 --creds reports off with POST_OFF_CREDS, and no operatorId",
    same(credsMeta?.post, { mode: "off", reason: POST_OFF_CREDS }) && credsMeta !== undefined && !("operatorId" in credsMeta), credsMeta);
  await stopWeb(credsWeb);

  // ---- 5. the poster's lazy start ----------------------------------------------------------------
  console.log("5. the poster's lazy start");
  // Every operator start is counted and its id recorded, and the next one can be made to fail
  // before it touches the broker, the way a refused connect fails.
  const starts = { n: 0, last: "", failNext: false, failAfterConnect: false, failedId: "" };
  /** How long the stop of a start that failed after connecting is held back. */
  const STOP_DELAY_MS = 1500;
  const realStart = CotalEndpoint.prototype.start;
  CotalEndpoint.prototype.start = function (this: InstanceType<typeof CotalEndpoint>) {
    if (this.card.name === "operator") {
      starts.n++;
      starts.last = this.card.id;
      if (starts.failNext) {
        starts.failNext = false;
        starts.failedId = this.card.id;
        return Promise.reject(new Error("injected start failure"));
      }
      if (starts.failAfterConnect) {
        // Connected and registered, then failed, and its stop held back: if the retry does not wait
        // for that stop, the offline record lands after the retried operator's online one.
        starts.failAfterConnect = false;
        starts.failedId = this.card.id;
        const realStop = this.stop.bind(this);
        this.stop = async () => { await wait(STOP_DELAY_MS); return realStop(); };
        return realStart.call(this).then(() => { throw new Error("injected failure after connect"); });
      }
    }
    return realStart.call(this);
  };
  /** One poster through a failed first start and a retry, read against a watcher's roster. */
  const retried = async (poster: ReturnType<typeof operatorPoster>, roster: () => Array<{ card: { id: string }; status: string }>) => {
    const before = poster.operatorId();
    starts.failNext = true;
    const first = await poster.ensure().then(() => "resolved", (e: Error) => e.message);
    const second = await poster.ensure().then((e) => e.card.id, (e: Error) => `rejected: ${e.message}`);
    const id = poster.operatorId();
    const joined = await until(() => roster().some((p) => p.card.id === id && p.status !== "offline"));
    await poster.stop();
    return { before, failedId: starts.failedId, first, second, id, joined };
  };
  const watcher = new CotalEndpoint({ space: "postopen", servers: OPEN, card: { name: "watcher", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: true });
  watcher.on("error", () => {});
  await watcher.start();
  const until = async (pred: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 80; i++) { if (pred()) return true; await wait(100); }
    return pred();
  };
  const openPoster = operatorPoster({ space: "postopen", server: OPEN, tls: false }, undefined);
  ok("5.1 an open poster reports no operatorId before its first post", openPoster.operatorId() === undefined);
  // Settled rather than awaited together, so a start that throws is this cell's failure and not a
  // crash that hides it.
  const both = await Promise.allSettled([openPoster.ensure(), openPoster.ensure()]);
  const [a, b] = both.map((r) => (r.status === "fulfilled" ? r.value : undefined));
  ok("5.2 two concurrent first posts start one endpoint", a !== undefined && a === b && starts.n === 1,
    { settled: both.map((r) => (r.status === "fulfilled" ? "fulfilled" : String(r.reason))), starts: starts.n });
  const openId = openPoster.operatorId();
  const joined = await until(() => watcher.getRoster().some((p) => p.card.id === openId && p.status !== "offline"));
  ok("5.3 after its first post the open operator is on the roster as operator, under the id it reports",
    openId !== undefined && openId === a?.card.id && joined
    && watcher.getRoster().some((p) => p.card.id === openId && p.card.name === "operator" && p.card.role === "operator" && p.card.kind === "endpoint"),
    { openId, roster: watcher.getRoster().map((p) => ({ id: p.card.id, name: p.card.name, status: p.status })) });
  await openPoster.ensure().catch(() => undefined);
  ok("5.4 a later post reuses the started endpoint", starts.n === 1, starts.n);
  await openPoster.stop();
  ok("5.5 stopping the poster leaves an offline record", await until(() => watcher.getRoster().some((p) => p.card.id === openId && p.status === "offline")),
    watcher.getRoster().map((p) => ({ id: p.card.id, status: p.status })));

  const openRetry = await retried(operatorPoster({ space: "postopen", server: OPEN, tls: false }, undefined), () => watcher.getRoster());
  ok("5.9 an open poster whose first start fails starts on the next post, joins the roster, and keeps the id of the start that failed",
    openRetry.first === "injected start failure" && openRetry.second === openRetry.id && openRetry.joined
    && openRetry.id !== undefined && openRetry.id === openRetry.failedId, openRetry);

  ok("5.10 after the poster stops, a post is refused",
    (await openPoster.ensure().then(() => "resolved", (e: Error) => e.message)) === POSTER_STOPPED);
  const closing = operatorPoster({ space: "postopen", server: OPEN, tls: false }, undefined);
  const pending = closing.ensure().then(() => "resolved", (e: Error) => e.message);
  await closing.stop();
  const closingId = starts.last;
  const outcome = await pending;
  const wentOffline = await until(() => watcher.getRoster().some((p) => p.card.id === closingId && p.status === "offline"));
  ok("5.11 a post in flight when the poster stops is refused, and the endpoint it started is not left online",
    outcome === POSTER_STOPPED && wentOffline, { outcome, roster: watcher.getRoster().filter((p) => p.card.id === closingId).map((p) => p.status) });

  // Judged on the watcher's presence events in stream order rather than on a roster sampled at a
  // moment: the retried operator heartbeats every 2 s, which would put a stray offline record right
  // back online before a sample could see it.
  const lateEvents: Array<{ id: string; type: string; uid?: string }> = [];
  watcher.on("presence", (ev: { type: string; presence: { card: { id: string }; lifecycleUid?: string } }) =>
    lateEvents.push({ id: ev.presence.card.id, type: ev.type, uid: ev.presence.lifecycleUid }));
  const late = operatorPoster({ space: "postopen", server: OPEN, tls: false }, undefined);
  starts.failAfterConnect = true;
  const lateFirst = await late.ensure().then(() => "resolved", (e: Error) => e.message);
  const lateSecond = await late.ensure().then((e) => e.card.id, (e: Error) => `rejected: ${e.message}`);
  const lateId = late.operatorId();
  const lateJoined = await until(() => watcher.getRoster().some((p) => p.card.id === lateId && p.status !== "offline"));
  await wait(STOP_DELAY_MS + 500); // past the held-back stop
  const mine = lateEvents.filter((e) => e.id === lateId);
  const failedUid = mine.find((e) => e.type !== "offline")?.uid;
  const successorAt = mine.findIndex((e) => e.type !== "offline" && e.uid !== failedUid);
  const offlineAfter = successorAt >= 0 && mine.slice(successorAt).some((e) => e.type === "offline");
  ok("5.13 a start that fails after connecting is stopped before the retry starts, so its offline record cannot land over the retried operator's online one",
    lateFirst === "injected failure after connect" && lateSecond === lateId && lateId === starts.failedId && lateJoined
    && successorAt > 0 && !offlineAfter, { lateFirst, lateSecond, lateId, failedId: starts.failedId, lateJoined, events: mine });
  await late.stop();
  await watcher.stop();

  const operator = await mintOperatorCred(auth);
  const staticPoster = operatorPoster({ space: SPACE, server: STATIC, tls: false }, operator);
  const idBefore = staticPoster.operatorId();
  ok("5.6 a static poster reports its operatorId before its first post", typeof idBefore === "string", idBefore);
  const staticWatcher = new CotalEndpoint({ space: SPACE, servers: STATIC, creds: await mintCreds(auth, newIdentity(), "admin"), card: { name: "watcher", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: true });
  staticWatcher.on("error", () => {});
  await staticWatcher.start();
  let staticStarted: string | undefined;
  try { staticStarted = (await staticPoster.ensure()).card.id; } catch (e) { staticStarted = `threw: ${(e as Error).message}`; }
  const staticJoined = await until(() => staticWatcher.getRoster().some((p) => p.card.id === idBefore && p.status !== "offline"));
  ok("5.7 the static operator joins the roster on its first post, under the id it reported before", staticStarted === idBefore && staticJoined,
    { idBefore, staticStarted });
  await staticPoster.stop();
  const staticRetry = await retried(operatorPoster({ space: SPACE, server: STATIC, tls: false }, await mintOperatorCred(auth)), () => staticWatcher.getRoster());
  ok("5.12 a static poster whose first start fails starts on the next post, joins the roster, and keeps the id it reported before",
    staticRetry.first === "injected start failure" && staticRetry.second === staticRetry.id && staticRetry.joined
    && staticRetry.before !== undefined && staticRetry.id === staticRetry.before && staticRetry.failedId === staticRetry.before, staticRetry);
  await staticWatcher.stop();
  CotalEndpoint.prototype.start = realStart;

  ok("5.8 the poster reports an expired credential only once it has expired",
    !operatorPoster({ space: SPACE, server: STATIC, tls: false }, { ...operator, expiresAt: Date.now() + 60_000 }).expired()
    && operatorPoster({ space: SPACE, server: STATIC, tls: false }, { ...operator, expiresAt: Date.now() - 1 }).expired()
    && !operatorPoster({ space: SPACE, server: STATIC, tls: false }, undefined).expired());

  // ---- 6. the credential's lifetime --------------------------------------------------------------
  console.log("6. the credential's lifetime");
  const claims = credsClaims(operator.creds);
  ok("6.1 the operator credential lives 24 days, under the 2^31-1 ms a timer in core can hold",
    OPERATOR_TTL_SECONDS === 24 * 24 * 3600 && claims.exp !== undefined && claims.iat !== undefined
    && claims.exp - claims.iat === OPERATOR_TTL_SECONDS && OPERATOR_TTL_SECONDS * 1000 < 2 ** 31 - 1, claims);
  ok("6.2 the poster keeps the expiry the credential carries", claims.exp !== undefined && operator.expiresAt === claims.exp * 1000,
    { expiresAt: operator.expiresAt, exp: claims.exp });
} finally {
  for (const k of kids) k.kill("SIGKILL");
  for (const r of releases) r();
  for (const s of stores) rmSync(s, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}

console.log(`web post capability: ${failed === 0 ? `${cells} cells OK` : `${failed} of ${cells} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
