/**
 * INT-2 REVOKE-HOLD smoke — a failed user-mode ledger revoke must NOT free the name (a copied actor
 * token could still mint while the standing-authority row lives). POSIX-only (chmod fault injection).
 * Run: pnpm smoke:int2-revoke:live   (pnpm build first — Manager + the agent child load dist; needs
 * nats-server + node on PATH). Provenance: reuses the freeslot user-mode E2E scaffolding.
 *
 * Reuses the freeslot user-mode E2E scaffolding (real Manager + auth service + IdP + spawn/despawn/
 * exchange). C: chmod the managed-actors dir read-only so revokeAgent's rmSync throws EACCES, despawn
 * -> assert the name stays HELD (not "free for reuse"), the hold carries standingAuthorityLive + the
 * revoke-failure operator copy, and a same-name respawn is refused with the operator face. D: clear
 * the fault, re-drive the teardown -> the revoke succeeds, the row is deleted, the name frees.
 * FINDING: on the current tree the copied token's exchange is blocked by the DEEPER auth-plane gate
 * retirement (terminally-retired issuance gate), so the ledger-hold is a defense-in-depth belt over
 * the surviving row; "copied token mints" only reproduces if the RAIL retirement also fails.
 * MEASURED on the current tree: 20 passed, 0 failed, and the suite is now GATED: it is in
 * bin/smoke/ci-suites.txt, so a CI shard runs it. Phase C is green throughout (the hold,
 * standingAuthorityLive, the operator copy, the refused respawn, the copied token blocked by the
 * retired gate). Phase D's last cell, a same-name spawn takes the EXACT alias after recovery, had
 * been reading RED because it spawned once: after the recovery nudge the reservation clears within
 * ~1s, but the predecessor's advisory presence row keeps uniqueName numbering the successor until
 * that record's TTL plus one sweep tick expires (endpoint.ts: ttlMs 6000, sweep every ttlMs/3), and
 * the auth plane refuses the numbered name-form. The single shot landed inside that window, so the
 * cell now retries to a deadline past its ceiling. The numbered-name refusal is itself real and is
 * tracked as #694, same mechanism as #693 and #667. Until the store wiring was repaired this suite
 * threw before its first cell, so its cells are newly VISIBLE rather than newly caused. Pristine
 * f6115a6 would free the name (RED). READ+RUN only.
 *
 * PHASES: A/B spawn a user-mode agent and capture a copied actor token; C chmod the managed-actor
 * ledger dir read-only so revokeAgent's rmSync throws EACCES, despawn, and assert the name stays HELD
 * with standingAuthorityLive + the revoke-failure operator copy, a same-name spawn refused with no
 * successor + the SAME hold, and the copied token blocked by the retired gate while its row still
 * lives; D clear the fault and recover through the DOCUMENTED public same-name spawn nudge (latched on
 * row-deleted + hold-cleared), then the alias is reusable. Reuses the freeslot user-mode scaffolding.
 * The default invocation also runs the short-bound comparison and the managed connection probes.
 */
import assert from "node:assert/strict";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, createSuite } from "@cotal-ai/smoke-kit";

// ---------- SELF-DISPATCH (must be the FIRST thing that runs) ----------
// The manager builds the agent's bearer argv from `process.argv[1]`, which in this in-process
// smoke is THIS file; the smoke also re-execs itself to run the auth-service daemon. Intercept
// both before the heavy harness loads (same shape as user-spawn.smoke.ts).
const SUBCOMMAND = process.argv[2] ?? "";
const connectionCase = process.env.SMOKE_MANAGED_CONNECTION_CASE;
const bearerSec = 8;
const connectionSec = connectionCase === "short" ? bearerSec : 12 * bearerSec;
if (SUBCOMMAND === "agent-bearer" || SUBCOMMAND === "auth-service") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const rest = process.argv.slice(3);
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) { values[key] = next; i++; }
      else values[key] = true;
    } else positionals.push(a);
  }
  // The real contract, rather than a hand-written shape: `all` constrains its type argument to
  // Extension, which the inline shape did not satisfy because it omitted `kind`, and ParsedArgs is
  // exactly the values/positionals/raw triple this dispatcher already passes.
  const cmd = registry.all<Command>("command").find((c) => c.name === SUBCOMMAND);
  if (!cmd) { console.error(`self-dispatch: command "${SUBCOMMAND}" is not registered`); process.exit(1); }
  try {
    const args = { values, positionals, raw: rest };
    if (SUBCOMMAND === "auth-service" && connectionCase !== "retirement") {
      const { runAuthService } = await import("../src/service-host.js");
      await runAuthService(args, undefined, { probeManagedLifetimes: { bearerSec, connectionSec } });
    } else await cmd.run(args);
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  }
}

// POSIX-only: the revoke-failure is injected by chmod-ing the managed-actor ledger dir read-only so
// `revokeAgent`'s `rmSync` throws EACCES. Windows does not honor a directory's POSIX mode bits for the
// owner, so the fault would not arm; the INT-2 behavior under test is platform-independent and proven
// on POSIX, so a non-POSIX host skips rather than false-fails.
if (process.platform === "win32") {
  console.log("INT-2 REVOKE-HOLD SMOKE — SKIP on Windows (chmod-based revoke-fault injection is POSIX-only)");
  process.exit(0);
}

// ---------- MAIN HARNESS ----------
type ChildProcess = import("node:child_process").ChildProcess;
type Connector = import("@cotal-ai/core").Connector;
type LaunchOpts = import("@cotal-ai/core").LaunchOpts;
type LaunchSpec = import("@cotal-ai/core").LaunchSpec;
type ControlReply = import("@cotal-ai/core").ControlReply;

