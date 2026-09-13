/**
 * `cotal attach` redeems an open mesh's session grant WITHOUT a local seed, and a sealed mesh with
 * no seed still refuses by name (#1205) - pnpm smoke:attach-open-mode
 *
 * THE DEFECT. The session redeem path minted a per-session caller credential from this space's
 * local seed, and treated the ABSENCE of that seed as "the seed is missing". An open-mode mesh has
 * no seed BY DESIGN — there is no credential system on it at all — so the refusal fired on exactly
 * the configuration attach exists to serve, and pointed the operator at re-registering a root the
 * mesh had already resolved correctly.
 *
 * THE SHAPE OF THE FIX, and therefore the shape of this suite. Which contract redeems a grant is
 * the RECORDED mesh mode, and it is carried as a value (`RedeemLink`) rather than inferred from a
 * nullable credential. So this suite grades the DECISION and the CONNECT OPTIONS separately, and
 * then grades both against real brokers:
 *
 *   BRANCH TABLE (in-process, `attachSessionMaterial`) — one REFUSING case per ACCEPTING branch,
 *   differing from it only by context, because a suite that exercises only the accepting shape
 *   would have passed before the fix:
 *     ACCEPT  open, no seed               → bare        REFUSE  sealed, no seed      (mode differs)
 *     ACCEPT  open, seed present on disk  → bare        REFUSE  user, seed present   (mode differs)
 *     ACCEPT  sealed, seed present        → mint        REFUSE  unrecorded, no seed  (mode differs)
 *
 *   CONNECT OPTIONS (in-process, `redeemConnectOpts`): a bare link must carry NO credential (the
 *   fix must not invent or synthesise one for an open mesh) and a session-caller link must carry
 *   the exact one it was given (the fix must not drop it), each with the transport preserved.
 *
 *   LIVE OPEN: a real open-mode nats-server, a real manager, a real supervised seat, and the real
 *   `cotal` binary in a root whose `.cotal/auth` holds no seed. It must print `attached to`.
 *
 *   LIVE SEALED: a real AUTHED nats-server that is proven to be serving, registered as mode `auth`
 *   against a root that holds no seed. Attach must REFUSE, name the sealed contract, and never take
 *   the open path. This is the cell a fix that "solves" #1205 by relaxing the seed check breaks,
 *   which is why it is asserted against a live broker rather than in prose.
 *
 * THIS FILE IS ALSO THE PRE-FIX CONTROL. The new exports are looked up by name rather than imported
 * as bindings, so the same suite RUNS against a tree that predates the fix instead of dying at
 * import. On such a tree the branch-table cells red on the missing decision and the LIVE OPEN cell
 * reds on the #1205 refusal itself — which is the control: a probe that could only ever run against
 * the fixed shape would prove nothing.
 *
 * COTAL_HOME and XDG_CONFIG_HOME are sandboxed. Needs nats-server on PATH. Kills only the PIDs it
 * spawns, and stops the manager WITH its agents so no supervised child outlives the run.
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const home = mkdtempSync(join(tmpdir(), "cotal-openattach-home-"));
process.env.COTAL_HOME = home;

const { createSpaceAuth, mintCreds, newIdentity, parseCommandArgs, probeConnect, registry, serverConfig } = await import("@cotal-ai/core");
const { ConnectRefusal, authDir, connectOrThrow, recordMesh } = await import("@cotal-ai/workspace");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/attach) into the registry
const { Manager } = await import("@cotal-ai/manager");
import type { Command, Connector, LaunchOpts, SpaceAuth } from "@cotal-ai/core";
const TSX = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");

/** The redeem decision under test, described structurally rather than imported as a type. A tree
 *  that predates the fix exports neither the function nor its types; naming them here is what lets
 *  this same file run as the PRE-FIX CONTROL instead of failing to load. */
type Target = {
  space: string;
  server: string;
  root?: string;
  spaceAuth?: SpaceAuth;
  mode?: "auth" | "open" | "user";
  auth: { bearer?: unknown };
};
type Material = { kind: "bare" } | { kind: "mint"; auth: SpaceAuth } | { kind: "fatal"; message: string };
/** What the RESOLVER returns, which is NOT `Target`: here `auth` is the space's TRUST material,
 *  while `Target.auth` is the CONNECTION's credentials and the trust material rides in `spaceAuth`.
 *  Keeping them as two types is what makes the adapter below a visible, checkable step. */
