/**
 * One delivery process serving several spaces: the real `cotal deliver --spaces <manifest>` binary on
 * a live `nats-server` that holds one account per space, every credential read from one workstation
 * root the way Cotal Cloud runs the daemon (cwd at the root, no `--creds`).
 *
 * What it proves, each from the broker rather than from the host's own report:
 *  - the `--spaces` refusals, and the all-or-nothing startup that names the space it cannot serve and
 *    leaves no lease behind;
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
 * to one channel and one of them posting at a fixed rate.
 *
 * Runs the BUILT dist (`pnpm build` first). Needs `nats-server` on PATH.
 * Run: pnpm smoke:delivery-multi-space
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
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

const MEASURE = process.argv.includes("--measure");
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
const servers = `nats://127.0.0.1:${port}`;
const tag = randomUUID().slice(0, 6);
const brokerAuth = await createBrokerAuth(`msd-${tag}`);
/** Spaces the broker knows. The suite provisions the first `provisioned` of them into the root. */
const spaceCount = MEASURE ? 16 : 4;
const names = Array.from({ length: spaceCount }, (_, i) => `msd-${tag}-${String.fromCharCode(97 + i)}`);
const accounts = await Promise.all(names.map((space) => createSpaceAccountAuth(brokerAuth, space)));
const auths: SpaceAuth[] = accounts.map((account) => composeSpaceAuth(brokerAuth, account));
const config = join(dir, "server.conf");
writeFileSync(config, serverConfig(brokerAuth, accounts, { transport: { kind: "plaintext" }, port, host: "127.0.0.1", storeDir: join(dir, "js") }), { mode: 0o600 });
const nats = spawn("nats-server", ["-c", config], { stdio: "ignore" });
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
  const child = spawn(process.execPath, [cotalJs, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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

  // ---- startup is all or nothing ----------------------------------------------------------------
  writeManifest(manifestOf([A, C]));
  {
    const run = start(["deliver", "--spaces", manifest, "--server", servers]);
    const code = await Promise.race([run.exited, wait(90_000).then(() => "timeout" as const)]);
    check("a manifest naming an unserviceable space refuses startup with a non-zero exit", typeof code === "number" && code !== 0, { code, out: run.text().slice(-600) });
    check("the refusal names that space and says no lane was left running", run.text().includes(`deliver --spaces: space "${C}" could not be served`) && run.text().includes("no lane was left running"), run.text().slice(-600));
    check("the lane that had opened released its lease before the exit", (await lease(inspectA)) === undefined);
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
async function traffic(i: number, count: number): Promise<{ post(rate: number, seconds: number): Promise<number>; copies(): number; stop(): Promise<void> }> {
  const space = names[i]!, auth = auths[i]!, channel = "general";
  const prov = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "msd-prov", role: "manager", kind: "endpoint" } });
  prov.on("error", () => {});
  await prov.start();
  const members: CotalEndpoint[] = [];
  let copies = 0;
  try {
    for (let k = 0; k < count; k++) {
      const identity = newIdentity(), uid = mintLifecycleUid();
      const creds = await provisionAgent(prov, auth, identity, { subscribe: [channel], allowSubscribe: [channel], allowPublish: [channel], role: "default", lifecycleUid: uid });
      const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid: uid, channels: [channel], card: { id: identity.id, name: `msd-member-${k}`, role: "default", kind: "agent" } });
      ep.on("error", () => {});
      ep.on("warning", () => {});
      ep.on("message", (_m: CotalMessage, d: { durable: boolean; ack(): void }) => { if (d.durable) { copies++; d.ack(); } });
      await ep.start();
      members.push(ep);
    }
  } finally {
    await prov.stop();
  }
  return {
    async post(rate, seconds) {
      let posted = 0;
      const sends: Promise<void>[] = [];
      const t0 = Date.now();
      for (let n = 0; n < rate * seconds; n++) {
        const due = t0 + (n * 1000) / rate;
        if (due > Date.now()) await wait(due - Date.now());
        sends.push(members[0]!.multicast(`msd load #${n}`, { channel }).then(() => { posted++; }, () => {}));
      }
      await Promise.allSettled(sends);
      return posted;
    },
    copies: () => copies,
    async stop() { for (const ep of members) await ep.stop().catch(() => {}); },
  };
}

/** RSS and CPU per space for one shape, under the same offered Plane-3 traffic per space. */
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
  const startup = (Date.now() - launched) / 1000;
  const loads = await Promise.all(spaces.map((i) => traffic(i, 3)));
  await wait(5_000); // let start-up and the members' joins settle before the window opens
  const before = shape.map((r) => sample(r.child.pid!));
  const load0 = loadavg()[0]!;
  const t0 = Date.now();
  const posted = (await Promise.all(loads.map((l) => l.post(rate, seconds)))).reduce((n, x) => n + x, 0);
  await wait(5_000); // the daemons' fan-out drains inside the window
  const window = (Date.now() - t0) / 1000;
  const after = shape.map((r) => sample(r.child.pid!));
  const copies = loads.reduce((n, l) => n + l.copies(), 0);
  const rss = after.reduce((n, s) => n + s.rssMb, 0);
  const cpu = after.reduce((n, s, k) => n + s.cpuS - before[k]!.cpuS, 0);
  for (const l of loads) await l.stop();
  for (const run of shape) await killAndAwaitExit(run.child, "SIGTERM", 30_000);
  await wait(2_000);
  const n = spaces.length;
  return `| ${label} | ${shape.length} | ${rss.toFixed(1)} | ${(rss / n).toFixed(1)} | ${(cpu / window * 100).toFixed(1)} | ${(cpu / window * 100 / n).toFixed(2)} | ${posted} | ${copies} | ${startup.toFixed(1)} | ${load0.toFixed(1)} |`;
}

async function measure(): Promise<void> {
  if (!await until(() => isReachable(servers), 15_000)) throw new Error("broker did not come up");
  for (let i = 0; i < names.length; i++) await provision(i);
  const seconds = Number(process.env.COTAL_MSD_SECONDS) || 30, rate = Number(process.env.COTAL_MSD_RATE) || 2;
  const all = names.map((_, i) => i);
  console.log(`\nMeasured on ${cpus().length} vCPU, Node ${process.version}, per space: 3 durable members of one channel, one posting ${rate} messages/s for ${seconds}s, CPU over the posting window plus a 5s drain.\n`);
  console.log("| shape | processes | RSS total MB | RSS per space MB | CPU % total | CPU % per space | posted | durable copies | all serving after s | load avg |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  console.log(await measureShape("1 lane, one process", [0], true, seconds, rate));
  console.log(await measureShape("4 lanes, one process", all.slice(0, 4), true, seconds, rate));
  console.log(await measureShape("16 lanes, one process", all, true, seconds, rate));
  console.log(await measureShape("16 single-space processes", all, false, seconds, rate));
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
if (!MEASURE) {
  console.log(`\ndelivery multi-space: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
process.exit(fail === 0 ? 0 : 1);