const { spawn } = await import("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync, renameSync, symlinkSync } = await import("node:fs");

if (!connectionCase) {
  for (const mode of ["retirement", "short", "revocation", "damage", "continuity"]) {
    const result = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!], {
        env: { ...process.env, SMOKE_MANAGED_CONNECTION_CASE: mode }, stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (result !== 0) process.exit(result);
  }
  process.exit(0);
}

/** `Manager.list` is PRIVATE; the cells below read one field off the row `cotal ps` renders, so the
 *  reach goes through one named view rather than a cast per call site, and the view names that field
 *  and no other. Widening the method to public would be a shipped-source change made for a test's
 *  convenience, which is not this change's business. */
type PsRow = { name: string };
const psList = (m: object, ownerFilter?: string): PsRow[] =>
  (m as unknown as { list: (o?: string) => PsRow[] }).list(ownerFilter);
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const home = mkdtempSync(join(tmpdir(), "cotal-fsb-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}fsb-root-`));

const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { jwt } = await import("better-auth/plugins/jwt");
const { deviceAuthorization } = await import("better-auth/plugins/device-authorization");
const { bearer: baBearer } = await import("better-auth/plugins/bearer");
const { toNodeHandler } = await import("better-auth/node");
const { createServer } = await import("node:http");
type AddressInfo = import("node:net").AddressInfo;

const {
  createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  principalKey, registry, dmStream, dlvStream, openAclRegistry,
  createEndpointStreams, connzRequestSubject, MEMBERSHIP_INBOX_PREFIX, mintMembershipObserverCreds,
  epAuthBucket, credRowKey, livenessSubject, userInboxConnId, dmDurable, unicastSubject, recordsBucket, uidReservationKey, mintLifecycleUid,
} = await import("@cotal-ai/core");
const { connect, credsAuthenticator, tokenAuthenticator, NoRespondersError, RequestError } = await import("@nats-io/transport-node");
const { JetStreamApiError, jetstream, jetstreamManager } = await import("@nats-io/jetstream");
const { startManagedConnectionSweep } = await import("../src/managed-connections.js");
const { Kvm } = await import("@nats-io/kv");
const { encodeUser, fmtCreds } = await import("@nats-io/jwt");
const { fromPublic, fromSeed } = await import("@nats-io/nkeys");
const { agentCredsDir, authDir, userAuthStateDir, saveSpaceAuth, recordMesh, assertUserAuthInfo, agentLifecycleSecretFilePaths, workspaceSecretStore } = await import("@cotal-ai/workspace");
const {
  cotalAuthProvider, establishIdpSession, grantActor, loadAuthServiceInfo,
  managedActorLedgerDir, ledgerRowFilename, findInteractiveActor,
} = await import("@cotal-ai/auth");
const { approveDevice } = await import("./_device-approval.js");
const { bootDeliveryDaemon } = await import("../../manager/smoke/_boot-delivery.js");
// @cotal-ai/manager is not a dep of @cotal-ai/auth — drive the REAL Manager from its built dist by
// relative path (shares the one @cotal-ai/core dist registry with the in-process connector).
const { Manager } = await import("../../manager/dist/index.js");
type DeviceLoginPrompt = import("@cotal-ai/auth").DeviceLoginPrompt;

/** The four COTAL_* vars configFromEnv parses for a user-mode launch (connector-core's userAuthEnv). */
function userAuthEnv(o: LaunchOpts): Record<string, string> {
  if (!o.userAuth) return {};
  return {
    COTAL_OWNER: o.userAuth.owner,
    COTAL_ACTOR: o.userAuth.actor,
    COTAL_SENTINEL_CREDS: o.userAuth.sentinelCredsPath,
    COTAL_BEARER_CMD: JSON.stringify(o.userAuth.bearerCmd),
  };
}
function launchEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "LANG", "TERM"]) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

const { check, finish, passed, failed } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SELF = process.argv[1];
const { pickFreePort } = await import("../../../packages/core/smoke/_free-port.js");
const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `fsb-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const AGENT = "worker";
const DAMAGE_ACTOR = `chat_${"a".repeat(26)}`;
const dir = userAuthStateDir(root, SPACE);
// The provider's SECRET seam. `prepareServer` and `ownerForLogin` both REQUIRE it (callout account,
// issuer keys, owner secret, service key projection all ride it); the calls below used to omit it,
// so the provider was reached with `store` undefined. Same workspace-rooted store the CLI composes.
const store = workspaceSecretStore(root);
// This space's agent-secret segment (P1) — where the CLI and manager actually file an
// incarnation's family, so a scan for one reads the layout under test.
const credsDir = agentCredsDir(root, SPACE);
const coreDist = join(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js");

// The agent CHILD: a real long-lived node process through the real pty runtime, connecting
// user-mode with a bearer SOURCE (execs COTAL_BEARER_CMD) + the sentinel creds.
const CHILD = [
  "const fs=require('node:fs');",
  "const {pathToFileURL}=require('node:url');",
  "const argv=JSON.parse(process.env.COTAL_BEARER_CMD);",
  "const sentinel=fs.readFileSync(process.env.COTAL_SENTINEL_CREDS,'utf8');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async(m)=>{",
  "const f=process.env.FSB_REQUEST;",
  "const ep=new m.CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,bearer:()=>m.runAgentBearer(argv),sentinelCreds:sentinel,lifecycleUid:process.env.COTAL_LIFECYCLE_UID,channels:[],consume:!!f,registerPresence:true,watchPresence:false,card:{name:process.env.COTAL_NAME,owner:process.env.COTAL_OWNER,actor:process.env.COTAL_ACTOR,kind:'agent'}});",
  "if(f)ep.on('message',(msg,delivery,meta)=>{if(meta?.kind!=='dm')return;fs.appendFileSync(f+'.dm',JSON.stringify({id:msg.id,durable:delivery.durable})+'\\n');delivery.ack();});",
  "ep.on('error',()=>{});await ep.start();",
  "if(f){const tick=setInterval(async()=>{if(!fs.existsSync(f+'.go'))return;clearInterval(tick);try{const subject=fs.readFileSync(f+'.go','utf8');const r=await ep.requestBoundReply(ep.conn.nc,subject,'',subject+'.reply.'+require('node:crypto').randomUUID(),15000);fs.writeFileSync(f+'.result',r.string());}catch(e){fs.writeFileSync(f+'.result','error: '+e.message);}},50);}",
  "if(process.env.FSB_READY)fs.writeFileSync(process.env.FSB_READY,'1');",
  "setInterval(()=>{},1000);",
  "}).catch((e)=>{console.error(e&&e.message||String(e));process.exit(1);});",
].join("\n");
const e2eCon: Connector = {
  kind: "connector",
  name: "e2e",
  requires: ["node"],
  buildLaunch: (o: LaunchOpts): LaunchSpec => ({
    command: process.execPath,
    args: ["-e", CHILD],
    env: {
      ...launchEnv(),
      ...userAuthEnv(o),
      CORE_DIST: coreDist,
      COTAL_SPACE: o.space,
      COTAL_NAME: o.name,
      COTAL_SERVERS: o.servers ?? "",
      // The manager mints one lifecycle uid per spawn and provisions the agent's dm_/dlv_ under
      // it; the child endpoint binds by the SAME uid (an authed presence-registering agent proves
      // its lifecycle against its dm_ durable before presence, SPEC 13.1 fail-before-presence).
      ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
      FSB_READY: join(root, "child-connected"),
      ...(connectionCase === "continuity" && o.userAuth?.actor === AGENT ? { FSB_REQUEST: join(root, "renewal-request") } : {}),
    },
  }),
};
registry.register(e2eCon);

function spawnAuthService(): ChildProcess {
  const child = spawn(process.execPath, [...process.execArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER], {
    cwd: root,
    env: { ...process.env, COTAL_HOME: home },
    stdio: ["ignore", "ignore", connectionCase === "revocation" ? "pipe" : "ignore"],
  });
  if (child.stderr) {
    let partial = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const line of lines) if (line.startsWith("auth-plane: managed eviction unverified ")) evictionWarnings.push(line);
    });
  }
  return child;
}
async function waitAuthReady(ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const info = loadAuthServiceInfo(dir);
    if (info) {
      let alive = false;
      try { process.kill(info.pid, 0); alive = true; } catch { /* not up yet */ }
      if (alive) { try { const r = await fetch(`${info.url}/health`); if (r.ok) return; } catch { /* not bound yet */ } }
    }
    await wait(150);
  }
  throw new Error(`auth service did not become ready under ${dir} in ${ms}ms`);
}
async function agentExchange(actor: string, actorToken: string, owner: string): Promise<{ status: number; body: { token?: string; error?: string } }> {
  const info = loadAuthServiceInfo(dir)!;
  const res = await fetch(`${info.url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify({ owner, actor, actorToken }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { token?: string; error?: string } };
}
const managedRowPath = (owner: string) => join(managedActorLedgerDir(dir), ledgerRowFilename(owner, AGENT));

type BrokerSeat = { cid: number; name: string; authorized_user: string; start: string; stop?: string; reason?: string };

async function untilObserved<T>(timeoutMs: number, read: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await wait(1000);
  } while (Date.now() < deadline);
}

