/**
 * One delivery process serving several spaces: the real `cotal deliver --spaces <manifest>` binary on
 * a live `nats-server` that holds one account per space, every credential read from one workstation
 * root the way Cotal Cloud runs the daemon (cwd at the root, no `--creds`).
 *
 * What it proves, each from the broker rather than from the host's own report:
 *  - the `--spaces` refusals, and a startup that serves the spaces it can while it names and retries
 *    the one it cannot;
 *  - each space's control rail answers through its own lane, each lease row is held by that space's
 *    own delivery identity, and a CONNZ sweep of each account lists only that space's identities;
 *  - an outside party re-signing one lane's credential in the root store is adopted by that lane
 *    before the old credential expires, while another lane's connections stay untouched;
 *  - removing a space closes its lane and releases its lease under traffic to the others, an invalid
 *    manifest keeps the live lanes, and re-adding the space opens its lane again;
 *  - a lane whose lease another daemon takes stops alone, is retried, and reopens once the lease is
 *    free, with the other lanes serving throughout;
 *  - SIGTERM releases every lane's lease before the process exits.
 *
 * `--measure` instead reports RSS and CPU per space at 1, 4 and 16 lanes in one process against 16
 * single-space processes, under identical Plane-3 traffic: per space, three members joined durably
 * to one channel and one of them posting at a fixed rate. `--measure-shape host16|single16`
 * selects one fresh-state shape. `--sublist-cache on|off` selects the native broker cache.
 * `--verify-delivery` adds recipient-ID coverage with extra tracking overhead; compare its
 * timings only with other verification runs. Aggregate-only runs still check accepted posts,
 * copy counts and endpoint errors. Receiver coverage is not a broker queue-empty proof.
 * `--cpu-profile-dir /new/private/path` adds native CPU diagnostics for host16 only, not
 * ordinary performance: the actual delivery CLI child from startup through exit, and the
 * broker for up to60 seconds requested as posting begins. No forced GC or runtime tuning.
 *
 * Runs the BUILT dist (`pnpm build` first). Needs `nats-server` on PATH.
 * Run: pnpm smoke:delivery-multi-space
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { connect, credsAuthenticator, NoRespondersError, RequestError, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, CONTROL_DELIVERY, DEV_OWNER, MEMBERSHIP_INBOX_PREFIX, composeSpaceAuth, controlServiceSubject, createBrokerAuth,
  createSpaceAccountAuth, deliveryLeaseHolderFor, isReachable, mintConnectionEvictorCreds, mintCreds, mintLifecycleUid,
  mintMembershipObserverCreds, newIdentity, provisionAgent, serverConfig, setupSpaceStreams, type CotalMessage, type SpaceAuth,
} from "@cotal-ai/core";
import {
  DELIVERY_CREDS_KIND, DELIVERY_PIDFILE, authDir, canonicalLocalProcessPath, connectionEvictorCredsKey, deliveryCredsKey,
  membershipObserverCredsKey, membershipRwCredsKey, remintDaemonCreds, saveSpaceAuth, workspaceSecretStore,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, procMem, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";
import { deliveryCoverage } from "./_delivery-coverage.js";

const { values } = parseArgs({ options: {
  measure: { type: "boolean" },
  "measure-shape": { type: "string", default: "all" },
  "sublist-cache": { type: "string", default: "on" },
  "verify-delivery": { type: "boolean" },
  "cpu-profile-dir": { type: "string" },
} });
const MEASURE = values.measure === true;
const SHAPE = values["measure-shape"];
const SUBLIST_CACHE = values["sublist-cache"];
const VERIFY_DELIVERY = values["verify-delivery"] === true;
const CPU_PROFILE_DIR = values["cpu-profile-dir"];
if (!["all", "host16", "single16"].includes(SHAPE)) throw new Error("--measure-shape must be all, host16 or single16");
if (SUBLIST_CACHE !== "on" && SUBLIST_CACHE !== "off") throw new Error("--sublist-cache must be on or off");
if (!MEASURE && (SHAPE !== "all" || VERIFY_DELIVERY)) throw new Error("--measure-shape and --verify-delivery require --measure");
const SECONDS = Number(process.env.COTAL_MSD_SECONDS ?? "30");
const RATE = Number(process.env.COTAL_MSD_RATE ?? "2");
if (MEASURE && (![SECONDS, RATE].every((n) => Number.isFinite(n) && n > 0)))
  throw new Error("COTAL_MSD_SECONDS and COTAL_MSD_RATE must be positive finite numbers");
const scheduledPosts = Math.ceil(RATE * SECONDS);
if (MEASURE && (!Number.isSafeInteger(scheduledPosts) || scheduledPosts < 1))
  throw new Error("scheduled post count must be a positive safe integer");
if (CPU_PROFILE_DIR !== undefined) {
  if (!MEASURE || SHAPE !== "host16" || !isAbsolute(CPU_PROFILE_DIR))
    throw new Error("--cpu-profile-dir requires --measure --measure-shape host16 and an absolute new directory");
  mkdirSync(CPU_PROFILE_DIR, { mode: 0o700 }); // existing paths refuse; profiles never overwrite a prior run
}
const BROKER_PROFILE_SECONDS = Math.min(60, Math.max(1, Math.ceil(SECONDS)));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>, ms: number, step = 150): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await test()) return true; await wait(step); }
  return test();
}
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail)); }
};

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cotalJs = join(repoRoot, "bin", "dist", "cotal.js");
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const root = join(dir, "root");
mkdirSync(join(root, ".cotal", "auth"), { recursive: true, mode: 0o700 });
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", NO_COLOR: "1", COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "COTAL_HOME", "TMPDIR"]) {
  env[key] = join(dir, key.toLowerCase());
  mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
}

const port = await pickFreePort();
const profilePort = CPU_PROFILE_DIR ? await pickFreePort() : undefined;
const servers = `nats://127.0.0.1:${port}`;
const tag = randomUUID().slice(0, 6);
const brokerAuth = await createBrokerAuth(`msd-${tag}`);
/** Spaces the broker knows. The suite provisions the first `provisioned` of them into the root. */
const spaceCount = MEASURE ? 16 : 4;
const names = Array.from({ length: spaceCount }, (_, i) => `msd-${tag}-${String.fromCharCode(97 + i)}`);
const accounts = await Promise.all(names.map((space) => createSpaceAccountAuth(brokerAuth, space)));
const auths: SpaceAuth[] = accounts.map((account) => composeSpaceAuth(brokerAuth, account));
const config = join(dir, "server.conf");
writeFileSync(config, serverConfig(brokerAuth, accounts, { transport: { kind: "plaintext" }, port, host: "127.0.0.1", storeDir: join(dir, "js") })
  + `\ndisable_sublist_cache: ${SUBLIST_CACHE === "off"}\n`
  + (profilePort ? `prof_port: ${profilePort}\n` : ""), { mode: 0o600 });
