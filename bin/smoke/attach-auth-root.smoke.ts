/**
 * `cotal attach` redeems with the seed the MESH resolved, never one walked up from the cwd (#722) -
 * pnpm smoke:attach-auth-root
 *
 * A REAL nats-server in AUTH mode, a REAL manager, a REAL supervised seat, and the REAL `cotal`
 * binary as a subprocess standing in the directory under test. The cwd is not a parameter here, it
 * is the whole experiment: the walk this suite is about only happens in a process that actually
 * stands somewhere.
 *
 * The defect: resolution picks a root from the mesh registry and connects with it, then redemption
 * asked the CURRENT DIRECTORY the same question and used whatever it answered. On a real machine
 * the two disagree rather than in theory, because `findCotalRoot` accepts any directory merely
 * NAMED `.cotal` and `~/.cotal` is one on every install (the registry lives there). A command run
 * anywhere under $HOME outside a project therefore minted its credential from the home directory's
 * trust and presented it to a broker that trusts a different chain, surfacing as a bare
 * `Authorization Violation` that named nothing.
 *
 * What runs here:
 *   A. the detector's three states on a REAL mesh pair: a divergent anchor is named, the resolved
 *      root itself is silent, an unanchored directory is silent, and a SECOND CHECKOUT holding the
 *      SAME chain is silent (a detector that fired there would be noise an operator learns to skip).
 *   B. attach from a fossil-anchored directory: the broker does not refuse it, and the shadowing
 *      anchor is REPORTED rather than obeyed.
 *   C. attach from a directory with NO anchor: it attaches through the registry-resolved trust.
 *      This is the capability that regresses the moment redemption needs a local seed, and it is
 *      asserted POSITIVELY on the banner attach prints once the session is open, not on the absence
 *      of an error.
 *   D. the refusal, where there genuinely is no seed (a raw off-registry connection), names what
 *      the command resolved and points at no internal work item.
 *
 * TWO CHAINS, ONE SPACE NAME: `createSpaceAuth` is not broker-bound, so two calls for the same
 * space yield same-named accounts with different keys. That is the fossil-anchor situation exactly,
 * without needing a decommissioned mesh to have existed.
 *
 * ANCHOR HYGIENE IS PART OF THE MEASUREMENT, NOT SETUP. Cell 1 asserts this suite's own base
 * directory has no ancestor `.cotal` before anything is measured. That is not defensive habit: on
 * the machine this was written `/private/tmp/.cotal` exists, left by unrelated tooling, so every
 * temp directory beneath it resolves THERE - and a suite that built its tree under `tmpdir()`
 * without checking would silently measure a foreign anchor and report a green.
 *
 * COTAL_HOME is sandboxed; kills ONLY the PIDs it spawns. Needs nats-server on PATH.
 */
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** An ephemeral, collision-safe loopback port (ask the OS for a free one, then release it). */
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
/** Resolve once the child has actually exited (or immediately if it already has); bounded by ms. */
const awaitExit = (p: ChildProcess, ms = 5000): Promise<void> =>
  new Promise((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once("exit", () => r());
    setTimeout(r, ms).unref?.();
  });

const home = mkdtempSync(join(tmpdir(), "cotal-authroot-home-"));
process.env.COTAL_HOME = home;

const { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity, parseCommandArgs, probeConnect, registry, serverConfig, setupSpaceStreams } = await import("@cotal-ai/core");
const { authDir, divergentCwdAnchor, findCotalRoot, recordMesh, saveSpaceAuth } = await import("@cotal-ai/workspace");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/attach) into the registry
const { Manager } = await import("@cotal-ai/manager");
import type { Command, Connector, LaunchOpts } from "@cotal-ai/core";

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "authroot";
const SEAT = "seat1";
const BIN = join(import.meta.dirname, "..", "cotal.ts");

// The tree. `tmpdir()` is the default here, and cell 1 is what makes using it honest.
const base = mkdtempSync(join(tmpdir(), "cotal-authroot-"));
const rootLive = join(base, "live");
const rootFossil = join(base, "fossil");
const rootTwin = join(base, "twin");
const workFossil = join(rootFossil, "work");
const workBare = join(base, "bare", "work");
for (const d of [rootLive, rootFossil, rootTwin, workFossil, workBare]) mkdirSync(d, { recursive: true });