async function verifyAuthorityOutage(original: BrokerSeat[], read: (closed: boolean) => Promise<BrokerSeat[]>): Promise<void> {
  const short = connectionCase === "short";
  const oldest = Math.min(...original.map(({ start }) => Date.parse(start)));
  if (!short) await wait(Math.max(0, oldest + connectionSec * 500 - 7000 - Date.now()));
  const child = authChild!;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert(child.kill("SIGTERM"));
  await exited;
  authChild = undefined;
  const started = Date.now();
  console.log(`authority stopped at ${new Date(started).toISOString()}`);
  const ids = new Set(original.map(({ cid }) => cid));
  const closed = new Map<number, BrokerSeat>();
  await untilObserved(short ? (bearerSec + 3) * 1000 : connectionSec * 500, async () => {
    for (const seat of await read(true)) {
      if (!ids.has(seat.cid) || closed.has(seat.cid)) continue;
      closed.set(seat.cid, seat);
      console.log(`seat ${seat.cid} closed after ${Date.parse(seat.stop!) - started} ms: ${seat.reason}`);
    }
    return short && closed.size === ids.size && Date.now() - started > bearerSec * 1000 ? true : undefined;
  });
  const remaining = (await read(false)).filter(({ cid }) => ids.has(cid));
  const elapsed = Date.now() - started;
  authChild = spawnAuthService();
  await waitAuthReady();
  if (short) {
    assert.equal(remaining.length, 0, "the scaled short broker bound cannot survive the authority stop");
    assert.equal(closed.size, ids.size);
    for (const seat of closed.values()) assert.equal(seat.reason, "Authentication Expired");
    console.log(`both original connections closed at the scaled short bound (${bearerSec}s)`);
    return;
  }
  assert.equal(remaining.length, ids.size, `both original connections must survive the scaled 30-minute outage: ${JSON.stringify([...closed.values()])}`);
  console.log(`both original connections survived ${elapsed} ms without authority`);
}

async function assertSeatKicked(label: string, started: number, victim: BrokerSeat, read: (closed: boolean) => Promise<BrokerSeat[]>): Promise<void> {
  const closed = await untilObserved((bearerSec + 1) * 1000, async () => (await read(true)).find(({ cid }) => cid === victim.cid));
  assert(closed?.stop, "the revoked seat's original connection must close within the five-minute bound");
  const elapsed = Date.parse(closed.stop) - started;
  console.log(`${label}: seat ${victim.cid} closed after ${elapsed} ms: ${closed.reason}`);
  assert(elapsed >= 0 && elapsed <= (bearerSec + 1) * 1000 && closed.reason === "Kicked", "delivery must actively evict the revoked seat within the scaled five-minute bound");
}

async function verifyManagedRetirement(owner: string, actor: string, read: (closed: boolean) => Promise<BrokerSeat[]>): Promise<void> {
  const row = JSON.parse(readFileSync(join(managedActorLedgerDir(dir), ledgerRowFilename(owner, actor)), "utf8")) as { lifecycleUid: string };
  const files = agentLifecycleSecretFilePaths(root, SPACE, actor, row.lifecycleUid);
  const exchange = await agentExchange(actor, readFileSync(files.actorToken, "utf8").trim(), owner);
  assert.equal(exchange.status, 200);
  const name = userInboxConnId(owner, actor);
  const witness = await connect({ servers: SERVER, name, inboxPrefix: `_INBOX_${name}`, reconnect: false,
    authenticator: [credsAuthenticator(readFileSync(files.sentinelCreds)), tokenAuthenticator(exchange.body.token!)] });
  try {
    const victim = (await read(false)).find((seat) => seat.name === name);
    assert(victim, "an independent connection must hold this lifecycle's grants before retirement");
    const m = manager as unknown as { opStop: (args: { name: string }, caller: string, admin: boolean) => Promise<ControlReply>; ep: { ref: () => { id: string } } };
    const started = Date.now();
    const stopped = await m.opStop({ name: actor }, m.ep.ref().id, true);
    assert(stopped.ok, stopped.error);
    await assertSeatKicked("lifecycle retired", started, victim, read);
  } finally { await witness.close(); }
}

async function verifyManagedRevoke(owner: string, victim: BrokerSeat, control: BrokerSeat, read: (closed: boolean) => Promise<BrokerSeat[]>, nc: import("@nats-io/transport-node").NatsConnection): Promise<void> {
  const spawn = async (actor: string) => {
    writeFileSync(join(root, ".cotal", "agents", `${actor}.md`), `---\nname: ${actor}\nrole: worker\nsubscribe: [general]\nallowPublish: [general]\n---\nProbe seat.\n`);
    const result = await manager!.startAgent({ name: actor, agent: "e2e", events: false, allowSubscribe: ["general"], allowPublish: ["general"] }, `${owner}.cli`);
    assert(result.ok, result.error);
    const connected = await untilObserved(15_000, async () => (await read(false)).find(({ authorized_user }) => authorized_user === principalKey(owner, actor).name));
    assert(connected, `${actor} must bind before its grant changes`);
    return connected;
  };
  const parent = findInteractiveActor(dir, owner, "cli")!;
  await spawn("retired");
  const delegated = await spawn("delegated");
  const narrowedOffline = await spawn("narrowed_offline");
  const admission = await spawn("admission");
  const { lifecycleUid } = JSON.parse(readFileSync(managedRowPath(owner), "utf8")) as { lifecycleUid: string };
  const actorToken = readFileSync(agentLifecycleSecretFilePaths(root, SPACE, AGENT, lifecycleUid).actorToken, "utf8").trim();
  assert.equal((await agentExchange(AGENT, actorToken, owner)).status, 200);
  let started = Date.now();
  assert(await cotalAuthProvider.revokeAgent({ dir, owner, actor: AGENT, lifecycleUid }));
  assert.equal((await agentExchange(AGENT, actorToken, owner)).status, 401);
  await assertSeatKicked("managed row revoked", started, victim, read);

  const { lifecycleUid: admissionUid } = JSON.parse(readFileSync(join(managedActorLedgerDir(dir), ledgerRowFilename(owner, "admission")), "utf8")) as { lifecycleUid: string };
  const admissionToken = readFileSync(agentLifecycleSecretFilePaths(root, SPACE, "admission", admissionUid).actorToken, "utf8").trim();
  const exchange = await agentExchange("admission", admissionToken, owner);
  assert.equal(exchange.status, 200);
  const claim = JSON.parse(Buffer.from(exchange.body.token!.split(".")[1]!, "base64url").toString()) as { act: { credentialId: string } };
  const kv = await new Kvm(nc).open(epAuthBucket(SPACE));
  const key = credRowKey(admissionUid, claim.act.credentialId);
  const rootEntry = await kv.get(key);
  assert(rootEntry);
  started = Date.now();
  await kv.update(key, JSON.stringify({ ...rootEntry.json<Record<string, unknown>>(), exp: started }), rootEntry.revision);
  await assertSeatKicked("admission expired", started, admission, read);

  await verifyManagedRetirement(owner, "retired", read);
  started = Date.now();
  grantActor(dir, { ...parent, allowPublish: [] });
  await assertSeatKicked("parent envelope narrowed", started, delegated, read);
  await assertSeatKicked("parent envelope narrowed (second child)", started, narrowedOffline, read);
  // Restore parent grant and spawn a fresh direct child to test narrowing while delivery is stopped:
  grantActor(dir, parent);
  const directChild = await spawn("narrowed_renew");
  assert((await read(false)).some(({ cid }) => cid === control.cid), "the unrevoked control seat must retain its original connection");
  await verifyRefusalWithoutEviction(owner, directChild, parent, read);
}