const nats = spawn("nats-server", ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
let brokerLog = "";
nats.stderr!.on("data", (chunk: Buffer) => { brokerLog += chunk.toString(); });
const releaseBroker = teardownOnSignal(nats, dir);

const store = workspaceSecretStore(root);
const composition = { injected: false as const, root };
const deliveryIds = names.map(() => newIdentity());
const observers: string[] = [];
const children: ChildProcess[] = [];
const callers: NatsConnection[] = [];
const endpoints: CotalEndpoint[] = [];

/** Provision space `i` into the root store as `cotal up` leaves it: the space signer, the scoped
 *  delivery and membership credentials, and the account's `$SYS` observer and evictor. */
async function provision(i: number, deliveryExpiresInSeconds = 3600): Promise<void> {
  const space = names[i]!, auth = auths[i]!;
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  saveSpaceAuth(authDir(root), auth);
  observers[i] = await mintMembershipObserverCreds(auth, newIdentity());
  await store.put(deliveryCredsKey(space, composition), await mintCreds(auth, deliveryIds[i]!, "delivery", { expiresInSeconds: deliveryExpiresInSeconds }));
  await store.put(membershipRwCredsKey(space, composition), await mintCreds(auth, newIdentity(), "membership-rw", { expiresInSeconds: 3600 }));
  await store.put(membershipObserverCredsKey(space, composition), observers[i]!);
  await store.put(connectionEvictorCredsKey(space, composition), await mintConnectionEvictorCreds(auth, newIdentity()));
}

/** Write the manifest the way a provisioning backend does: a new file renamed into place. */
const manifest = join(dir, "manifests", "spaces.json");
mkdirSync(join(dir, "manifests"), { recursive: true });
function writeManifest(body: string): void {
  const tmp = `${manifest}.${randomUUID().slice(0, 6)}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, manifest);
}
const manifestOf = (spaces: string[]) => JSON.stringify({ version: 1, spaces });

/** A running `cotal` child with its combined output. */
type Run = { label: string; child: ChildProcess; out: string[]; text(): string; exited: Promise<number | null> };
const runs: Run[] = [];
function start(args: string[]): Run {
  const profileArgs = CPU_PROFILE_DIR ? ["--cpu-prof", `--cpu-prof-dir=${CPU_PROFILE_DIR}`, "--cpu-prof-name=delivery.cpuprofile"] : [];
  const child = spawn(process.execPath, [...profileArgs, cotalJs, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const out: string[] = [];
  child.stdout!.on("data", (d: Buffer) => out.push(d.toString()));
  child.stderr!.on("data", (d: Buffer) => out.push(d.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const run = { label: args.slice(0, 2).join(" "), child, out, text: () => out.join(""), exited };
  runs.push(run);
  return run;
}

/** Ask a space's `ctl.delivery` rail for one lifecycle's memberships, as an agent of that space
 *  does. True when a lane answered, false when nothing serves the rail. */
async function prober(i: number): Promise<() => Promise<boolean>> {
  const space = names[i]!, actor = newIdentity(), uid = mintLifecycleUid();
  const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auths[i]!, actor, "agent", { lifecycleUid: uid }))), inboxPrefix: `_INBOX_${actor.id}` });
  callers.push(nc);
  return async () => {
    const subject = controlServiceSubject(space, CONTROL_DELIVERY, DEV_OWNER, actor.id);
    try {
      await nc.request(subject, JSON.stringify({ op: "listMemberships", args: { lifecycleUid: uid }, from: { id: `${DEV_OWNER}.${actor.id}`, name: "msd-probe", kind: "agent" } }), { timeout: 3000, noMux: true, reply: `${subject}.reply.${randomUUID()}` });
      return true;
    } catch (error) {
      if (error instanceof NoRespondersError || (error instanceof RequestError && error.isNoResponders())) return false;
      throw error;
    }
  };
}

/** A read-only endpoint in space `i`, for its lease row. */
async function inspector(i: number): Promise<CotalEndpoint> {
  const id = newIdentity();
  const ep = new CotalEndpoint({ space: names[i]!, servers, creds: await mintCreds(auths[i]!, id, "delivery"), card: { id: id.id, name: "msd-inspector", kind: "endpoint" }, channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
  ep.on("error", () => {});
  await ep.start();
  endpoints.push(ep);
  return ep;
}

/** Every client connection the broker holds in space `i`'s account, read with that space's own
 *  `$SYS` observer: connection id and the user nkey it authenticated as. The sweep's own connection
 *  is left out, so two sweeps of an unchanged account read the same. */
async function connz(i: number): Promise<{ cid: number; user?: string; exp?: number }[]> {
  const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(observers[i]!)), inboxPrefix: MEMBERSHIP_INBOX_PREFIX });
  try {
    const reply = await nc.request(`$SYS.REQ.ACCOUNT.${accounts[i]!.account.pub}.CONNZ`, JSON.stringify({ auth: true, limit: 1024 }), { timeout: 5000 });
    const body = reply.json<{ data?: { connections?: { cid: number; authorized_user?: string; jwt?: string }[] } }>();
    const self = nc.info?.client_id;
    return (body.data?.connections ?? []).filter((c) => c.cid !== self).map((c) => ({
      cid: c.cid,
      ...(c.authorized_user !== undefined ? { user: c.authorized_user } : {}),
      ...(c.jwt !== undefined ? { exp: jwtExpiry(c.jwt) } : {}),
    }));
  } finally {
    await nc.close();
  }
}

/** The `exp` claim of a user JWT the broker reports for a connection, in epoch seconds. */
function jwtExpiry(jwt: string): number | undefined {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
  return payload.exp;
}

function cotalSync(args: string[]): { status: number | null; text: string } {
  const r = spawnSync(process.execPath, [cotalJs, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function suite(): Promise<void> {
  const [A, B, C, D] = [0, 1, 2, 3].map((i) => names[i]!) as [string, string, string, string];
  check("the broker answers", await until(() => isReachable(servers), 15_000));
  await provision(0);
  await provision(1);
  await provision(3); // C (index 2) stays unprovisioned: an account on the broker with nothing in the root

  // ---- refusals, before anything is read or dialed --------------------------------------------
  writeManifest(manifestOf([A, B]));
  const refused = (args: string[], needle: string, label: string) => {
    const r = cotalSync(["deliver", ...args]);
    check(label, r.status !== 0 && r.text.includes(needle), r);
  };
  refused(["--spaces", manifest], "--spaces requires --server", "--spaces without --server refuses");
  refused(["--spaces", manifest, "--server", servers, "--space", A], "--space and --spaces are alternatives", "--space with --spaces refuses");
  refused(["--spaces", manifest, "--server", servers, "--creds", join(root, "x.creds")], "--creds belongs to a single-space daemon", "--creds with --spaces refuses");
  refused(["--spaces", manifest, "--server", servers, "--dev-mint"], "--dev-mint belongs to a single-space daemon", "--dev-mint with --spaces refuses");
  refused(["--spaces", manifest, "--server", servers, "--shards", "2"], "--shards belongs to a single-space daemon", "--shards with --spaces refuses");
  refused(["pending", "scout", "--spaces", manifest, "--server", servers], "takes no \"pending\"", "deliver pending with --spaces refuses");
  const warned = cotalSync(["deliver", "--spaces", manifest]);
  check("the deprecation warning keeps cotal deliver for --spaces instead of naming the preset", warned.text.includes("`cotal service start delivery` has no --spaces yet, so keep `cotal deliver` for this run until it does."), warned.text);

  const inspectA = await inspector(0), inspectB = await inspector(1), inspectD = await inspector(3);
  const lease = (ep: CotalEndpoint) => ep.readDeliveryLease(0);

  // ---- startup serves the spaces it can and retries the rest -------------------------------------
  writeManifest(manifestOf([A, C]));
  {
    const run = start(["deliver", "--spaces", manifest, "--server", servers]);
    check("a manifest naming an unserviceable space starts the host serving the others and names the one it retries",
      await until(() => run.text().includes("✓ delivery host up") || run.child.exitCode !== null, 120_000) && run.text().includes(`✓ delivery host up (1 space(s): ${A}; retrying ${C})`), run.text().slice(-800));
    check("the unserviceable space is reported by name with its reason and retried",
      await until(() => run.text().split(`delivery host: space "${C}" could not be served (`).length > 2, 30_000), run.text().slice(-800));
    check("the space that opened serves while the other is retried", (await lease(inspectA))?.ready === true);
    await killAndAwaitExit(run.child, "SIGTERM");
    check("SIGTERM released the open lane's lease", (await lease(inspectA)) === undefined);
  }

  // ---- three lanes in one process ---------------------------------------------------------------
  // A's credential is short-lived so its renewal falls inside this run; B and D hold an hour.
  const shortSeconds = 60;
  await store.put(deliveryCredsKey(A, composition), await mintCreds(auths[0]!, deliveryIds[0]!, "delivery", { expiresInSeconds: shortSeconds }));
  const oldExpiry = Date.now() + shortSeconds * 1000;
  writeManifest(manifestOf([A, B, D]));
  const host = start(["deliver", "--spaces", manifest, "--server", servers]);
  check("the host comes up serving all three spaces", await until(() => host.text().includes(`✓ delivery host up (3 space(s): ${A}, ${B}, ${D})`) || host.child.exitCode !== null, 120_000), host.text().slice(-800));
  check("each lane prints the single-space daemon's lines under its own space prefix",
    [A, B, D].every((s) => host.text().includes(`[${s}] ✓ delivery lane up (space ${s})`) && host.text().includes(`[${s}] • delivery: $SYS sweeps bound to`)), host.text().slice(0, 1200));
  const [askA, askB, askD] = await Promise.all([prober(0), prober(1), prober(3)]);
  check("each space's control rail answers through its own lane", await askA() && await askB() && await askD());
  const [la, lb, ld] = await Promise.all([lease(inspectA), lease(inspectB), lease(inspectD)]);
  check("each space's lease row is ready and held by that space's own delivery identity",
    la?.ready === true && lb?.ready === true && ld?.ready === true
    && la.holder === deliveryLeaseHolderFor(await store.get(deliveryCredsKey(A, composition)) as string)
    && lb.holder === deliveryLeaseHolderFor(await store.get(deliveryCredsKey(B, composition)) as string)
    && ld.holder === deliveryLeaseHolderFor(await store.get(deliveryCredsKey(D, composition)) as string)
    && new Set([la.holder, lb.holder, ld.holder]).size === 3, { la, lb, ld });
  {
    const delivery = [0, 1, 3].map((i) => deliveryIds[i]!.id);
    const sweeps = await Promise.all([0, 1, 3].map((i) => connz(i)));
    const own = sweeps.map((conns, k) => conns.filter((c) => c.user === delivery[k]).length);
    const foreign = sweeps.map((conns, k) => conns.filter((c) => c.user !== undefined && delivery.some((id, j) => j !== k && id === c.user)).length);
    check("each account's CONNZ holds its own lane's delivery connections (endpoint and timer writer)", own.every((n) => n >= 2), own);
    check("no account's CONNZ holds another lane's delivery identity", foreign.every((n) => n === 0), foreign);
  }
  check("no lane writes a delivery pidfile", [A, B, D].every((space) => !existsSync(canonicalLocalProcessPath(DELIVERY_PIDFILE, { root, space }))));

  // ---- an outside party re-signs one lane's credential ------------------------------------------
  const reminted = await remintDaemonCreds(root, A);
  check("the stock remint re-signs A's delivery credential in the root store", reminted.some((r) => r.file === DELIVERY_CREDS_KIND && r.ok), reminted);
  const dBefore = (await connz(3)).map((c) => c.cid).sort((x, y) => x - y);
  const dMark = host.text().length;
  // A's lane adopts the re-signed file at its own renewal point; nobody calls reloadCreds. Watched
  // from the broker in the background while the cells below churn B.
  const aConns = async () => (await connz(0)).filter((c) => c.user === deliveryIds[0]!.id);
  const firstSeen = (await aConns()).map((c) => c.exp);
  let adoptedAt: number | undefined;
  const adoption = until(async () => {
    const conns = await aConns();
    if (conns.length >= 2 && conns.every((c) => c.exp !== undefined && c.exp * 1000 > oldExpiry + 1000)) adoptedAt ??= Date.now();
    return adoptedAt !== undefined;
  }, oldExpiry + 5_000 - Date.now(), 1000);

  // ---- remove, invalid manifest, re-add, under traffic -------------------------------------------
  writeManifest(manifestOf([A, D]));
  check("removing B from the manifest closes its lane", await until(() => host.text().includes(`delivery host: space "${B}" left the manifest - closed its lane; 2 lane(s) up`), 60_000), host.text().slice(-600));
  check("the removed lane released its lease", await until(async () => (await lease(inspectB)) === undefined, 10_000));
  check("B's control rail has no responder once its lane is closed", !(await askB()));
  check("A and D kept answering while B was removed", await askA() && await askD());
  let mark = host.text().length;
  writeManifest("{ not whole");
  check("a manifest that does not parse whole is reported and the live lanes are kept",
    await until(() => host.text().slice(mark).includes("keeping the 2 lane(s) already open"), 30_000) && await askA() && await askD(), host.text().slice(mark, mark + 400));
  writeManifest(manifestOf([A, B, D]));
  check("re-adding B opens its lane again", await until(() => host.text().includes(`delivery host: space "${B}" opened - 3 lane(s) up`), 60_000), host.text().slice(-600));
  check("B's control rail answers again and its lease is ready", await until(askB, 15_000) && (await lease(inspectB))?.ready === true);

  // ---- one lane loses its lease to another daemon -----------------------------------------------
  const foreignId = newIdentity();
  const foreign = new CotalEndpoint({ space: B, servers, creds: await mintCreds(auths[1]!, foreignId, "delivery"), card: { id: foreignId.id, name: "msd-foreign", kind: "endpoint" }, channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
  foreign.on("error", () => {});
  await foreign.start();
  endpoints.push(foreign);
  mark = host.text().length;
  const row = await foreign.readDeliveryLeaseEntry(0);
  const foreignRevision = await foreign.renewDeliveryLease(0, row!.revision);
  check("B's lane stops when another daemon takes its lease", await until(() => host.text().slice(mark).includes(`delivery host: space "${B}" lost its lease, taken by another daemon - that lane stopped serving; 2 lane(s) still up`), 30_000), host.text().slice(mark, mark + 800));
  check("the host retries B while the other daemon holds the lease", await until(() => host.text().slice(mark).includes(`delivery host: space "${B}" could not be served (`), 30_000), host.text().slice(mark, mark + 800));
  check("A and D kept answering while B was down", await askA() && await askD());
  check("the foreign row was left in place, not released by the stopping lane", (await lease(inspectB))?.holder === deliveryLeaseHolderFor(await mintCreds(auths[1]!, foreignId, "delivery")));
  await foreign.releaseDeliveryLease(0, foreignRevision);
  check("B reopens once the lease is free", await until(() => host.text().slice(mark).includes(`delivery host: space "${B}" opened - 3 lane(s) up`), 30_000), host.text().slice(mark, mark + 1200));
  check("B answers again", await until(askB, 15_000));

  // ---- the re-signed credential was adopted before the old one expired ---------------------------
  check("before the remint, A's connections presented the short-lived credential", firstSeen.length >= 2 && firstSeen.every((exp) => exp !== undefined && Math.abs(exp * 1000 - oldExpiry) < 5_000), { firstSeen, oldExpiry });
  check("every A delivery connection presented the re-signed credential before the old one expired", await adoption && adoptedAt !== undefined && adoptedAt < oldExpiry, { adoptedAt, oldExpiry });
  const left = oldExpiry + 8_000 - Date.now();
  if (left > 0) await wait(left);
  const aLines = host.text().split("\n").filter((l) => l.startsWith(`[${A}] `)).join("\n");
  check("A still answers after its original credential's expiry", await askA() && (await lease(inspectA))?.ready === true);
  check("A never reported an expired or unrenewed credential", !/credential expired|still holds the previous cred|lost its/.test(aLines) && !host.text().includes(`space "${A}" lost`), aLines.slice(-800));
  // The broker closes a connection whose user JWT has expired, so A's delivery connections still
  // being there past the old expiry means they present the re-signed credential.
  check("A's endpoint and timer writer are still connected past the old credential's expiry", (await connz(0)).filter((c) => c.user === deliveryIds[0]!.id).length >= 2);
  const dAfter = (await connz(3)).map((c) => c.cid).sort((x, y) => x - y);
  const dLines = host.text().slice(dMark).split("\n").filter((l) => l.startsWith(`[${D}] `));
  check("D's connections were untouched by A's renewal and B's churn", JSON.stringify(dAfter) === JSON.stringify(dBefore), { dBefore, dAfter });
  check("D logged nothing while A renewed and B churned", dLines.length === 0, dLines);

  // ---- SIGTERM releases every lease --------------------------------------------------------------
  host.child.kill("SIGTERM");
  const code = await Promise.race([host.exited, wait(30_000).then(() => "timeout" as const)]);
  check("SIGTERM ends the host with exit 0, naming the signal", code === 0 && host.text().includes("• delivery host: received SIGTERM, closing every lane"), { code, tail: host.text().slice(-400) });
  const rows = await Promise.all([lease(inspectA), lease(inspectB), lease(inspectD)]);
  check("every lane released its lease before the process exited", rows.every((r) => r === undefined), rows);
}

/** One sample of a process's RSS and its cumulative CPU seconds. */
function sample(pid: number): { rssMb: number; cpuS: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[11]) + Number(fields[12]);
  return { rssMb: procMem(pid).rssMb, cpuS: ticks / 100 };
}

/** Real Plane-3 traffic for one space, built as fanout-load builds it: `count` members provisioned
 *  through core's onboarding step and joined durably to one channel at connect, each acking its
 *  durable copies on receipt. The first member posts. */
async function traffic(i: number, count: number) {
  const space = names[i]!, auth = auths[i]!, channel = "general";
  let copies = 0, posted = 0, postErrors = 0, errors = 0;
  const postedIds: string[] = [];
  const firstErrors: string[] = [];
  const note = (e: Error) => { errors++; if (firstErrors.length < 3) firstErrors.push(e.message.slice(0, 500)); };
  const received = VERIFY_DELIVERY ? Array.from({ length: count }, () => new Map<string, number>()) : undefined;
  const coverage = () => received?.map((ids, k) => deliveryCoverage(k === 0 ? [] : postedIds, ids));
  const prov = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "msd-prov", role: "manager", kind: "endpoint" } });
  prov.on("error", note);
  prov.on("warning", note);
  endpoints.push(prov);
  await prov.start();
  const members: CotalEndpoint[] = [];
  try {
    for (let k = 0; k < count; k++) {
      const identity = newIdentity(), uid = mintLifecycleUid();
      const creds = await provisionAgent(prov, auth, identity, { subscribe: [channel], allowSubscribe: [channel], allowPublish: [channel], role: "default", lifecycleUid: uid });
      const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid: uid, channels: [channel], card: { id: identity.id, name: `msd-member-${k}`, role: "default", kind: "agent" } });
      ep.on("error", note);
      ep.on("warning", note);
      ep.on("message", (m: CotalMessage, d: { durable: boolean; ack(): void }) => {
        if (d.durable) {
          copies++;
          const ids = received?.[k];
          if (ids) ids.set(m.id, (ids.get(m.id) ?? 0) + 1);
          d.ack();
        }
      });
      members.push(ep);
      endpoints.push(ep);
      await ep.start();
    }
  } finally {
    await prov.stop();
  }
  return {
    reset() { copies = 0; for (const ids of received ?? []) ids.clear(); },
    async post(rate: number, seconds: number) {
      const sends: Promise<void>[] = [];
      const t0 = Date.now();
      for (let n = 0; n < rate * seconds; n++) {
        const due = t0 + (n * 1000) / rate;
        if (due > Date.now()) await wait(due - Date.now());
        sends.push(members[0]!.multicast(`msd load #${n}`, { channel }).then((m) => {
          posted++;
          if (VERIFY_DELIVERY) postedIds.push(m.id);
        }, () => { postErrors++; }));
      }
      await Promise.all(sends);
      return posted;
    },
    complete: () => copies >= posted * (count - 1) && (coverage()?.every((c) => c.missing === 0) ?? true),
    result: () => ({ posted, postErrors, copies, expectedCopies: posted * (count - 1), errors, firstErrors, ...(VERIFY_DELIVERY ? { coverage: coverage() } : {}) }),
    async stop() { for (const ep of members) await ep.stop(); },
  };
}