type Resolved = {
  space: string;
  server: string;
  root?: string;
  mode?: "auth" | "open" | "user";
  auth?: SpaceAuth;
};
type Link = { mode: "bare"; tls: boolean } | { mode: "session-caller"; tls: boolean; creds: string };

const agentsMod = (await import("../../implementations/cli/src/commands/agents.js")) as Record<string, unknown>;
const decide = agentsMod.attachSessionMaterial as ((t: Target) => Material) | undefined;
const connectOptsFor = agentsMod.redeemConnectOpts as ((l: Link) => Record<string, unknown>) | undefined;
const controlMod = (await import("../../implementations/cli/src/lib/control.js")) as Record<string, unknown>;
const scatterProbe = controlMod.scatterProbeMaterial as
  | ((auth: { creds?: string; bearer?: string }, spaceAuth?: SpaceAuth) => { kind: string })
  | undefined;
/** The RESOLVER, driven for real rather than hand-built. `localTarget` derives `mode` from whether
 *  a seed loaded (`mode: auth ? "auth" : "open"`), and that derived mode is the SOLE input to the
 *  redeem decision. So the resolver decides the redeem contract one step before the decision does,
 *  and a cell that hand-builds a `Target` cannot see it. Found in review, third round. */
const targetMod = (await import("../../packages/workspace/src/mesh-target.js")) as Record<string, unknown>;
const resolveTarget = targetMod.resolveMeshTarget as
  | ((cwd: string, flags?: { server?: string }) => Resolved)
  | undefined;
const authPathsMod = (await import("../../packages/workspace/src/auth-paths.js")) as Record<string, unknown>;
const saveSpaceAuth = authPathsMod.saveSpaceAuth as (dir: string, auth: SpaceAuth) => void;
const authDirOf = authPathsMod.authDir as (root: string) => string;

let pass = 0;
let fail = 0;
let exitCode = 1;
const kids: ChildProcess[] = [];
const releases: Array<() => void> = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};
/** A rig precondition. Failing one means the cells after it would measure nothing, so it throws
 *  rather than counting a red that looks like a product verdict. */
const must = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL (rig): ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The real binary runs with EVERY inherited `COTAL_*` stripped, so this process's sandbox cannot
 *  leak a space, a server or a seed into the subprocess under test. */
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];

const OPEN_PORT = await freePort();
const SEALED_PORT = await freePort();
const OPEN_SERVER = `nats://127.0.0.1:${OPEN_PORT}`;
const SEALED_SERVER = `nats://127.0.0.1:${SEALED_PORT}`;
const SPACE = "openattach";
const SEALED_SPACE = "sealedattach";
const SEAT = "seat1";
const BIN = join(import.meta.dirname, "..", "cotal.ts");
const rootOpen = mkdtempSync(join(tmpdir(), "cotal-openattach-root-"));
const rootOpenWithSeed = mkdtempSync(join(tmpdir(), "cotal-openseeded-root-"));
const rootSealedNoSeed = mkdtempSync(join(tmpdir(), "cotal-sealednoseed-root-"));
// Fixtures for the RESOLVER cells (1b). These are roots the registry has never heard of, which is
// what an operator has when a mesh was never recorded here: a genuine `.cotal/` and no
// entry anywhere. NOT what `cotal up --open` leaves behind - that path calls `recordMesh`
// (up.ts:2391), so a mesh brought up in this directory IS registered. The unregistered state is
// reached by a pruned or hand-removed registry, or by a checkout that never ran `up` at all.
// The pair differs ONLY by whether trust material is on disk, because that single bit is
// what `localTarget` turns into the mode, and the mode is what decides the redeem.
const rootUnregisteredNoSeed = mkdtempSync(join(tmpdir(), "cotal-unregistered-noseed-"));
const rootUnregisteredWithSeed = mkdtempSync(join(tmpdir(), "cotal-unregistered-seeded-"));
mkdirSync(join(rootUnregisteredNoSeed, ".cotal", "auth"), { recursive: true });
mkdirSync(join(rootUnregisteredWithSeed, ".cotal", "auth"), { recursive: true });
// An EMPTY registry, so a mesh recorded on the developer's own box cannot answer in place of the
// fixture. Without this the resolver returns `source: "current"` off the real machine and the cells
// silently grade someone else's mesh - which is exactly how the first draft of this probe fooled me.
const emptyRegistryHome = join(mkdtempSync(join(tmpdir(), "cotal-emptyreg-")), ".cotal");
mkdirSync(emptyRegistryHome, { recursive: true });
writeFileSync(join(emptyRegistryHome, "meshes.json"), JSON.stringify({ meshes: [] }));
mkdirSync(join(rootOpen, ".cotal", "agents"), { recursive: true });
writeFileSync(join(rootOpen, ".cotal", "agents", "seat.md"), "---\nname: seat\nrole: worker\n---\nA supervised seat.\n");