async function verifyRefusalWithoutEviction(
  owner: string,
  directChild: BrokerSeat,
  parent: NonNullable<ReturnType<typeof findInteractiveActor>>,
  read: ReadSeats,
): Promise<void> {
  const actor = "unrevoked";
  const { lifecycleUid } = JSON.parse(readFileSync(join(managedActorLedgerDir(dir), ledgerRowFilename(owner, actor)), "utf8")) as { lifecycleUid: string };
  const victim = (await read(false)).find(({ authorized_user }) => authorized_user === principalKey(owner, actor).name);
  assert(victim);
  const { lifecycleUid: childUid } = JSON.parse(readFileSync(join(managedActorLedgerDir(dir), ledgerRowFilename(owner, "narrowed_renew")), "utf8")) as { lifecycleUid: string };
  const childToken = readFileSync(agentLifecycleSecretFilePaths(root, SPACE, "narrowed_renew", childUid).actorToken, "utf8").trim();
  const da = delivery!;
  await da.stop();
  delivery = undefined;
  const actorToken = readFileSync(agentLifecycleSecretFilePaths(root, SPACE, actor, lifecycleUid).actorToken, "utf8").trim();
  assert(await cotalAuthProvider.revokeAgent({ dir, owner, actor, lifecycleUid }));
  assert.equal((await agentExchange(actor, actorToken, owner)).status, 401);
  // Narrow the direct non-admin parent (`cli`) while delivery is stopped so eviction cannot kick `narrowed_renew`:
  grantActor(dir, { ...parent, allowPublish: [] });
  const narrowEx = await agentExchange("narrowed_renew", childToken, owner);
  assert.equal(narrowEx.status, 401);
  assert.match(narrowEx.body.error ?? "", /^agent "narrowed_renew" exceeds its spawner's CURRENT grant \(narrowed since spawn\):/);
  assert((await read(false)).some(({ cid }) => cid === victim.cid), "the resident socket is live just after the revoke with delivery down");
  assert((await read(false)).some(({ cid }) => cid === directChild.cid), "the narrowed direct child is live just after parent narrowing with delivery down");
  const maxRenewalMs = Math.ceil(connectionSec * 550) + 8000;
  const closed = await untilObserved(maxRenewalMs, async () => (await read(true)).find(({ cid }) => cid === victim.cid));
  assert(closed?.stop);
  const age = Date.parse(closed.stop) - Date.parse(victim.start);
  assert(age >= connectionSec * 500 - 2000 && age < maxRenewalMs, `client must close at renewal, not at expiry: ${age}ms`);
  assert.equal(closed.reason, "Client Closed");
  const childClosed = await untilObserved(maxRenewalMs, async () => (await read(true)).find(({ cid }) => cid === directChild.cid));
  assert(childClosed?.stop, "direct child whose non-admin parent was narrowed while delivery was down must self-close at renewal");
  const childAge = Date.parse(childClosed.stop) - Date.parse(directChild.start);
  assert(childAge >= connectionSec * 500 - 2000 && childAge < maxRenewalMs, `narrowed direct child must close at renewal, not at expiry: ${childAge}ms`);
  assert.equal(childClosed.reason, "Client Closed");
  assert.equal(evictionWarnings.filter((line) => line.includes(`/${victim.cid}:`)).length, 1,
    "failed exact eviction must log once per resident socket even across retries");
  console.log(`definitive renewal refusals closed revoked (${age}ms) and direct-parent-narrowed (${childAge}ms) sockets with delivery down`);
}

type ReadSeats = (closed: boolean) => Promise<BrokerSeat[]>;
type SmokeConnection = import("@nats-io/transport-node").NatsConnection;

async function verifyDamagedAuthority(owner: string, signingSeed: string, read: ReadSeats, nc: SmokeConnection): Promise<void> {
  const actor = DAMAGE_ACTOR;
  // The Manager reserves chat-shaped names. Provision an otherwise valid historical grant at the
  // authority fixture so both spaces can be populated independently without changing that rule.
  const lifecycleUid = mintLifecycleUid();
  const files = await cotalAuthProvider.grantAgent({ store, dir, space: SPACE, owner, actor, lifecycleUid,
    scope: [], allowSubscribe: ["general"], allowPublish: ["general"], custody: { kind: "local-manager", instanceId: mintLifecycleUid() } });
  assert.equal((await agentExchange(actor, files.actorToken, owner)).status, 200);
  const dirPath = managedActorLedgerDir(dir);
  const filename = ledgerRowFilename(owner, actor);
  const path = join(dirPath, filename);
  const raw = readFileSync(path, "utf8");
  const ncAuth = new Kvm(nc);
  const authKv = await ncAuth.open(epAuthBucket(SPACE));
  const recordsKv = await ncAuth.open(recordsBucket(SPACE));
  const reservationKey = uidReservationKey(lifecycleUid);
  const reservation = await recordsKv.get(reservationKey);
  assert(reservation);
  const dial = async (token: string, name: string) => connect({ servers: SERVER, name, inboxPrefix: `_INBOX_${name}`, reconnect: false,
    authenticator: [credsAuthenticator(new TextEncoder().encode(files.sentinelCreds)), tokenAuthenticator(token)] });
  const damage = async (label: string, change: (credentialId: string) => Promise<() => void | Promise<unknown>>) => {
    const exchange = await agentExchange(actor, files.actorToken, owner);
    assert.equal(exchange.status, 200);
    const token = exchange.body.token!;
    const { act } = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { act: { credentialId: string } };
    const name = userInboxConnId(owner, actor);
    const witness = await dial(token, name);
    const observed = (await read(false)).find((seat) => seat.name === name);
    assert(observed);
    try {
      const started = Date.now();
      const restore = await change(act.credentialId);
      try {
        await assert.rejects(async () => { const denied = await dial(token, userInboxConnId(owner, actor)); await denied.close(); });
        await assertSeatKicked(label, started, observed, read);
      } finally { await restore(); }
    } finally { await witness.close(); }
  };
  await damage("corrupt managed row", async () => {
    writeFileSync(path, "{");
    assert.equal((await agentExchange(actor, files.actorToken, owner)).status, 401);
    return () => writeFileSync(path, raw);
  });
  // Transient local filesystem row-read fault (`chmod 0` -> EACCES when unprivileged):
  // "the row could not be read", NOT "the row says no". Sweep MUST keep & retry (never evict the
  // healthy resident socket), and `/exchange` MUST answer 503 (never a definitive 401 refusal).
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const ex = await agentExchange(actor, files.actorToken, owner);
    assert.equal(ex.status, 200);
    const name = userInboxConnId(owner, actor);
    const witness = await dial(ex.body.token!, name);
    const observed = (await read(false)).find((seat) => seat.name === name);
    assert(observed);
    try {
      chmodSync(path, 0);
      try {
        const faultEx = await agentExchange(actor, files.actorToken, owner);
        assert.equal(faultEx.status, 503, `transient row-read fault at /exchange must return 503, got ${faultEx.status}: ${JSON.stringify(faultEx.body)}`);
        await wait(2500);
        assert((await read(false)).some(({ cid }) => cid === observed.cid), "transient row-read fault must NOT evict the healthy resident socket");
      } finally { chmodSync(path, 0o600); }
    } finally { await witness.close(); }
    console.log("transient row-read fault (EACCES) kept resident socket open across sweep and returned 503 at /exchange");
  }
  // Leader-read transient / unknown errors (`503` JetStreamApiError, `no-responders` RequestError,
  // and an unknown `Error`) on the connect reader MUST keep & retry and never call evict on a
  // healthy seat's live broker socket.
  {
    const ex = await agentExchange(actor, files.actorToken, owner);
    assert.equal(ex.status, 200);
    const name = userInboxConnId(owner, actor);
    const witness = await dial(ex.body.token!, name);
    const observed = (await read(false)).find((seat) => seat.name === name);
    assert(observed);
    try {
      const jsm = await jetstreamManager(nc);
      const readerErrors: Error[] = [
        new JetStreamApiError({ code: 503, err_code: 10077 as never, description: "meta leader unavailable" }),
        new RequestError("$JS.API.STREAM.MSG.GET.KV_ep", { cause: new NoRespondersError("$JS.API.STREAM.MSG.GET.KV_ep") }),
        new Error("unexpected synthetic reader failure"),
      ];
      for (const readerErr of readerErrors) {
        let evictCalls = 0;
        let readerCalls = 0;
        const sweepLogs: string[] = [];
        const stopSweep = startManagedConnectionSweep({
          space: SPACE,
          secret: signingSeed,
          dir,
          kv: authKv,
          jsm,
          reader: () => { readerCalls++; throw readerErr; },
          releaseWindowMs: 5_000,
          canSweep: () => true,
          evict: async (principal) => {
            evictCalls++;
            return { principal, kicked: 1, remaining: 0, scanComplete: true, verifiedGone: true };
          },
          log: (line) => sweepLogs.push(line),
        });
        try {
          await untilObserved(4_000, async () => readerCalls > 0 ? true : undefined);
          await wait(300);
          assert.equal(evictCalls, 0, `reader error ${readerErr.name} (${readerErr.message}) must never evict a healthy seat`);
          assert((await read(false)).some(({ cid }) => cid === observed.cid), `healthy seat must stay connected across ${readerErr.name}`);
          assert(sweepLogs.some((l) => l.includes("managed connection authority could not be checked")), `sweep must log retryable check failure for ${readerErr.name}`);
        } finally { await stopSweep(); }
      }
    } finally { await witness.close(); }
    console.log("reader 503 JetStreamApiError, no-responders RequestError, and unknown Error kept healthy seat connected with 0 evictions");
  }
  await damage("linked managed row space", async () => {
    const target = `${dirPath}.fixture`;
    renameSync(dirPath, target);
    symlinkSync(target, dirPath);
    return () => { rmSync(dirPath); renameSync(target, dirPath); };
  });
  await damage("credential deletion marker", async (id) => {
    const key = credRowKey(lifecycleUid, id);
    const entry = await authKv.get(key);
    assert(entry);
    await authKv.delete(key);
    return () => authKv.put(key, entry.value);
  });
  await damage("malformed native UID custody", async () => {
    await recordsKv.put(reservationKey, "{}");
    return () => recordsKv.put(reservationKey, reservation.value);
  });
  const collision = async (family: "actors" | "chat-sessions") => {
    const rowDir = join(dir, family);
    mkdirSync(rowDir, { recursive: true, mode: 0o700 });
    const duplicate = join(rowDir, filename);
    const row = JSON.parse(raw);
    delete row.tokenHash;
    delete row.custody;
    writeFileSync(duplicate, JSON.stringify(row), { mode: 0o600 });
    return () => rmSync(duplicate);
  };
  await damage("alias in both grant spaces", () => collision("actors"));
  await damage("alias in grant and chat spaces", () => collision("chat-sessions"));
}

