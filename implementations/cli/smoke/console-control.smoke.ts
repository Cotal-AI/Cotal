/**
 * CONSOLE CONTROL smoke: the operator verbs driven through the REAL console TUI under node-pty,
 * against TWO real managers in one static-auth space, each hosting a mesh-joining seat.
 * pnpm --filter @cotal-ai/cli smoke:console-control (needs nats-server + node; drives
 * `bin/cotal.ts`, so the CLI's and the manager's dist must be built).
 *
 *   1. `:ps` lists the seats of BOTH managers (the scatter merge; a single class-queue answer
 *      would name one manager's seats only).
 *   2. `:status <seat>` finds a seat on EITHER manager, repeatedly: the inspect is located and
 *      pinned to the hosting manager like stop/attach, never a class-queue guess. The locate step
 *      is also proven on its own, deterministically: `:status` on a seat no manager hosts is
 *      refused by the locate with a sentence naming both reachable managers, where a class-queue
 *      inspect would answer with one manager's own not-found error.
 *   3. `D` then `f` force-kills the seat on manager 2 (targeted, so pinned to its host).
 *   4. `:spawn <persona> <name>` submits the spawn action under the REQUESTED name (not the
 *      persona's), shows the accepted name, and the new seat joins the roster.
 *   5. `D` then `y` despawns it gracefully (the notice, then the seat gone from the roster).
 *   6. `:purge` behind the typed-space-name confirm empties the space's history.
 *   4 to 6 run with manager 2 stopped: the spawn action and purge ride the class queue, like
 *   `cotal spawn --detach` and `cotal purge` without `--on`, and a class-queue call on a
 *   multi-manager space can be refused by a member the caller did not bind to (SPEC 13.2).
 *
 * The seats are real endpoints (they register presence with the creds the manager minted and say
 * hello on #general), so the roster sees them come and go and the space has history to purge. The managers are loaded from the manager's built package, as in
 * the attach smoke: this package does not depend on the manager.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, registry, serverConfig, setupSpaceStreams, type Connector, type LaunchOpts, type LaunchSpec, type Presence } from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { ConsoleSession, clean, repoRoot, wait } from "./_console-pty.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra?: unknown) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ FAIL: " + n, extra ?? ""); } };
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
async function until<T>(probe: () => T | undefined, ms: number): Promise<T | undefined> {
  const t0 = Date.now();
  let v = probe();
  while (v === undefined && Date.now() - t0 < ms) { await wait(150); v = probe(); }
  return v;
}

interface ManagerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  startAgent(o: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}
const { Manager } = (await import(pathToFileURL(join(repoRoot, "implementations", "manager", "dist", "index.js")).href)) as {
  Manager: new (o: { space: string; servers: string; runtime: string; workspaceRoot: string }) => ManagerLike;
};

// A seat that JOINS the mesh: a CotalEndpoint under the creds the manager minted for it, so the
// spawn settles on presence and the roster carries the seat. It idles until killed.
const coreDist = join(repoRoot, "packages", "core", "dist", "index.js");
const CHILD = [
  "const{pathToFileURL}=require('node:url');const fs=require('fs');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,",
  "creds:process.env.COTAL_CREDS_PATH?fs.readFileSync(process.env.COTAL_CREDS_PATH,'utf8'):undefined,",
  "lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,",
  "watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent',role:'worker'}});",
  "ep.on('error',()=>{});await ep.start();await ep.multicast('hello from '+process.env.COTAL_NAME,{channel:'general'});setInterval(()=>{},1000);});",
].join("");
const seatCon: Connector = {
  kind: "connector", name: "seat", requires: ["node"],
  buildLaunch: (o: LaunchOpts): LaunchSpec => ({
    command: "node", args: ["-e", CHILD],
    env: { PATH: process.env.PATH ?? "", CORE_DIST: coreDist, COTAL_SPACE: o.space, COTAL_SERVERS: o.servers ?? "", COTAL_CREDS_PATH: o.creds ?? "", COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name },
  }),
};
registry.register(seatCon);

const space = `ctl-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home; // set BEFORE recordMesh: never touch ~/.cotal
const mkRoot = (tag: string, personas: string[]): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  for (const p of personas) writeFileSync(join(r, ".cotal", "agents", `${p}.md`), `---\nname: ${p}\nrole: worker\nagent: seat\nsubscribe: [general]\nallowPublish: [general]\n---\n`);
  saveSpaceAuth(authDir(r), auth);
  return r;
};
const root1 = mkRoot("ws1", ["w1", "w3"]);
const root2 = mkRoot("ws2", ["w2"]);
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(srv, dir);
recordMesh({ space, server: servers, root: root1, mode: "auth", ts: new Date().toISOString() });

const m1 = new Manager({ space, servers, runtime: "pty", workspaceRoot: root1 });
const m2 = new Manager({ space, servers, runtime: "pty", workspaceRoot: root2 });
let session: ConsoleSession | undefined;
let watcher: CotalEndpoint | undefined;
let poster: CotalEndpoint | undefined;
const live = (name: string): Presence | undefined => watcher?.getRoster().find((p) => p.card.name === name && p.status !== "offline");
try {
  let up = false;
  for (let i = 0; i < 50 && srv.exitCode === null; i++) { if (await isReachable(servers)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const admin = await mintCreds(auth, newIdentity(), "admin");
  watcher = new CotalEndpoint({ space, servers, creds: admin, card: { name: "watcher", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true });
  watcher.on("error", () => {});
  await watcher.start();
  // An admin (read-only, god-view) endpoint for history reads; the seats themselves write the history.
  poster = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "admin"), card: { name: "reader", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  poster.on("error", () => {});
  await poster.start();

  await m1.start();
  await m2.start();
  const s1 = await m1.startAgent({ name: "w1", agent: "seat", cwd: repoRoot });
  const s2 = await m2.startAgent({ name: "w2", agent: "seat", cwd: repoRoot });
  check("fixture: manager 1 hosts w1 and manager 2 hosts w2, both joined", s1.ok && s2.ok && !!(await until(() => (live("w1") && live("w2") ? true : undefined), 15_000)), { s1, s2, roster: watcher.getRoster().map((p) => p.card.name) });

  session = new ConsoleSession(["--space", space, "--server", servers], home, {}, { cols: 140, rows: 36 });
  const s = session;
  check("console: the TUI paints", await s.waitFor(`${space} · #`, 40_000), clean(s.out).slice(-300));

  console.log("1. :ps merges both managers");
  let m = s.mark();
  await s.command("ps");
  check(":ps lists the seats of both managers", await s.waitFor(/agents: (w1, w2|w2, w1)/, 30_000, m), clean(s.out.slice(m)).match(/(agents: |ps: )[^│\n]*/)?.[0] ?? clean(s.out.slice(m)).slice(-300));

  console.log("2. :status finds a seat on either manager, every time");
  let hits = 0;
  for (const seat of ["w2", "w1", "w2", "w1", "w2", "w2"]) {
    await wait(3_300); // the previous notice auto-clears after 3 s; a stale one must not match
    m = s.mark();
    await s.command(`status ${seat}`);
    if (await s.waitFor(new RegExp(`${seat} \\(worker\\) · seat · pty · running`), 20_000, m)) hits++;
    else console.log(`    status ${seat} answered: ${clean(s.out.slice(m)).match(/status: [^│\n]*/)?.[0] ?? "(nothing)"}`);
  }
  await wait(3_300);
  check(":status <seat> is answered by the seat's own manager on every try (6/6, both hosts)", hits === 6, { hits });
  m = s.mark();
  await s.command("status nobody");
  const t0 = Date.now();
  const located = await s.waitFor(/status: no managed agent "nobody" on any of the 2 reachable manager instance\(s\)/, 90_000, m);
  check(":status on a seat no manager hosts is refused by the locate step, naming both reachable managers", located, { after: `${Math.round((Date.now() - t0) / 1000)}s`, notice: clean(s.out.slice(m)).match(/status: [^│\n]*/g)?.slice(-2), tail: clean(s.out.slice(m)).slice(-200) });

  console.log("3. D f force-kills the seat on manager 2 (targeted, pinned to its host)");
  const select = async (name: string) => {
    await s.keys("\x1b", 300);
    await s.keys("/", 400); await s.keys(name, 300); await s.keys("\r", 500);
    await s.keys("l", 400);
    for (let i = 0; i < 6; i++) await s.keys("k", 80);
  };
  await select("w2");
  m = s.mark();
  await s.keys("D", 800);
  check("D opens the kill confirm", await s.waitFor(/y = stop \(graceful\)/, 5_000, m), clean(s.out.slice(m)).slice(-300));
  await s.keys("f", 300);
  check("f: the notice reports the force-kill", await s.waitFor(/force-killed w2/, 60_000, m), clean(s.out.slice(m)).match(/(force-killing|force-killed|stopped|stop:)[^│\n]*/g)?.join(" | "));
  check("...and w2 leaves the roster", !!(await until(() => (live("w2") ? undefined : true), 15_000)), watcher.getRoster().map((p) => `${p.card.name}:${p.status}`));
  await s.keys("\x1b", 300);

  // The spawn action and purge ride the class queue, like `cotal spawn --detach` and `cotal purge`
  // without `--on`: on a multi-manager space a class-queue call can reach a member the caller did
  // not bind to and is refused (SPEC 13.2). They are proven here on the one manager left.
  await m2.stop();
  await wait(1500);

  console.log("4. :spawn submits the spawn action under the requested name");
  m = s.mark();
  await s.command("spawn w3 seat3");
  check(":spawn shows the accepted name, the one requested rather than the persona's", await s.waitFor(/spawned seat3/, 60_000, m), clean(s.out.slice(m)).match(/spawn(ed|ing|:)[^│\n]*/g)?.join(" | ") ?? clean(s.out.slice(m)).slice(-400));
  check("...and the new seat joins the roster under that name", !!(await until(() => (live("seat3") ? true : undefined), 15_000)), watcher.getRoster().map((p) => `${p.card.name}:${p.status}`));

  console.log("5. D y despawns it gracefully");
  await select("seat3");
  m = s.mark();
  await s.keys("D", 800);
  await s.keys("y", 300);
  check("y: the notice reports the graceful stop", await s.waitFor(/stopped seat3/, 60_000, m), clean(s.out.slice(m)).match(/(stopping|stopped|stop:)[^│\n]*/g)?.join(" | "));
  check("...and seat3 leaves the roster", !!(await until(() => (live("seat3") ? undefined : true), 15_000)), watcher.getRoster().map((p) => `${p.card.name}:${p.status}`));
  await s.keys("\x1b", 300);

  console.log("6. :purge behind the typed-space-name confirm");
  check("fixture: the space has history before the purge (each seat said hello)", (await poster.channelHistory("general")).length >= 2, await poster.channelHistory("general"));
  m = s.mark();
  await s.command("purge");
  check("purge: the typed-space-name confirm opens", await s.waitFor(/Purge .* history \(all channels\)/, 8_000, m), clean(s.out.slice(m)).slice(-300));
  await s.keys(space, 300);
  await s.keys("\r", 300);
  check("purge: the notice confirms it", await s.waitFor(/purged space history/, 30_000, m), clean(s.out.slice(m)).match(/purg[^│\n]*/g)?.join(" | "));
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { gone = (await poster.channelHistory("general")).length === 0; if (!gone) await wait(300); }
  check("purge: the space history is gone", gone, await poster.channelHistory("general"));
  check("console quits cleanly", await s.quit(), s.exited);
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  try { await session?.close(); } catch { /* down */ }
  try { await m1.stop(); } catch { /* down */ }
  try { await m2.stop(); } catch { /* down */ }
  try { await poster?.stop(); } catch { /* down */ }
  try { await watcher?.stop(); } catch { /* down */ }
  srv.kill("SIGTERM");
  await wait(300);
  release();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "CONSOLE-CONTROL SMOKE OK ✅" : "CONSOLE-CONTROL SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