/** The seat: a REAL mesh endpoint (not a bare keepalive), so the spawn's readiness resolves on
 *  presence instead of riding the 30s backstop into an `uncertain` non-success. It authenticates
 *  with the creds the MANAGER minted for it, which is the only credential in this rig that the
 *  authed broker will accept. */
const CHILD = [
  "const{pathToFileURL}=require('node:url');const fs=require('fs');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,",
  "creds:process.env.COTAL_CREDS_PATH?fs.readFileSync(process.env.COTAL_CREDS_PATH,'utf8'):undefined,",
  "lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,",
  "watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});",
].join("");
const coreDist = join(import.meta.dirname, "..", "..", "packages", "core", "dist", "index.js");
let lastOpts: LaunchOpts | undefined;
const e2eCon: Connector = {
  kind: "connector",
  name: "e2e",
  requires: ["node"],
  buildLaunch: (o) => {
    lastOpts = o;
    return {
      command: "node",
      args: ["-e", CHILD],
      env: {
        PATH: process.env.PATH ?? "",
        CORE_DIST: coreDist,
        COTAL_SPACE: o.space,
        COTAL_SERVERS: o.servers ?? "",
        COTAL_CREDS_PATH: o.creds ?? "",
        COTAL_ID: o.id ?? "",
        COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "",
        COTAL_NAME: o.name,
      },
    };
  },
};
registry.register(e2eCon);

const cmd = (name: string): Command => {
  const c = registry.all<Command>("command").find((x) => x.name === name);
  if (!c) throw new Error(`command ${name} not registered`);
  return c;
};

/** Run the REAL binary from a REAL cwd, bounded and killed rather than awaited: a successful attach
 *  streams a terminal and never returns on its own. stdin is /dev/null, so `process.stdin.isTTY` is
 *  unset and attach takes its no-terminal path - which still prints the `attached to …` banner cell
 *  C asserts on. */