async function durableCheckpoint(owner: string, nc: SmokeConnection) {
  const { lifecycleUid } = JSON.parse(readFileSync(managedRowPath(owner), "utf8")) as { lifecycleUid: string };
  const jsm = await jetstreamManager(nc);
  const info = () => jsm.consumers.info(dmStream(SPACE), dmDurable(owner, AGENT, lifecycleUid));
  const send = async (id: string) => {
    const ack = await jetstream(nc).publish(unicastSubject(SPACE, owner, AGENT, owner, "cli"), JSON.stringify({
      id, ts: Date.now(), space: SPACE, from: { id: `${owner}.cli`, name: "cli", owner, actor: "cli", kind: "agent" },
      to: `${owner}.${AGENT}`, parts: [{ kind: "text", text: id }],
    }));
    const file = join(root, "renewal-request.dm");
    assert(await untilObserved(8000, async () => {
      const row = await info();
      return existsSync(file) && row.ack_floor.stream_seq >= ack.seq ? true : undefined;
    }), `durable pull must deliver and acknowledge ${id}`);
    return ack.seq;
  };
  return { info, send };
}

async function verifyHalfLifeRenewal(owner: string, original: BrokerSeat[], read: (closed: boolean) => Promise<BrokerSeat[]>, nc: import("@nats-io/transport-node").NatsConnection): Promise<void> {
  const first = original[0]!, started = Date.parse(first.start), midpoint = started + connectionSec * 500;
  const durable = await durableCheckpoint(owner, nc);
  const originalSeq = await durable.send("before-renewal");
  const originalConsumer = await durable.info();
  const subject = livenessSubject(SPACE, "delivery", owner, AGENT);
  const f = join(root, "renewal-request");
  await wait(Math.max(0, midpoint - Date.now() - 2500));
  const sub = nc.subscribe(subject, { max: 1, timeout: 5000 });
  await nc.flush();
  writeFileSync(`${f}.go`, subject);
  const msg = (await sub[Symbol.asyncIterator]().next()).value;
  assert(msg?.reply, "the managed seat must send the live request before renewal");
  const jitterCeiling = Math.ceil(connectionSec * 550);
  await wait(Math.max(0, started + jitterCeiling - Date.now() + 800));
  assert((await read(false)).some(({ cid }) => cid === first.cid), "renewal must wait for the in-flight request");
  msg.respond(new TextEncoder().encode("renewal-request-completed"));
  assert.equal(await untilObserved(5_000, async () => existsSync(`${f}.result`) ? readFileSync(`${f}.result`, "utf8") : undefined), "renewal-request-completed");
  const renewed = await untilObserved(8_000, async () => (await read(false)).find(({ cid, name }) => cid !== first.cid && name === first.name));
  assert(renewed, "half-life renewal must replace the resident broker connection");
  const elapsed = Date.parse(renewed.start) - started;
  assert(elapsed >= connectionSec * 500 - 2000 && elapsed <= jitterCeiling + 10000, `renewal must replace inside half-life jitter window, observed ${elapsed}ms`);
  console.log(`renewed original seat after ${elapsed} ms, with its in-flight request completed`);
  const after = await durable.info();
  assert.equal(after.created, originalConsumer.created);
  assert.equal(after.ack_floor.stream_seq, originalSeq);
  assert((await durable.send("after-renewal")) > originalSeq);
  const deliveries = readFileSync(`${f}.dm`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(deliveries, [{ id: "before-renewal", durable: true }, { id: "after-renewal", durable: true }]);
  console.log("durable DM pull retained its consumer and ack floor across the reconnect");
}

async function verifyManagedConnections(mode: string, owner: string, auth: Awaited<ReturnType<typeof createSpaceAuth>>, nc: import("@nats-io/transport-node").NatsConnection): Promise<void> {
  const other = "unrevoked";
  writeFileSync(join(root, ".cotal", "agents", `${other}.md`), `---\nname: ${other}\nrole: worker\nsubscribe: [general]\nallowPublish: [general]\n---\nControl seat.\n`);
  const reply = await manager!.startAgent({ name: other, agent: "e2e", owner, events: false });
  assert(reply.ok, reply.error);
  const observer = await connect({ servers: SERVER, maxReconnectAttempts: 0, inboxPrefix: MEMBERSHIP_INBOX_PREFIX,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintMembershipObserverCreds(auth, newIdentity()))) });
  try {
    const read = async (closed: boolean): Promise<BrokerSeat[]> => {
      const reply = await observer.request(connzRequestSubject(auth.account.pub), JSON.stringify({ auth: true, limit: 1024, state: closed ? 1 : 0 }), { timeout: 3000 });
      return reply.json<{ data: { connections?: BrokerSeat[] } }>().data.connections ?? [];
    };
    if (mode === "damage") {
      await verifyDamagedAuthority(owner, auth.account.signingSeed, read, nc);
      return;
    }
    const names = [AGENT, other].map((actor) => principalKey(owner, actor).name);
    const pair = () => untilObserved(20_000, async () => {
      const seats = await read(false);
      const pair = names.map((name) => seats.find(({ authorized_user }) => authorized_user === name));
      if (pair[0] && pair[1]) return [pair[0], pair[1]];
    });
    const original = await pair();
    assert(original, "both managed seats must be present on the broker before the probe");
    for (const { authorized_user, cid, start } of original) console.log(`online ${authorized_user} cid=${cid} start=${start}`);
    if (mode === "short") await verifyAuthorityOutage(original, read);
    else if (mode === "continuity") {
      await verifyHalfLifeRenewal(owner, original, read, nc);
      const renewed = await untilObserved(12_000, async () => {
        const current = await read(false);
        const seats = original.map((seat) => current.find(({ cid, name }) => name === seat.name && cid !== seat.cid));
        if (seats[0] && seats[1]) return [seats[0], seats[1]];
      });
      assert(renewed, "both seats must have renewed before the outage");
      await verifyAuthorityOutage(renewed, read);
    } else await verifyManagedRevoke(owner, original[0]!, original[1]!, read, nc);
  } finally {
    await observer.close();
  }
}