/** Native CPU samples only: this endpoint does not request a heap profile or force GC. */
async function captureBrokerCpu(): Promise<void> {
  if (!CPU_PROFILE_DIR || !profilePort) throw new Error("CPU profile output was not configured");
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${profilePort}/debug/pprof/profile?seconds=${BROKER_PROFILE_SECONDS}`, {
    signal: AbortSignal.timeout((BROKER_PROFILE_SECONDS + 15) * 1000),
  });
  if (!response.ok) throw new Error(`broker CPU profile failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("broker CPU profile was empty");
  writeFileSync(join(CPU_PROFILE_DIR, "broker.pprof"), bytes, { mode: 0o600, flag: "wx" });
  writeFileSync(join(CPU_PROFILE_DIR, "broker-window.json"), JSON.stringify({
    requestStartedEpochMs: startedAt, responseEndedEpochMs: Date.now(), requestedSeconds: BROKER_PROFILE_SECONDS,
    scope: "Native broker CPU profile requested as posting begins; separate from the whole-child delivery profile.",
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

/** RSS and CPU per space for one shape. The five-second allowance is followed by a bounded
 * receiver-coverage wait; neither is evidence that every broker queue has drained. */
async function measureShape(label: string, spaces: number[], hostShape: boolean, seconds: number, rate: number): Promise<string> {
  const shape: Run[] = [];
  const launched = Date.now();
  if (hostShape) {
    writeManifest(manifestOf(spaces.map((i) => names[i]!)));
    shape.push(start(["deliver", "--spaces", manifest, "--server", servers]));
    if (!await until(() => shape[0]!.text().includes("✓ delivery host up") || shape[0]!.child.exitCode !== null, 300_000)) throw new Error(`${label}: host did not come up`);
  } else {
    for (const i of spaces) shape.push(start(["deliver", "--space", names[i]!, "--server", servers]));
    for (const run of shape) if (!await until(() => run.text().includes("delivery daemon up") || run.child.exitCode !== null, 300_000)) throw new Error(`${label}: a daemon did not come up`);
  }
  if (shape.some((r) => r.child.exitCode !== null)) throw new Error(`${label}: a process exited: ${shape.map((r) => r.text().slice(-300)).join("\n")}`);
  // The host-up message may describe a partial first batch. Read each account's ready lease
  // before any member binds its delivery durable, then close these measurement-only readers.
  const readers = await Promise.all(spaces.map((i) => inspector(i)));
  try {
    if (!await until(async () => (await Promise.all(readers.map((ep) => ep.readDeliveryLease(0)))).every((lease) => lease?.ready === true), 30_000))
      throw new Error(`${label}: not every delivery lease became ready before member startup`);
    check(`${label}: every delivery lease ready before member startup`, true);
  } finally {
    for (const ep of readers) await ep.stop();
  }
  const startup = (Date.now() - launched) / 1000;
  const loads = await Promise.all(spaces.map((i) => traffic(i, 3)));
  await wait(5_000);
  for (const l of loads) l.reset();
  const before = shape.map((r) => sample(r.child.pid!));
  const brokerBefore = sample(nats.pid!);
  const load0 = loadavg()[0]!;
  const t0 = Date.now();
  // Attach rejection handling immediately; a failed profile must fail the diagnostic, not go unhandled.
  const brokerProfile = CPU_PROFILE_DIR ? captureBrokerCpu().then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })) : undefined;
  const posted = (await Promise.all(loads.map((l) => l.post(rate, seconds)))).reduce((n, x) => n + x, 0);
  await wait(5_000);
  const completed = await until(() => loads.every((l) => l.complete()), 30_000);
  const window = (Date.now() - t0) / 1000;
  const brokerAfter = sample(nats.pid!);
  const after = shape.map((r) => sample(r.child.pid!));
  const results = loads.map((l, i) => ({ spaceIndex: spaces[i]!, ...l.result() }));
  for (const r of results) {
    check(`${label} space ${r.spaceIndex}: every scheduled publish acknowledged`, r.posted === Math.ceil(rate * seconds) && r.postErrors === 0, r);
    check(`${label} space ${r.spaceIndex}: receiver copies arrived without endpoint errors`, r.copies >= r.expectedCopies && r.errors === 0, r);
    if (VERIFY_DELIVERY) check(`${label} space ${r.spaceIndex}: recipient IDs match acknowledged publishes`, r.coverage?.length === 3 && r.coverage.every((c) => c.missing === 0 && c.unexpected === 0), r.coverage);
  }
  check(`${label}: receiver completion within allowance`, completed);
  const brokerWarningsErrors = (brokerLog.match(/\[(?:WRN|ERR|FTL)\]/g) ?? []).length;
  check(`${label}: no broker warnings/errors`, brokerWarningsErrors === 0, brokerWarningsErrors);
  const copies = results.reduce((n, r) => n + r.copies, 0);
  const rss = after.reduce((n, s) => n + s.rssMb, 0);
  const cpu = after.reduce((n, s, k) => n + s.cpuS - before[k]!.cpuS, 0);
  const brokerCpu = brokerAfter.cpuS - brokerBefore.cpuS;
  console.log(`MSD_RESULT ${JSON.stringify({ label, subscriptionCache: SUBLIST_CACHE, verifyDelivery: VERIFY_DELIVERY, cpuProfiling: Boolean(CPU_PROFILE_DIR), spaces: spaces.length, accounts: accounts.length, deliveryProcesses: shape.length, windowSeconds: window, posted, copies, brokerCpuSeconds: brokerCpu, brokerRssMiB: brokerAfter.rssMb, deliveryCpuSeconds: cpu, deliveryRssMiB: rss, brokerWarningsErrors, receiverComplete: completed, results })}`);
  if (brokerProfile) {
    const captured = await brokerProfile;
    if (!captured.ok) throw captured.error;
    check(`${label}: native broker CPU profile written`, true);
  }
  for (const l of loads) await l.stop();
  for (const run of shape) await killAndAwaitExit(run.child, "SIGTERM", 30_000);
  if (CPU_PROFILE_DIR) {
    const file = join(CPU_PROFILE_DIR, "delivery.cpuprofile");
    check(`${label}: actual delivery child CPU profile written`, existsSync(file) && statSync(file).size > 0);
  }
  await wait(2_000);
  const n = spaces.length;
  return `| ${label} | ${shape.length} | ${rss.toFixed(1)} | ${(rss / n).toFixed(1)} | ${(cpu / window * 100).toFixed(1)} | ${(cpu / window * 100 / n).toFixed(2)} | ${posted} | ${copies} | ${startup.toFixed(1)} | ${load0.toFixed(1)} |`;
}

async function measure(): Promise<void> {
  if (!await until(() => isReachable(servers), 15_000)) throw new Error("broker did not come up");
  for (let i = 0; i < names.length; i++) await provision(i);
  const all = names.map((_, i) => i);
  const version = spawnSync("nats-server", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error("cannot read native broker version");
  console.log(`\nMeasured on ${cpus().length} vCPU, Node ${process.version}, ${version.stdout.trim()}, subscription cache ${SUBLIST_CACHE}, recipient ID verification ${VERIFY_DELIVERY ? "on (tracking overhead)" : "off (aggregate only)"}, shape ${SHAPE}, CPU profiling ${CPU_PROFILE_DIR ? "on (diagnostic overhead; delivery startup through exit, broker first up to60s of posting)" : "off"}. Per space: 3 durable members, one posting ${RATE}/s for ${SECONDS}s. CPU includes a 5s allowance and up to 30s for receiver completion.\n`);
  console.log("| shape | processes | RSS total MiB | RSS per space MiB | CPU % total | CPU % per space | posted | durable copies | all serving after s | load avg |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  if (SHAPE === "all") {
    console.log(await measureShape("1 lane, one process", [0], true, SECONDS, RATE));
    console.log(await measureShape("4 lanes, one process", all.slice(0, 4), true, SECONDS, RATE));
  }
  if (SHAPE !== "single16") console.log(await measureShape("16 lanes, one process", all, true, SECONDS, RATE));
  if (SHAPE !== "host16") console.log(await measureShape("16 single-space processes", all, false, SECONDS, RATE));
}

try {
  if (MEASURE) await measure();
  else await suite();
} catch (error) {
  fail++;
  console.log(`  ✗ FAIL: the suite threw: ${(error as Error).stack ?? error}`);
} finally {
  if (fail > 0) for (const run of runs) console.log(`--- cotal ${run.label} output, last 3000 chars ---\n${run.text().slice(-3000)}`);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await killAndAwaitExit(child, "SIGKILL");
  for (const nc of callers) await nc.close().catch(() => {});
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await killAndAwaitExit(nats, "SIGKILL");
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ndelivery multi-space${MEASURE ? " measure" : ""}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