async function attachFrom(cwd: string, ms = 25_000): Promise<string> {
  const p = spawnProc("npx", ["tsx", BIN, "attach", "--name", SEAT, "--space", SPACE], {
    cwd,
    env: { ...process.env, COTAL_HOME: home, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(p);
  let out = "";
  p.stdout.on("data", (b: Buffer) => void (out += b.toString()));
  p.stderr.on("data", (b: Buffer) => void (out += b.toString()));
  // Stop at the banner rather than at the timeout: the success arms are the slow ones only if we
  // insist on waiting for a stream that has no end.
  const end = Date.now() + ms;
  while (Date.now() < end && p.exitCode === null && !/attached to /.test(out)) await sleep(200);
  if (/attached to /.test(out)) await sleep(300); // let a late refusal, if any, land in the capture
  p.kill("SIGKILL");
  await awaitExit(p);
  return out.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The broker refused this connection's credential. The two failure arms of this suite are told
 *  apart by WHICH refusal, never by "something went wrong". */
const authRefused = (s: string) => /Authorization Violation/i.test(s);
const seedRefused = (s: string) => /needs this space's local seed/.test(s);
const attached = (s: string) => new RegExp(`attached to ${SEAT}`).test(s);

let mgr: InstanceType<typeof Manager> | undefined;
try {
  // ---- 1. the measurement is only valid in an unanchored tree ---------------------------------
  const walked = findCotalRoot(base);
  ok(
    "the base tree has NO ancestor .cotal, so the anchor under test is the only one in play",
    resolve(walked) === resolve(base),
    { base, walked, why: "an ancestor anchor captures every root below and would green this suite against the wrong tree" },
  );

  // ---- 2. two trust chains, one space name ------------------------------------------------------
  const live = await createSpaceAuth(SPACE);
  const fossil = await createSpaceAuth(SPACE);
  ok(
    "the two chains share a space name and NOTHING else",
    live.space === fossil.space &&
      live.account.pub !== fossil.account.pub &&
      live.sys.pub !== fossil.sys.pub &&
      live.account.signingPub !== fossil.account.signingPub,
    { space: live.space, sameAccount: live.account.pub === fossil.account.pub },
  );
  saveSpaceAuth(authDir(rootLive), live);
  saveSpaceAuth(authDir(rootFossil), fossil);
  cpSync(authDir(rootLive), authDir(rootTwin), { recursive: true });

  // ---- 3. a REAL authed broker that trusts ONLY the live chain -----------------------------------
  const storeDir = mkdtempSync(join(tmpdir(), "cotal-authroot-js-"));
  const conf = join(base, "server.conf");
  writeFileSync(conf, serverConfig(live, [live], { transport: { kind: "plaintext" }, port: PORT, storeDir, host: "127.0.0.1" }));
  const broker = spawnProc("nats-server", ["-c", conf], { stdio: "ignore" });
  kids.push(broker);
  // An AUTHED broker answers a CREDLESS probe `auth-required`, and that answer is itself proof it
  // is up. A readiness loop waiting for `ok` here would never see one, and the suite would time out
  // rather than fail - a stall reads as infrastructure, and this cell would stop being a cell.
  let serving = false;
  for (let i = 0; i < 80; i++) {
    const p = await probeConnect(SERVER, { timeoutMs: 400 });
    if (p.ok || p.reason === "auth-required") { serving = true; break; }
    await sleep(100);
  }
  ok("the authed broker is serving", serving, { server: SERVER });

  // The premise every later cell rests on, asserted instead of assumed: this broker trusts the LIVE
  // chain and REFUSES the fossil one. Without this pair the suite could run green against a broker
  // that accepts anything, and a credential minted from the wrong chain - the entire defect - would
  // be invisible to it.
  const credFrom = (a: typeof live) => mintCreds(a, newIdentity(), "probe");
  ok("the broker ACCEPTS a credential minted from the live chain", (await probeConnect(SERVER, { creds: await credFrom(live), timeoutMs: 3000 })).ok);
  // `auth-required`, not `stale-auth`, and that is the right label rather than a near miss: the
  // fossil cred is perfectly VALID, it is simply signed by an operator this broker does not know,
  // so the broker rejects it (`stale-auth` is reserved for a cred that has EXPIRED). The label is
  // also what a CREDLESS probe gets, so this cell does not discriminate on its own - the pair does.
  // One probe, one broker, two creds: the live one is accepted and the fossil one is not.
  const fossilProbe = await probeConnect(SERVER, { creds: await credFrom(fossil), timeoutMs: 3000 });
  ok("…and REFUSES one minted from the fossil chain", !fossilProbe.ok && fossilProbe.reason === "auth-required", fossilProbe);

  // The space's streams and KV buckets, which `cotal up` provisions and a hand-built broker does
  // not: without them the manager's own endpoint faults on its presence watch before any of this
  // suite's subject matter is reached.
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: await mintCreds(live, newIdentity(), "provisioner") });

  // The registry names the LIVE root. Every arm below turns on this one fact: resolution already
  // knows the right answer, and the only question is whether redemption asks it or asks the cwd.
  recordMesh({ space: SPACE, server: SERVER, root: rootLive, mode: "auth", ts: new Date().toISOString() });

  // ---- A. the detector reports where it should, and is silent everywhere else --------------------
  ok(
    "a cwd anchor carrying a DIFFERENT chain for the space is detected, and names that root",
    divergentCwdAnchor(rootLive, SPACE, workFossil)?.cwdRoot === rootFossil,
    divergentCwdAnchor(rootLive, SPACE, workFossil),
  );
  ok("standing in the resolved root itself says nothing", divergentCwdAnchor(rootLive, SPACE, rootLive) === undefined);
  ok("standing where there is no anchor at all says nothing", divergentCwdAnchor(rootLive, SPACE, workBare) === undefined);
  ok(
    "a second checkout holding the SAME chain says nothing",
    divergentCwdAnchor(rootLive, SPACE, rootTwin) === undefined,
    { why: "a second checkout of one mesh is ordinary; firing there would make the report noise" },
  );

  // ---- 4. a real supervised seat to attach to -----------------------------------------------------
  mkdirSync(join(rootLive, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(rootLive, ".cotal", "agents", "seat.md"), "---\nname: seat\nrole: worker\n---\nA supervised seat.\n");
  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: rootLive });
  await mgr.start();
  const prevCwd = process.cwd();
  process.chdir(rootLive);
  try {
    await cmd("spawn").run(
      parseCommandArgs(cmd("spawn"), ["seat", "--detach", "--agent", "e2e", "--space", SPACE, "--name", SEAT]),
    );
  } finally {
    process.chdir(prevCwd);
  }
  ok("a seat is running under the live mesh", lastOpts?.name === SEAT, lastOpts?.name);

  // ---- B. THE DEFECT: attach from a fossil-anchored directory --------------------------------------
  const fromFossil = await attachFrom(workFossil);
  ok(
    "attach from a fossil-anchored directory redeems and opens the session",
    attached(fromFossil),
    { note: "the seed came from the resolved root, not from the cwd's dead chain", out: fromFossil.slice(-900) },
  );
  ok(
    "…and the broker never refused a credential minted from the cwd's chain",
    !authRefused(fromFossil),
    fromFossil.slice(-900),
  );
  ok(
    "…and the shadowing anchor is REPORTED, naming the walked root and the one actually used",
    fromFossil.includes(rootFossil) && fromFossil.includes(rootLive) && /DIFFERENT trust chain/.test(fromFossil),
    fromFossil.slice(-900),
  );

  // ---- C. the capability that regresses: attach from a directory with no anchor ---------------------
  const fromBare = await attachFrom(workBare);
  ok("attach from an UNANCHORED directory attaches through the registry-resolved trust", attached(fromBare), fromBare.slice(-900));
  ok("…and was not refused for a missing local seed", !seedRefused(fromBare) && !authRefused(fromBare), fromBare.slice(-900));
  ok("…and says nothing about a shadowing anchor, because there is none", !/DIFFERENT trust chain/.test(fromBare), fromBare.slice(-900));

  // ---- D. redemption never sees a target with no resolved root -----------------------------------
  // `attachNoSeedMessage` carries an arm for a connection that resolved NO checkout root, because
  // the type says one is possible. This pair is why that arm is written as an invariant rather than
  // as advice: BOTH off-registry routes are refused before a grant is ever asked for, so redemption
  // cannot be reached in that state today. Measured here rather than argued, because the day a
  // third route appears this is the cell that notices.
  const credFile = join(base, "raw.creds");
  writeFileSync(credFile, await mintCreds(live, newIdentity(), "control-caller-admin", { lifecycleUid: mintLifecycleUid() }));
  const runCli = (argv: string[]) => {
    const r = spawnSync("npx", ["tsx", BIN, ...argv], {
      cwd: workBare,
      env: { ...process.env, COTAL_HOME: home, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "") };
  };
  const rawOpen = runCli(["attach", "--name", SEAT, "--space", "not-registered", "--server", SERVER]);
  ok(
    "an off-registry --server on an unregistered space is refused for missing credentials",
    rawOpen.status !== 0 && /requires auth, but no credentials were supplied/.test(rawOpen.out),
    rawOpen,
  );
  const rawCreds = runCli(["attach", "--name", SEAT, "--creds", credFile, "--server", SERVER, "--space", SPACE]);
  ok(
    "a raw --creds attach is refused at the control surface",
    rawCreds.status !== 0 && /control surface/.test(rawCreds.out),
    rawCreds,
  );
  ok(
    "…and neither raw route reached redemption, so neither could print a blank root",
    ![rawOpen.out, rawCreds.out].some((o) => /needs this space's local seed|DIFFERENT trust chain/.test(o)),
    { rawOpen: rawOpen.out.slice(-300), rawCreds: rawCreds.out.slice(-300) },
  );
  ok(
    "no user-facing refusal on any route points at an internal work item",
    ![rawOpen.out, rawCreds.out, fromFossil, fromBare].some((o) => /#\d+\b|follow-up/.test(o)),
    { rawOpen: rawOpen.out.slice(-300) },
  );

  console.log(`\nattach auth-root: ${pass} checks passed`);
} finally {
  await mgr?.stop().catch(() => {});
  await Promise.all(kids.map((k) => { k.kill("SIGKILL"); return awaitExit(k); }));
}