const coreDist = join(import.meta.dirname, "..", "..", "packages", "core", "dist", "index.js");
const CHILD = [
  "const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});",
].join("");
let lastOpts: LaunchOpts | undefined;
/** Typed as {@link Connector} at the BINDING, not at the call. `registry.register` takes
 *  `Extension[]`, so an object literal passed inline is excess-property-checked against the base
 *  type and `requires` is rejected — which is a typecheck red, not a product fact. */
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

/** Run the REAL binary's `attach` from `cwd` against `space`, and return everything it said.
 *  Stops as soon as the session banner appears, or when the process ends, or at the deadline. */
async function attachFrom(cwd: string, space: string, ms = 25_000): Promise<string> {
  const p = spawnProc(TSX, [BIN, "attach", "--name", SEAT, "--space", space], {
    cwd,
    env: { ...cleanEnv, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(p);
  let out = "";
  p.stdout.on("data", (b: Buffer) => void (out += b.toString()));
  p.stderr.on("data", (b: Buffer) => void (out += b.toString()));
  const end = Date.now() + ms;
  while (Date.now() < end && p.exitCode === null && !/attached to /.test(out)) await sleep(200);
  if (/attached to /.test(out)) await sleep(300);
  p.kill("SIGKILL");
  await awaitExit(p);
  return out.replace(/\x1b\[[0-9;]*m/g, "");
}

let mgr: InstanceType<typeof Manager> | undefined;
try {
  console.log("attach-open-mode: first-line");

  // ---- 1. the redeem DECISION: one refusing case per accepting branch --------------------------
  // Each pair below differs ONLY by the recorded mode. That is the point: the seed's presence is
  // held constant across a pair, so a cell can only move when the MODE is what decided.
  //
  // A MISSING export is a RED CELL, not a rig abort, and that is what makes this file a usable
  // PRE-FIX CONTROL: on a tree that predates the fix these cells red on the absent decision AND the
  // run continues to the live cells, where the #1205 refusal itself is observed. Aborting here
  // would leave the actual user-visible defect unmeasured by the control.
  ok("the redeem decision is exported for grading", typeof decide === "function", typeof decide);
  const decideOn: (t: Target) => Material =
    decide ?? (() => ({ kind: "fatal", message: "attachSessionMaterial is not exported by this tree" }));
  const seed = await createSpaceAuth(SPACE);
  // Give the seeded unregistered fixture a REAL composed seed on disk, written through the product's
  // own writer, so the resolver loads it the way it would in the field rather than from a stub.
  saveSpaceAuth(authDirOf(rootUnregisteredWithSeed), seed);

  const openNoSeed = decideOn({ space: SPACE, server: OPEN_SERVER, root: rootOpen, mode: "open", auth: {} });
  ok("ACCEPT: an open mesh with no seed redeems bare", openNoSeed.kind === "bare", openNoSeed);
  const sealedNoSeed = decideOn({ space: SEALED_SPACE, server: SEALED_SERVER, root: rootSealedNoSeed, mode: "auth", auth: {} });
  ok(
    "REFUSE (same absent seed, mode `auth`): a sealed mesh still refuses, and names restore-at-checkout",
    sealedNoSeed.kind === "fatal" &&
      sealedNoSeed.message.includes(rootSealedNoSeed) &&
      /Restore the seed at that checkout/.test(sealedNoSeed.message) &&
      /This mesh is not open/.test(sealedNoSeed.message) &&
      !/re-register the mesh/.test(sealedNoSeed.message),
    sealedNoSeed.kind === "fatal" ? sealedNoSeed.message : sealedNoSeed,
  );

  // The mode WINS over what the disk happens to hold, in both directions. A root that once ran auth
  // mode still has material under `.cotal/auth`; an open mesh must not start minting because of it.
  const openWithSeed = decideOn({ space: SPACE, server: OPEN_SERVER, root: rootOpenWithSeed, mode: "open", spaceAuth: seed, auth: {} });
  ok("ACCEPT: an open mesh redeems bare even when a seed is present on disk", openWithSeed.kind === "bare", openWithSeed);
  const userWithSeed = decideOn({ space: SPACE, server: SEALED_SERVER, root: rootOpenWithSeed, mode: "user", spaceAuth: seed, auth: { bearer: "x" } });
  ok(
    "REFUSE (same present seed, mode `user`): a user mesh refuses rather than minting on the wrong identity plane",
    userWithSeed.kind === "fatal" && /USER-AUTH mesh/.test(userWithSeed.message),
    userWithSeed.kind === "fatal" ? userWithSeed.message : userWithSeed,
  );

  const sealedWithSeed = decideOn({ space: SPACE, server: SEALED_SERVER, root: rootOpenWithSeed, mode: "auth", spaceAuth: seed, auth: {} });
  ok(
    "ACCEPT: a sealed mesh with its seed still mints from THAT seed",
    sealedWithSeed.kind === "mint" && sealedWithSeed.auth === seed,
    sealedWithSeed,
  );
  // The hand-built `mode: undefined` case: still worth a cell, because the DECISION must take the
  // conservative arm for a mode it does not recognise. But it is NOT the shape the real resolver
  // produces, so it is labelled for what it is and paired below with the resolver's actual output.
  const unrecordedNoSeed = decideOn({ space: SPACE, server: SEALED_SERVER, root: rootSealedNoSeed, auth: {} });
  ok(
    "REFUSE (mode absent from the value itself): the DECISION takes the sealed arm for a mode it cannot read",
    unrecordedNoSeed.kind === "fatal",
    unrecordedNoSeed,
  );

  // ---- 1b. the RESOLVER decides the redeem contract, so grade IT, not a hand-built value -------
  // Found in review (third round). `localTarget` sets `mode: auth ? "auth" : "open"` — it SYNTHESISES
  // the mode from whether a seed loaded, and that mode is the sole input to the decision above. So an
  // unregistered root reaches the redeem as a genuine `"open"`, never as an absent mode, and the cell
  // above cannot observe that. Pre-fix this same input was a fatal refusal; it is now a bare redeem.
  // Driving the real resolver is the only way a cell can see it, and COTAL_HOME is redirected at an
  // EMPTY registry so a mesh recorded on the developer's box cannot answer instead of the fixture.
  ok("the resolver is exported for grading", typeof resolveTarget === "function", typeof resolveTarget);
  const resolveOn = (cwd: string): Resolved | { failed: string } => {
    if (!resolveTarget) return { failed: "resolveMeshTarget is not exported by this tree" };
    const savedHome = process.env.COTAL_HOME;
    process.env.COTAL_HOME = emptyRegistryHome;
    try {
      return resolveTarget(cwd, { server: OPEN_SERVER });
    } catch (e) {
      return { failed: (e as Error).message };
    } finally {
      if (savedHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = savedHome;
    }
  };

  // `resolveMeshTarget` returns a MeshTarget, and the decision takes a ControlTarget. Those are NOT
  // the same shape: MeshTarget.auth is the space's TRUST material, ControlTarget.auth is the
  // CONNECTION's credentials (`bearer`/`tls`). Feed one to the other raw and the trust chain gets
  // read as a bearer token. So adapt exactly the way `resolveControlTarget` does: take `mode` and
  // `root` from the resolution, carry the trust material across as `spaceAuth`, and leave the
  // connection credentials empty, which is what a credless attach actually holds. Caught by the
  // #1205 mutation, which threw here rather than reddening its cell.
  const asControlTarget = (m: Resolved): Target => ({
    space: m.space,
    server: m.server,
    ...(m.root !== undefined ? { root: m.root } : {}),
    ...(m.mode !== undefined ? { mode: m.mode } : {}),
    ...(m.auth ? { spaceAuth: m.auth } : {}),
    auth: {},
  });

  const resolvedUnrecorded = resolveOn(rootUnregisteredNoSeed);
  const unrecMode = "failed" in resolvedUnrecorded ? `resolve failed: ${resolvedUnrecorded.failed}` : resolvedUnrecorded.mode;
  ok(
    'ACCEPT: an UNREGISTERED root with no seed resolves to mode "open", not to an absent mode',
    unrecMode === "open",
    unrecMode,
  );
  const resolvedRedeem = "failed" in resolvedUnrecorded ? { kind: "fatal", message: resolvedUnrecorded.failed } as Material : decideOn(asControlTarget(resolvedUnrecorded));
  ok(
    "ACCEPT: and it therefore redeems BARE through the real resolver, which is #1205's own scenario",
    resolvedRedeem.kind === "bare",
    resolvedRedeem,
  );
  // The refusing partner. It is a SECOND unregistered root, not the same one: both are separate
  // `mkdtempSync` calls (lines 165-166), and they are built to differ in exactly one respect, that
  // this one carries trust material on disk. Saying "the same root" would have been simpler and
  // false, and the point of the pair is that ONE bit differs, which a wrong label destroys.
  // The resolver then synthesises "auth", and the redeem MINTS from that material rather than
  // going bare. Twice-measured, and the wobble is worth recording: with the MeshTarget fed in raw
  // this cell read as a by-name refusal, which looked like a real finding about the product. It was
  // an artifact of my adapter dropping the trust material on the floor. The shapes differ, so the
  // adapter above is load-bearing and a cell can be wrong in either direction without it.
  const resolvedSeeded = resolveOn(rootUnregisteredWithSeed);
  const seededMode = "failed" in resolvedSeeded ? `resolve failed: ${resolvedSeeded.failed}` : resolvedSeeded.mode;
  ok(
    'REFUSE the bare arm (a SECOND unregistered root, differing only in that trust material is present): the resolver synthesises "auth" instead of "open"',
    seededMode === "auth",
    seededMode,
  );
  const seededRedeem = "failed" in resolvedSeeded ? { kind: "fatal", message: resolvedSeeded.failed } as Material : decideOn(asControlTarget(resolvedSeeded));
  ok(
    "REFUSE the bare arm (that same second root): the redeem MINTS from THAT material and never goes bare",
    seededRedeem.kind === "mint" && seededRedeem.auth !== undefined,
    seededRedeem.kind,
  );

  // ---- 2. the CONNECT OPTIONS: nothing invented, nothing dropped -------------------------------
  ok("the redeem connect-options seam is exported for grading", typeof connectOptsFor === "function", typeof connectOptsFor);
  const rawOptsFor: (l: Link) => Record<string, unknown> = connectOptsFor ?? (() => ({ absent: true }));
  // A THROW is this cell's own red, not the suite's. A seam that invents a credential for a bare
  // link fails INSIDE `standaloneConnectOpts` (it parses the cred to derive the reply inbox), so
  // without this the failure escapes as a stack trace and the cell that should name it never runs.
  // The thrown message is carried into the cell's detail, so the red still says what happened.
  const optsFor = (l: Link): Record<string, unknown> => {
    try {
      return rawOptsFor(l);
    } catch (e) {
      return { threw: e instanceof Error ? e.message : String(e) };
    }
  };
  const bareOpts = optsFor({ mode: "bare", tls: false });
  ok(
    "a bare redeem carries NO credential: the fix does not invent or synthesise a seed for an open mesh",
    bareOpts.threw === undefined &&
      bareOpts.authenticator === undefined &&
      bareOpts.user === undefined &&
      bareOpts.token === undefined,
    bareOpts.threw ?? Object.keys(bareOpts),
  );
  // A REAL credential, not a sentinel string: `standaloneConnectOpts` derives the reply inbox from
  // the cred's own identity, so a fake one would fail on parsing rather than on the arm under test.
  const realCreds = await mintCreds(seed, newIdentity(), "probe");
  const callerOpts = optsFor({ mode: "session-caller", tls: false, creds: realCreds });
  ok(
    "a session-caller redeem carries the credential it was handed, not a bare connection",
    callerOpts.threw === undefined && callerOpts.authenticator !== undefined,
    callerOpts.threw ?? Object.keys(callerOpts),
  );
  const bareTls = optsFor({ mode: "bare", tls: true });
  const callerTls = optsFor({ mode: "session-caller", tls: true, creds: realCreds });
  ok(
    "the transport requirement survives BOTH arms, so an open redeem cannot quietly downgrade a TLS mesh",
    bareTls.tls !== undefined && callerTls.tls !== undefined && bareOpts.tls === undefined,
    { bareTls: bareTls.tls, callerTls: callerTls.tls, plain: bareOpts.tls },
  );

  // ---- 2b. THE SIXTH SEED REACH: the scatter's liveness probe ---------------------------------
  // `attach` resolves seat locality first (pinForTarget → locateSeat → scatterManager), and that
  // path re-mints a pinned instrument from the space seed. It is the one site left that answers
  // "is this an open mesh?" from the ABSENCE of a credential, which is the inference #1205 was
  // about. It is graded rather than merely documented, and its SAFETY is graded too: the sealed
  // arm must degrade to "keep what you arrived with" rather than refuse, because a refusal here
  // would reintroduce #1205 one call earlier than the redeem.
  ok("the scatter probe decision is exported for grading", typeof scatterProbe === "function", typeof scatterProbe);
  const probeOn: (a: { creds?: string; bearer?: string }, s?: SpaceAuth) => { kind: string } =
    scatterProbe ?? (() => ({ kind: "absent" }));
  ok(
    "ACCEPT: an open mesh's scatter probes bare, minting nothing",
    probeOn({}).kind === "bare",
    probeOn({}),
  );
  ok(
    "REFUSE (same missing creds, a bearer present): a user mesh neither probes bare nor mints",
    probeOn({ bearer: "x" }).kind === "as-is",
    probeOn({ bearer: "x" }),
  );
  ok(
    "ACCEPT: a sealed mesh with its seed re-mints the pinned probe from THAT seed",
    probeOn({ creds: realCreds }, seed).kind === "mint",
    probeOn({ creds: realCreds }, seed),
  );
  ok(
    "REFUSE (same creds, seed absent): a sealed mesh keeps what it arrived with and DEGRADES, never refusing",
    probeOn({ creds: realCreds }).kind === "as-is",
    { got: probeOn({ creds: realCreds }), why: "a refusal at this site would reintroduce #1205 one call before the redeem" },
  );

  // ---- 3. LIVE SEALED: a running authed broker, a registered root with no seed -------------------
  // The broker is REAL and proven to be serving, so the refusal below cannot be "no mesh running"
  // wearing the sealed sentence. The root holds no seed, which is the whole premise.
  const sealedChain = await createSpaceAuth(SEALED_SPACE);
  const sealedStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}sealedattach-js-`));
  const sealedConf = join(rootSealedNoSeed, "server.conf");
  writeFileSync(
    sealedConf,
    serverConfig(sealedChain, [sealedChain], { transport: { kind: "plaintext" }, port: SEALED_PORT, storeDir: sealedStore, host: "127.0.0.1" }),
  );
  const sealedBroker = spawnProc("nats-server", ["-c", sealedConf], { stdio: "ignore" });
  kids.push(sealedBroker);
  releases.push(teardownOnSignal(sealedBroker, sealedStore));
  // An AUTHED broker answers a credless probe `auth-required`, and that answer IS proof it is up.
  let sealedServing = false;
  for (let i = 0; i < 80; i++) {
    const p = await probeConnect(SEALED_SERVER, { timeoutMs: 400 });
    if (p.ok || p.reason === "auth-required") { sealedServing = true; break; }
    await sleep(100);
  }
  must("the sealed broker is serving", sealedServing, { server: SEALED_SERVER });
  // The premise of this half, read off the FILESYSTEM: the registered root holds no seed either.
  // Without it the refusal below could be a seed being rejected rather than a seed being absent.
  must("the sealed mesh's registered root holds no seed for the space", !existsSeed(authDir(rootSealedNoSeed), SEALED_SPACE), authDir(rootSealedNoSeed));
  // `ProbeResult` is a discriminated union: `reason` exists only on the failing arm, so the
  // credless probe is narrowed rather than cast. Casting here would hide the day this cell starts
  // reading a field the success arm never carries.
  const credlessProbe = await probeConnect(SEALED_SERVER, { timeoutMs: 3000 });
  ok(
    "the sealed broker really is sealed: it ACCEPTS its own chain's credential and REFUSES a credless connect",
    (await probeConnect(SEALED_SERVER, { creds: await mintCreds(sealedChain, newIdentity(), "probe"), timeoutMs: 3000 })).ok &&
      !credlessProbe.ok &&
      credlessProbe.reason === "auth-required",
    credlessProbe,
  );
  recordMesh({ space: SEALED_SPACE, server: SEALED_SERVER, root: rootSealedNoSeed, mode: "auth", ts: new Date().toISOString() });

  let connectErr = "";
  try {
    await connectOrThrow({ space: SEALED_SPACE }, "probe");
  } catch (e) {
    connectErr = e instanceof ConnectRefusal ? e.rendered : e instanceof Error ? e.message : String(e);
  }
  ok(
    "connecting to a sealed mesh whose seed is gone refuses by name, and says the mesh is NOT open",
    /static-auth mesh but the seed/.test(connectErr) && /This mesh is not open/.test(connectErr) && connectErr.includes(rootSealedNoSeed),
    connectErr,
  );

  const sealedAttach = await attachFrom(rootSealedNoSeed, SEALED_SPACE, 20_000);
  ok(
    "THE CONTROL CELL: `cotal attach` on a live SEALED mesh with no seed still REFUSES, and never takes the open path",
    !/attached to /.test(sealedAttach) && /This mesh is not open/.test(sealedAttach) && sealedAttach.includes(rootSealedNoSeed),
    sealedAttach.slice(-900),
  );

  // ---- 4. LIVE OPEN: the capability #1205 reported missing ---------------------------------------
  const brokerStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}openattach-js-`));
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(OPEN_PORT), "-js", "-sd", brokerStore], { stdio: "ignore" });
  kids.push(broker);
  releases.push(teardownOnSignal(broker, brokerStore));
  let serving = false;
  for (let i = 0; i < 50; i++) {
    if ((await probeConnect(OPEN_SERVER, { timeoutMs: 400 })).ok) { serving = true; break; }
    await sleep(100);
  }
  must("the open broker is serving", serving, { server: OPEN_SERVER });
  // The premise of the whole issue, asserted rather than assumed: this root holds NO seed for the
  // space, and the mesh is registered `open`.
  must("the open mesh's root holds no seed for the space", !existsSeed(authDir(rootOpen), SPACE), authDir(rootOpen));
  recordMesh({ space: SPACE, server: OPEN_SERVER, root: rootOpen, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: OPEN_SERVER, runtime: "pty", workspaceRoot: rootOpen });
  await mgr.start();
  const prevCwd = process.cwd();
  process.chdir(rootOpen);
  try {
    await cmd("spawn").run(
      parseCommandArgs(cmd("spawn"), ["seat", "--detach", "--agent", "e2e", "--space", SPACE, "--name", SEAT]),
    );
  } finally {
    process.chdir(prevCwd);
  }
  must("a seat is running under the open mesh", lastOpts?.name === SEAT, lastOpts?.name);

  const fromOpen = await attachFrom(rootOpen, SPACE);
  ok(
    "open-without-seed attaches",
    /attached to seat1/.test(fromOpen) && !/needs this space's local seed/.test(fromOpen) && !/re-register the mesh/.test(fromOpen),
    fromOpen.slice(-900),
  );

  console.log(`\nattach open-mode: ${pass} passed, ${fail} failed`);
  if (!fail) exitCode = 0;
} catch (e) {
  // A THROW is not a silent exit. Without this the suite ends on `finally` alone and prints a
  // cell count that stops mid-table, which reads as a hang rather than as the failure it is.
  console.log(`\n  ✗ THREW: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.log(`\nattach open-mode: ${pass} passed, ${fail + 1} failed`);
} finally {
  // WITH ITS AGENTS. A spare `stop()` on a live-PTY manager detaches the supervised child and
  // leaves it running past the suite (#964), which `smoke:manager-stop-spare-guard` reds on.
  await Promise.race([mgr?.stop({ withAgents: true }).catch(() => {}) ?? Promise.resolve(), sleep(10_000)]);
  console.log("attach-open-mode: manager-stop-returned");
  await Promise.all(kids.map((k) => { k.kill("SIGKILL"); return awaitExit(k); }));
  for (const release of releases) release();
  console.log("attach-open-mode: finally-complete");
  process.exit(exitCode);
}

/** Whether `dir` holds a space account for `space` — the on-disk seed the redeem path used to
 *  demand. Written locally so the premise is read off the FILESYSTEM rather than from the same
 *  resolver the suite is grading. */
function existsSeed(dir: string, space: string): boolean {
  if (!existsSync(dir)) return false;
  const hex = Buffer.from(space, "utf8").toString("hex");
  return readdirSync(dir).some((f) => f.includes(hex) && f.endsWith(".json") && !f.startsWith("manager-instance."));
}