let manager: InstanceType<typeof Manager> | undefined;
const evictionWarnings: string[] = [];
let broker: ChildProcess | undefined;
let authChild: ChildProcess | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let jsDir: string | undefined;
scenario: try {
  // ---------- A. setup: user-auth broker + streams + auth service + login + grant ----------
  console.log("A) user-auth broker + auth service + device login");
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(root), auth);

  // The real Better Auth IdP (device-code, auto-approved) — up first, prepareServer pins its url.
  let handler: ReturnType<typeof toNodeHandler> | undefined;
  const idpSrv = createServer((req, res) => handler!(req, res));
  await new Promise<void>((r) => idpSrv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(idpSrv.address() as AddressInfo).port}`;
  const base = `${origin}/api/auth`;
  const ba = betterAuth({
    baseURL: origin,
    secret: "smoke-only-better-auth-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === CLIENT_ID }),
      baBearer(),
    ],
  });
  handler = toNodeHandler(ba);
  const signup = await ba.api.signUpEmail({
    body: { email: "human@example.test", password: "correct-horse-battery", name: "Human 42" },
    returnHeaders: true,
  });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0];
  const approve = (userCode: string) => approveDevice({ base, cookie, origin }, userCode);

  const prepared = await cotalAuthProvider.prepareServer({
    store,
    space: SPACE,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    dir,
    idpUrl: base,
  });
  jsDir = mkdtempSync(join(tmpdir(), "cotal-fsb-js-"));
  writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }));
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  teardownOnSignal(broker);
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(200); }
  check("user-auth broker is reachable", up);
  const provId = newIdentity();
  const provCreds = await mintCreds(auth, provId, "provisioner");
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: provCreds });
  // The endpoint lifecycle-data streams (EPF/EPW/EPE/records): production space setup creates them,
  // and the retirement barrier's FRONTIER step reads their last_seq to close the lifecycle interval.
  {
    // The endpoint lifecycle-data streams are created by the space's setup authority (broader than
    // the scoped provisioner); a harness god cred (account-signed, allow-all) stands in for it.
    const setupId = newIdentity();
    const setupCreds = fmtCreds(
      await encodeUser("fsb-setup", fromPublic(setupId.id), fromPublic(auth.account.pub), { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) }),
      fromSeed(new TextEncoder().encode(setupId.seed)),
    );
    const snc = await connect({ servers: SERVER, authenticator: credsAuthenticator(setupCreds), maxReconnectAttempts: 0 });
    try { await createEndpointStreams(await jetstreamManager(snc), new Kvm(snc), SPACE); }
    finally { await snc.drain().catch(() => {}); }
  }

  // The DELIVERY DAEMON (the eviction rail the retirement barrier needs): production `cotal up`
  // runs auth AND delivery, and a terminal retirement's VERIFIED eviction rides the delivery-admin
  // rail. This harness boots the shared fixture daemon, which serves both eviction verbs through core's
  // real executors (its $SYS observer + KICK evictor minted from the space auth here, the only window
  // their in-memory seed exists) and holds and renews the delivery lease, so despawn -> retirement can
  // reach its terminal exactly as it does under a full stack. Without it the barrier fail-closes at
  // eviction and the alias stays reserved (the pre-delivery composition, proven earlier).
  delivery = await bootDeliveryDaemon({ space: SPACE, servers: SERVER, auth, reloadStoreIdentity: store.identity });
  recordMesh({ space: SPACE, server: SERVER, root, mode: "user", userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  const actor = AGENT;
  writeFileSync(join(root, ".cotal", "agents", `${actor}.md`), `---\nname: ${actor}\nrole: worker\nsubscribe: [general]\nallowPublish: [general]\n---\n${actor} persona.\n`);

  authChild = spawnAuthService();
  await waitAuthReady();
  await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => approve(p.userCode),
  });
  const OWNER = await cotalAuthProvider.ownerForLogin({ store, dir, space: SPACE });
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "role:worker"], allowSubscribe: ["general"], allowPublish: ["general"], label: "smoke operator" });

  // Broker-footprint inspectors. The checks ENUMERATE by principal PREFIX rather than binding one
  // exact resource name. The lifecycle-keyed rename has LANDED on this tree, so the names they
  // match already carry the uid (`dm_<owner>-<actor>-<lifecycleUid>`, built by `lifecycleNameKey`
  // in `subjects.ts`, SPEC 13.1); the prefix form is what let these asserts survive that rename
  // without being edited, and it is what keeps them standing through the next one.
  // Enumeration (`$JS.API.CONSUMER.LIST`) is deliberately grantable by NO
  // production profile, so the inspector rides a HARNESS-ONLY god cred signed with the account
  // key the smoke already owns — observability of the harness, never a surface of the code under test.
  const principal = principalKey(OWNER, AGENT);
  const inspCreds = await (async () => {
    const inspId = newIdentity();
    const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
    const userJwt = await encodeUser("fsb-inspector", fromPublic(inspId.id), fromPublic(auth.account.pub),
      { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer });
    return fmtCreds(userJwt, fromSeed(new TextEncoder().encode(inspId.seed)));
  })();
  const inspect = async <T,>(fn: (jsm: Awaited<ReturnType<typeof jetstreamManager>>, nc: import("@nats-io/transport-node").NatsConnection) => Promise<T>): Promise<T> => {
    const nc = await connect({ servers: SERVER, authenticator: credsAuthenticator(inspCreds), maxReconnectAttempts: 0 });
    try { return await fn(await jetstreamManager(nc), nc); } finally { await nc.drain().catch(() => {}); }
  };
  const consumersFor = (stream: string, prefix: string) =>
    inspect(async (jsm) => {
      const names: string[] = [];
      for await (const ci of jsm.consumers.list(stream)) if (ci.name.startsWith(prefix)) names.push(ci.name);
      return names;
    });
  const aclRowsFor = (prefix: string) =>
    inspect(async (_j, nc) => {
      const kv = await openAclRegistry(nc, SPACE);
      const keys: string[] = [];
      for await (const k of await kv.keys()) if (k.startsWith(prefix)) keys.push(k);
      return keys;
    });
  const footprint = async () => ({
    row: existsSync(managedRowPath(OWNER)),
    dm: await consumersFor(dmStream(SPACE), `dm_${principal.name}`),
    dlv: await consumersFor(dlvStream(SPACE), `dlv_${principal.name}`),
    acl: await aclRowsFor(principal.key),
  });

  // ---------- B. first spawn: the predecessor, with its full footprint ----------
  console.log("B) user-mode spawn of the predecessor");
  manager = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  if (connectionCase === "damage") {
    await inspect(async (_jsm, nc) => verifyManagedConnections(connectionCase, OWNER, auth, nc));
    break scenario;
  }
  const r1: ControlReply = await manager.startAgent({ name: actor, agent: "e2e", owner: OWNER, events: false });
  if (connectionCase !== "retirement") {
    assert(r1.ok, r1.error);
    await inspect(async (_jsm, nc) => verifyManagedConnections(connectionCase, OWNER, auth, nc));
    break scenario;
  }
  check("predecessor spawn ok", r1.ok === true, r1);
  const fp1 = await footprint();
  check("predecessor footprint exists (row + dm + dlv + acl)",
    fp1.row && fp1.dm.length > 0 && fp1.dlv.length > 0 && fp1.acl.length > 0, fp1);

  // ================================================================================================
  // INT-2 — SWALLOWED revokeAgent: a failed user-mode ledger revoke must NOT free the name.
  // ================================================================================================
  const mAny = manager as unknown as {
    opStop: (a: Record<string, unknown>, c: string, admin: boolean) => Promise<ControlReply>;
    ep: { ref: () => { id: string } };
    retirement: {
      deprovision: (a: { id: string; name: string; lifecycleUid: string; userOwner?: string }) => Promise<void>;
      retiring: Map<string, { target: { id: string; lifecycleUid: string; userOwner?: string }; standingAuthorityLive?: boolean; lastError?: string }>;
    };
  };
  const listNames = (): string[] => psList(manager!).map((a) => a.name);

  // Capture the manager's despawn/terminal logs (console.error) so we can read the RED vs GREEN
  // terminal face directly ("name stays held" = GREEN; "free for reuse" = RED/pristine).
  const logs: string[] = [];
  const origErr = console.error.bind(console);
  console.error = ((...a: unknown[]) => { logs.push(a.map(String).join(" ")); origErr(...a); }) as typeof console.error;
  const waitLog = async (re: RegExp, ms: number): Promise<string | undefined> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const hit = logs.find((l) => re.test(l)); if (hit) return hit; await wait(100); }
    return logs.find((l) => re.test(l));
  };

  // ---------- C. inject a revokeAgent FAILURE, then despawn ----------
  console.log("C) capture the actor token; make the ledger revoke FAIL; despawn");
  // A copied actor token: while the standing-mint-authority row lives, it exchanges->mints a bearer.
  // The actor token is filed lifecycle-keyed (`<name>.<uid>.actor-token`); recover the predecessor's
  // uid from disk to read it.
  const predUid = (() => {
    const re = new RegExp(`^${AGENT}\\.([a-z0-9]{26,32})\\.actor-token$`);
    for (const f of readdirSync(credsDir)) { const m = re.exec(f); if (m) return m[1]; }
    throw new Error(`no incarnation actor-token on disk for ${AGENT} in ${credsDir}`);
  })();
  const predActorToken = readFileSync(agentLifecycleSecretFilePaths(root, SPACE, AGENT, predUid).actorToken, "utf8").trim();
  check("predecessor actor token captured (models a copied token)", predActorToken.length > 0);
  const exBefore = await agentExchange(AGENT, predActorToken, OWNER);
  check("baseline: the captured actor token exchanges->mints a bearer while the agent is live (200)",
    exBefore.status === 200 && typeof exBefore.body.token === "string", { status: exBefore.status, error: exBefore.body.error });

  // THE FAULT: revokeAgent -> revokeManagedActor -> rmSync(rowPath). A read-only managed-actors dir
  // makes that unlink EACCES, so revokeAgent THROWS and the standing-authority row is NOT deleted.
  const ledgerRowDir = managedActorLedgerDir(dir);
  chmodSync(ledgerRowDir, 0o500);
  check("fault armed: managed-actor ledger dir is read-only (revokeAgent's rmSync will throw EACCES)",
    existsSync(managedRowPath(OWNER)));

  const stopReply = await mAny.opStop({ name: AGENT, graceful: false }, mAny.ep.ref().id, true);
  check("despawn reply ok", stopReply.ok === true, stopReply);

  // Wait for the detached deprovision: revoke (throws) -> standingAuthorityLive stays true -> rail
  // retirement completes -> the terminal log tells us HELD vs FREED.
  const terminal = await waitLog(/not yet revoked|name stays held|free for reuse/i, 25000);
  console.log(`   manager terminal face: ${terminal ?? "(none within 25s)"}`);

  // GREEN 1: the standing-authority row SURVIVED the failed revoke.
  check("GREEN: the standing-mint-authority ledger row SURVIVED the failed revoke (still live)",
    existsSync(managedRowPath(OWNER)));
  // GREEN 2: the manager HELD the name (terminal face is 'stays held', NOT 'free for reuse').
  const heldFace = terminal !== undefined && /not yet revoked|name stays held/i.test(terminal);
  const freedFace = terminal !== undefined && /free for reuse/i.test(terminal);
  check("GREEN: after the rail retirement, the manager HELD the name (NOT 'free for reuse' = the RED/pristine face)",
    heldFace && !freedFace, { terminal });
  // GREEN 3: the hold carries standingAuthorityLive + the revoke-failure operator copy.
  const hold = mAny.retirement.retiring.get(AGENT);
  check("GREEN: the retiring hold keeps standingAuthorityLive=true with the revoke-failure operator copy",
    hold?.standingAuthorityLive === true && /standing mint authority could not be revoked/i.test(hold?.lastError ?? ""),
    hold ? { standingAuthorityLive: hold.standingAuthorityLive, lastError: hold.lastError } : "(no hold)");

  // GREEN 4: a same-name respawn is REFUSED with the operator face (and re-drives the teardown). The
  // hold must be UNCHANGED (same lifecycleUid) and NO successor managed record may appear under the
  // alias — a refusal that quietly kept a replacement, or an ABA hold swap, would both read as ok here
  // without these checks.
  const heldUidBeforeRespawn = mAny.retirement.retiring.get(AGENT)?.target.lifecycleUid;
  const respawn = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER, events: false });
  check("GREEN: a same-name spawn is REFUSED while the mint authority stands (alias not reassigned)",
    respawn.ok === false, respawn);
  check("GREEN: no successor managed record took the alias (the manager lists no live agent under the held name)",
    !psList(manager).some((a) => a.name === AGENT), listNames());
  check("GREEN: the SAME hold is still in place after the refused respawn (unchanged lifecycleUid, no ABA swap)",
    mAny.retirement.retiring.get(AGENT)?.target.lifecycleUid === heldUidBeforeRespawn && heldUidBeforeRespawn !== undefined,
    { before: heldUidBeforeRespawn, after: mAny.retirement.retiring.get(AGENT)?.target.lifecycleUid });
  check("GREEN: the refusal reads as the operator face (reserved pending retirement + standing-authority revoke + retry NEXT)",
    /reserved pending retirement/i.test(respawn.error ?? "") && /standing-authority revoke/i.test(respawn.error ?? "") && /retry/i.test(respawn.error ?? ""),
    respawn.error);

  // THE STANDING AUTHORITY: after the failed revoke the ledger row is STILL LIVE (the residual the
  // hold narrows). FINDING: on the current tree the copied token's exchange is nonetheless REFUSED
  // — but by the DEEPER auth-plane truth (the rail retirement terminalized the issuance gate), NOT
  // by the ledger-row revoke. So the ledger-hold is a defense-in-depth BELT over the surviving row;
  // the mint is blocked by the retired gate. (The "copied token mints" RED only reproduces if the
  // RAIL retirement ALSO fails to retire the gate — a compounded fault, not the ledger-revoke-only case.)
  const exAfter = await agentExchange(AGENT, predActorToken, OWNER);
  check("the auth-plane gate (deeper truth) REFUSES the copied token's exchange (terminally retired issuance gate)",
    exAfter.status !== 200 && /terminally retired issuance gate|retired/i.test(exAfter.body.error ?? ""), { status: exAfter.status, error: exAfter.body.error });
  check("…and the standing-mint-authority ledger row is STILL LIVE (the residual the INT-2 hold narrows)",
    existsSync(managedRowPath(OWNER)));

  // ---------- D. clear the fault; the PUBLIC same-name-spawn nudge re-drives the revoke and frees ----------
  console.log("D) clear the fault; the DOCUMENTED same-name spawn nudge re-drives the teardown; the revoke succeeds and the name frees");
  chmodSync(ledgerRowDir, 0o700); // clear the fault: the revoke's rmSync can now succeed
  logs.length = 0;
  // The DOCUMENTED operator recovery path (NOT a private call): a same-name `cotal spawn` re-drives the
  // FULL teardown (deprovision -> revoke, now succeeding). It is REFUSED while the hold stands, but its
  // nudge clears the hold once the revoke lands. LATCH on the observable outcome (row deleted + hold
  // cleared), re-nudging via the public spawn each round, instead of a fixed sleep: the first rounds may
  // JOIN the stale in-flight teardown (revoke still failing under the just-cleared fault); once that
  // settles a FRESH nudge re-drives and succeeds. Deterministic, no magic wait.
  // Latch on the HOLD clearing — the reliable "predecessor teardown completed" signal. (The row path
  // is name-keyed, so a successor that takes the freed alias immediately re-mints a row at the same
  // path; row-absence is therefore NOT a stable signal — the predecessor's revoke is proven by the
  // hold clearing + the free-for-reuse log + the predecessor uid leaving the row, asserted below.)
  let nudges = 0;
  const cleared = await (async (ms = 25000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await manager!.startAgent({ name: AGENT, agent: "e2e", owner: OWNER, events: false }); // public nudge (refused while held)
      nudges++;
      if (mAny.retirement.retiring.get(AGENT) === undefined) return true;
      await wait(500);
    }
    return mAny.retirement.retiring.get(AGENT) === undefined;
  })();
  check("GREEN: the public same-name-spawn nudge re-drove the revoke and CLEARED the hold (the alias is reusable)",
    cleared && mAny.retirement.retiring.get(AGENT) === undefined, { nudges });
  // The PREDECESSOR's standing-authority row was revoked: its uid no longer backs the alias (the row is
  // either absent, or already replaced by a successor's FRESH uid — the predecessor's is gone either way).
  const rowAfter = existsSync(managedRowPath(OWNER)) ? readFileSync(managedRowPath(OWNER), "utf8") : "";
  check("GREEN: the predecessor's standing-authority row was REVOKED (its uid no longer backs the alias)",
    heldUidBeforeRespawn !== undefined && !rowAfter.includes(heldUidBeforeRespawn), { rowPresent: rowAfter.length > 0, predUid: heldUidBeforeRespawn });
  check("GREEN: the manager logged the name FREE after the successful re-driven revoke ('free for reuse')",
    logs.some((l) => /free for reuse/i.test(l)), logs.slice(-4));
  // And the alias is genuinely reusable now: a same-name spawn takes the EXACT alias. A recovery-loop
  // nudge may already have spawned `worker` once the hold cleared; if not, do it here. Assert the EXACT
  // alias is live -- a suffixed sibling (worker-2) or an unrelated failure would BOTH leave the exact
  // alias absent from the roster, so this rejects both.
  // The reservation stage is legitimate and retried: only while the reply is the "reserved
  // pending retirement" refusal, bounded at 10s, with a 250ms wait between tries. The manager
  // ignores the retired lifecycle's own presence row when allocating a name, so the presence
  // window is no longer a stage here: the first reply that is not that refusal is graded once,
  // with no further spawn. A recovery-loop nudge above may already have landed the exact alias
  // once the hold cleared (the fixed manager gives it the exact alias, not a numbered stand-in);
  // if so, this block does not spawn again. A numbered stand-in (a suffix, or a refusal) fails
  // the checks below, and the added names plus the reply land in the payload so it shows up by
  // name.
  const aliasDeadline = Date.now() + 10_000;
  let before = listNames();
  let rSpawn: ControlReply | undefined;
  if (!psList(manager!).some((a) => a.name === AGENT)) {
    for (;;) {
      before = listNames();
      rSpawn = await manager!.startAgent({ name: AGENT, agent: "e2e", owner: OWNER, events: false });
      if (rSpawn.ok === false && /reserved pending retirement/i.test(rSpawn.error ?? "") && Date.now() < aliasDeadline) {
        await wait(250);
        continue;
      }
      break;
    }
  }
  const added = listNames().filter((n) => !before.includes(n));
  check("GREEN: a same-name spawn takes the EXACT alias after recovery (no suffix, no lingering reservation)",
    (rSpawn === undefined || rSpawn.ok === true) && added.every((n) => n === AGENT) && psList(manager!).some((a) => a.name === AGENT),
    { added, reply: rSpawn, live: listNames() });

  // Negative control: with AGENT now live, a second same-name spawn must number to a suffix and
  // leave the live seat untouched.
  const before2 = listNames();
  const rSpawn2 = await manager!.startAgent({ name: AGENT, agent: "e2e", owner: OWNER, events: false });
  const added2 = listNames().filter((n) => !before2.includes(n));
  check("GREEN: a second same-name spawn while the alias is live numbers to a suffix and leaves the live seat alone",
    psList(manager!).some((a) => a.name === AGENT) && !added2.includes(AGENT) && added2.every((n) => n === `${AGENT}_2`),
    { added: added2, reply: rSpawn2 });
  for (const stray of added2) await mAny.opStop({ name: stray, graceful: false }, mAny.ep.ref().id, true);

  console.error = origErr;
  console.log(`\nINT-2 SWALLOWED-REVOKE ${failed() === 0 ? "GREEN ✅ (fix present: failed revoke holds the name; retry re-drives)" : "RED ❌"}  (${passed()} passed, ${failed()} failed)`);
  finish();
} catch (e) {
  console.error("  ✗ scenario threw:", e);
  process.exitCode = 1;
} finally {
  // `chmodSync` used to be pulled in by a block-scoped import several hundred lines above, so this
  // line threw ReferenceError into its own `catch` on every run: the ledger dir stayed at the 0o500
  // the fault arms above, and the `rmSync` below could not clear it. Imported at the top now, with
  // the same best-effort intent.
  try { chmodSync(managedActorLedgerDir(dir), 0o700); } catch { /* best-effort restore before rm */ }
  try { await manager?.stop({ withAgents: true }); } catch { /* already stopped */ }
  try { await delivery?.stop(); } catch { /* already stopped */ }
  if (authChild?.pid) { try { process.kill(authChild.pid, "SIGKILL"); } catch { /* gone */ } }
  if (broker?.pid) { try { process.kill(broker.pid, "SIGKILL"); } catch { /* gone */ } }
  await wait(300);
  for (const d of [home, root, jsDir]) if (d) rmSync(d, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
