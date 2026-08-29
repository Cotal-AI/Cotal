/**
 * U3 GATE — live eviction proven per space from a STORE-INJECTED composition
 * (`docs/design/u3-membership-sys-injection.md` §6).
 *
 * The claim under test is not "the code compiles with a store": it is that the `$SYS` pair — the
 * CONNZ observer and the KICK evictor — can come from an injected {@link SecretStore} with **no
 * `.cotal/` `$SYS` file and no `membership.json` anywhere on disk**, and that every safety property
 * the on-disk path had survives the move. So this boots a REAL broker carrying TWO TENANTS, runs the
 * REAL `runDelivery` for tenant A against an in-memory store, and drives eviction over the REAL
 * delivery-admin rail. A regression to `readFileSync` cannot pass here by accident: there is nothing
 * on disk to read.
 *
 * Two tenants, because the failure this design must not introduce is a CROSS-TENANT one: a complete,
 * well-formed sweep of the WRONG account is indistinguishable from "the principal is gone", so a
 * store that hands back a foreign tenant's observer must refuse rather than answer confidently
 * (cells 3 and 2). Both tenants carry a live connection under the SAME principal string, so a leak
 * would be visible as a kill, not merely as a wrong log line.
 *
 * THE CELLS (§6):
 *   0  precondition   the cwd is mkdtemp-pinned and the harness can tell the two roots apart (F1)
 *   1  evict a live callout-minted principal in A          → verifiedGone, scanComplete, conn dropped
 *   2  B's live principal, same principal string           → untouched, during and after
 *   3  hand A's daemon B's OBSERVER                        → refuses naming both accounts
 *   4  `delete` the evictor key, then evict                → refuses; the victim is still live
 *   5  `delete` the observer key, then start the feed      → {down} naming the key; Plane-3 still serves
 *   6  evict a principal that is not connected             → idempotent no-op (kicked:0, verifiedGone)
 *   7  observer + evictor from DIFFERENT system accounts   → torn-rotation refusal, BOTH paths
 *   8  no `$SYS` files and no `membership.json` on disk    → asserted before and after cells 1-2
 *
 * POSITIVE CONTROLS (F4's discipline). Cells 3, 4, 5 and 7 each assert a REFUSAL, and a refusal is
 * also what a broken harness produces. Every one of them therefore restores the correct material and
 * repeats the SAME operation in the SAME process, which must then succeed. A cell that cannot state
 * its positive control does not ship.
 *
 * THE CWD IS MKDTEMP-PINNED (F1). `findCotalRoot()` walks UPWARD from `process.cwd()`, so a run from
 * inside this repo resolves the repository's own `.cotal/` — the one directory on the box guaranteed
 * to hold exactly the files cells 5 and 8 exist to prove absent. Each tenant gets its own `mkdtemp()`
 * root with an EMPTY `.cotal/` to stop the walk, and cell 0 asserts the walk actually landed there
 * before anything else runs.
 *
 * THE SERVER IS NAMED AND FLOOR-CHECKED, NOT SILENTLY SAMPLED. F4 measured the `$SYS` behaviour this
 * design rests on against nats-server 2.14.5; it has since been measured 37/37 at 2.12.12 as well, so
 * the property spans the supported band rather than being 2.14-only. The gate therefore refuses only
 * BELOW `BROKER_FLOOR` — the product's own constant, not a literal copied here, so this suite and the
 * control surface's startup gate cannot drift apart about what is supported. Whatever server is used,
 * the resolved ABSOLUTE path and measured version are PRINTED first and repeated on the final line: a
 * green always names what it tested. `COTAL_SMOKE_NATS_SERVER` picks the binary; with it unset one is
 * resolved from `PATH` (CI sets neither, and a suite CI cannot run proves nothing).
 * `COTAL_SMOKE_NATS_VERSION` still pins an EXACT version, for reproducing one named measurement.
 *
 * COTAL_HOME-free; kills only the nats-server it starts, by exact PID (never pkill).
 * Run: npx tsx implementations/delivery/smoke/sys-injection-evict.smoke.ts
 *   or COTAL_SMOKE_NATS_SERVER=/abs/path/to/nats-server-2.14.5 npx tsx …
 */
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds, newIdentity,
  mintConnectionEvictorCreds, mintMembershipObserverCreds, principalKey, rotateSystemAccount,
  serverConfig, setupSpaceStreams, waitForDeliveryLease, BROKER_FLOOR, CotalEndpoint, DEV_OWNER,
  meetsBrokerFloor, type ParsedArgs, type SecretStore, type SpaceAuth,
} from "@cotal-ai/core";
import {
  calloutPermissions, createCalloutAuth, createUserTokenIssuer, deriveOwnerToken, generateSigningKey,
  grantActor, ledgerAclResolver, ledgerAuthorizeConnect, revokeActor, startAuthCallout,
} from "@cotal-ai/auth";
import {
  connectionEvictorCredsKey, CONNECTION_EVICTOR_CREDS_KIND, deliveryCredsKey, findCotalRoot,
  membershipObserverCredsKey, MEMBERSHIP_OBSERVER_CREDS_KIND, membershipRwCredsKey, spaceMaterialDir,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { runDelivery } from "../src/delivery.js";
import { startMembership } from "../src/membership.js";
import { pickFreePort } from "./_free-port.js";

const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000, step = 100): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(step);
  return cond();
};
// `runDelivery` runs IN THIS PROCESS, so the daemon's own console output is EVIDENCE, not noise: its
// fail-soft lines are what cells 5 and 7 read. The tee is installed once, before the daemon boots,
// and stays installed to the `finally` — restoring it between cells would silently drop whatever the
// daemon said next, and the daemon talks asynchronously. So the harness prints through `realLog`
// (straight out, unprefixed) while everything the daemon logs is captured AND echoed with a `│`.
const realLog = console.log.bind(console), realErr = console.error.bind(console);
let daemonLog = "";
const teeConsole = () => {
  const t = (...a: unknown[]) => { const s = a.map(String).join(" "); daemonLog += `${s}\n`; realLog(`    │ ${s}`); };
  console.log = t; console.error = t;
};
const untee = () => { console.log = realLog; console.error = realErr; };

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; realLog(`  ✓ ${name}`); }
  else { fail++; realLog(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

// ---------- the server binary is NAMED and FLOOR-CHECKED, never silently sampled (F4 / §6) ----------
// `COTAL_SMOKE_NATS_SERVER` still wins when set. With it UNSET the binary is resolved from `PATH` and
// realpath'd rather than refused, because CI does not set that variable and a suite CI cannot run is a
// suite that proves nothing — the ungated-in-name-of-rigour trade this file briefly made.
const resolveOnPath = (bin: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return undefined;
};
const NATS_BIN_NAMED = process.env.COTAL_SMOKE_NATS_SERVER ?? resolveOnPath("nats-server");
if (!NATS_BIN_NAMED) {
  console.error(
    "✗ REFUSING: no nats-server to test against. Set COTAL_SMOKE_NATS_SERVER to an ABSOLUTE path, or " +
    "put a nats-server on PATH — this gate boots a real broker and cannot be proven without one.",
  );
  process.exit(2);
}
// RESOLVED AND PRINTED BEFORE ANY CHECK. The anti-sampling discipline was never the exact-match
// refusal; it is that a green NAMES the binary and version it actually tested, so a passing line can
// always be audited against the server someone thinks it ran on.
const NATS_BIN = realpathSync(NATS_BIN_NAMED);
const NATS_VERSION = execFileSync(NATS_BIN, ["--version"], { encoding: "utf8" }).trim();
console.log(`  · server under test: ${NATS_BIN} → ${NATS_VERSION}`);

// THE FLOOR COMES FROM THE PRODUCT, NEVER A LITERAL HERE. `BROKER_FLOOR` is the same constant the
// control surface's own startup gate refuses below, so the suite and the daemon cannot drift into
// disagreeing about what is supported — a copied number is the copy that goes stale. Measured 37/37 at
// both 2.12.12 (what CI installs) and 2.14.5 (what F4 measured), so this property spans the floor band
// rather than being a 2.14-only behaviour.
//
// `COTAL_SMOKE_NATS_VERSION` keeps its documented meaning — an EXACT pin — for reproducing one named
// measurement. Unset, the check is the floor, which is what lets CI run all 37 cells on its own 2.12.x.
const WANT_EXACT = process.env.COTAL_SMOKE_NATS_VERSION;
const VERSION_NUMBER = /\d+\.\d+\.\d+\S*/.exec(NATS_VERSION)?.[0] ?? "";
if (WANT_EXACT) {
  if (!NATS_VERSION.includes(WANT_EXACT)) {
    console.error(
      `✗ REFUSING: COTAL_SMOKE_NATS_VERSION pins ${WANT_EXACT}, but this binary reports "${NATS_VERSION}".`,
    );
    process.exit(2);
  }
} else if (!meetsBrokerFloor(VERSION_NUMBER)) {
  // An unparseable version lands here too, and refuses: fail-closed, exactly like `requireBrokerFloor`.
  console.error(
    `✗ REFUSING: nats-server "${NATS_VERSION}" is below the product's own control-surface floor ` +
    `${BROKER_FLOOR.major}.${BROKER_FLOOR.minor} (packages/core/src/broker-floor.ts). The daemon under test ` +
    `refuses to start there, so a result from this server would describe a broker the product does not support.`,
  );
  process.exit(2);
}

// ---------- one broker, TWO tenant accounts ----------
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const spaceA = `u3gate-a-${randomUUID().slice(0, 8)}`;
const spaceB = `u3gate-b-${randomUUID().slice(0, 8)}`;
// THE HOSTED COMPOSITION's keys (P7). Every kind is per-space, and this store has no filesystem
// behind it, so the composition is `{ injected: true }`: the key is resolved and NOTHING is migrated
// (rule 2's move is filesystem-only). Putting under the bare kind instead would write the pre-P7
// flat key, which the daemon does not read — a suite that did so would stage a mesh that cannot boot
// and grade the failure as a behaviour red.
const hosted = { injected: true as const };
const DELIVERY_KEY_A = deliveryCredsKey(spaceA, hosted);
const MEMBERSHIP_RW_KEY_A = membershipRwCredsKey(spaceA, hosted);
const OBSERVER_KEY_A = membershipObserverCredsKey(spaceA, hosted);
const EVICTOR_KEY_A = connectionEvictorCredsKey(spaceA, hosted);
const broker = await createBrokerAuth("u3gate");
const accA = await createSpaceAccountAuth(broker, spaceA);
const accB = await createSpaceAccountAuth(broker, spaceB);
const authA: SpaceAuth = composeSpaceAuth(broker, accA);
const authB: SpaceAuth = composeSpaceAuth(broker, accB);

// The $SYS pair for each tenant, minted NOW: the system signing seed lives in memory only while the
// account is being provisioned, which is the whole reason these creds are `rotation-renewed` and the
// reason the store keys exist at all (injectable is not renewable).
const observerA = await mintMembershipObserverCreds(authA, newIdentity());
const evictorA = await mintConnectionEvictorCreds(authA, newIdentity());
const observerB = await mintMembershipObserverCreds(authB, newIdentity()); // cell 3's foreign observer
// Cell 7's TORN pair: an evictor signed by a DIFFERENT (rotated) system account, exactly what a crash
// between `rotateSystemCreds`' trust-record commit and its second cred write leaves behind.
const tornEvictorA = await mintConnectionEvictorCreds(await rotateSystemAccount(authA), newIdentity());

// Tenant A runs the real user-auth shape (callout-minted principal), per cell 1.
const callout = await createCalloutAuth({ space: spaceA, operatorSeed: broker.operator.seed, accountPub: accA.account.pub });

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(broker, [accA, accB], {
    transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
    extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
  }),
);
const srv = spawn(NATS_BIN, ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// ---------- the actor ledger + tenant A's user principal ----------
const SECRET = "s".repeat(32);
const ISS = "https://auth.cotal.test";
const ledgerDir = mkdtempSync(join(tmpdir(), "cotal-u3gate-ledger-"));
const ownerU = deriveOwnerToken(SECRET, "idp-subject-victim");
const victimRow = grantActor(ledgerDir, { owner: ownerU, actor: "victim", scope: [], allowSubscribe: ["general"], allowPublish: ["general"] });
const issuer = createUserTokenIssuer({ issuer: ISS, key: await generateSigningKey() });
const bearerP = await issuer.issue({ owner: ownerU, space: spaceA, actor: "victim", scope: [], lifecycleUid: victimRow.lifecycleUid, ttlSec: 600 });
const sharedPrincipal = principalKey(ownerU, "victim").key; // the SAME string in both tenants

// ---------- the two mkdtemp roots (F1) ----------
// An EMPTY `.cotal/` in each: it stops `findCotalRoot`'s upward walk at this root, and it is empty
// because the gate's whole point is that nothing here supplies a credential.
const rootA = realpathSync(mkdtempSync(join(tmpdir(), "cotal-u3gate-rootA-")));
const rootB = realpathSync(mkdtempSync(join(tmpdir(), "cotal-u3gate-rootB-")));
mkdirSync(join(rootA, ".cotal"), { recursive: true });
mkdirSync(join(rootB, ".cotal"), { recursive: true });
const startCwd = process.cwd();

/** The hosted seam, faithfully: async, and it is the ONLY place a credential comes from. Reads are
 *  counted so cell 8's "nothing on disk" is paired with a positive fact — the store WAS used. */
class MemoryStore implements SecretStore {
  readonly map = new Map<string, string>();
  reads = 0;
  async get(key: string): Promise<string | undefined> { this.reads++; return this.map.get(key); }
  async put(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}
const storeA = new MemoryStore();

const victims: NatsConnection[] = [];
/** A live connection carrying a principal, plus a flag that flips the moment the broker drops it. */
async function connectVictim(creds: string, id: string): Promise<{ nc: NatsConnection; closed: () => boolean }> {
  const nc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(enc(creds)),
    inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0, reconnect: false,
  });
  let closed = false;
  void nc.closed().then(() => { closed = true; }, () => { closed = true; });
  victims.push(nc);
  return { nc, closed: () => closed || nc.isClosed() };
}

let calloutNc: NatsConnection | undefined, ncP: NatsConnection | undefined, ncB: NatsConnection | undefined;
let sup: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server ${NATS_VERSION} did not come up on ${PORT}`);

  await setupSpaceStreams({ servers: SERVERS, space: spaceA, creds: await mintCreds(authA, newIdentity(), "provisioner") });

  // ---------- tenant A's auth callout (the real user-mode connect boundary) ----------
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  await wait(300);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: accA.account.pub, signingSeed: accA.account.signingSeed },
    space: spaceA,
    token: { key: issuer.localKeySet(), issuer: ISS },
    authorizeActor: ledgerAuthorizeConnect(ledgerDir),
    permissionsFor: calloutPermissions(ledgerAclResolver(ledgerDir)),
    log: () => {},
  });

  // ---------- CELL 0 (F1): the cwd is mkdtemp-pinned, and the harness can tell the roots apart ----------
  process.chdir(rootA);
  check("cell 0 (F1): findCotalRoot() resolves the tenant's own mkdtemp root, not this repository's",
    findCotalRoot() === rootA, { resolved: findCotalRoot(), rootA });
  // The precondition is itself a positive control: a harness that could NOT distinguish the roots
  // would make every "nothing on disk" assertion below vacuous.
  check("cell 0 (F1): the two roots are distinguishable (the walk is not collapsing them)",
    findCotalRoot(rootB) === rootB && rootA !== rootB, { a: findCotalRoot(rootA), b: findCotalRoot(rootB) });

  // ---------- CELL 8 (before): nothing on disk to read ----------
  const SYS_FILES = ["membership-observer.creds", "connection-evictor.creds", "membership.json", "delivery.creds", "membership-rw.creds"];
  // BOTH spellings are swept, because P7 moved where a workstation composition would write: a scan
  // of the flat names alone would report "nothing on disk" for a daemon that had just written the
  // whole set into `.cotal/space.<hex>/`, which is exactly the leak this cell exists to catch.
  const onDisk = () => [rootA, rootB].flatMap((r) =>
    [join(r, ".cotal"), spaceMaterialDir(r, spaceA), spaceMaterialDir(r, spaceB)].flatMap((d) =>
      SYS_FILES.filter((f) => existsSync(join(d, f))).map((f) => join(d, f))));
  check("cell 8 (before): no $SYS creds and no membership.json exist under either tenant root", onDisk().length === 0, onDisk());

  // ---------- boot delivery for A from the INJECTED store, and nothing else ----------
  await storeA.put(DELIVERY_KEY_A, await mintCreds(authA, newIdentity(), "delivery"));
  await storeA.put(MEMBERSHIP_RW_KEY_A, await mintCreds(authA, newIdentity(), "membership-rw"));
  await storeA.put(OBSERVER_KEY_A, observerA);
  await storeA.put(EVICTOR_KEY_A, evictorA);

  realLog("  · booting runDelivery(args, storeA) in-process (its output is teed below, prefixed │)");
  teeConsole();
  const args: ParsedArgs = { values: { space: spaceA, server: SERVERS }, positionals: [], raw: [] };
  void runDelivery(args, storeA); // never resolves by design — it runs until signalled
  const probe = newIdentity();
  const ready = await waitForDeliveryLease({ servers: SERVERS, space: spaceA, creds: await mintCreds(authA, probe, "delivery"), id: probe.id, holder: undefined });
  check("delivery boots for tenant A with EVERY credential from the injected store (lease READY)", ready, daemonLog.slice(-600));
  check("the store was actually read (the daemon did not silently find bytes elsewhere)", storeA.reads > 0, { reads: storeA.reads });
  // The feed is started off the boot path, so it lands a beat AFTER the lease — wait for the line
  // rather than sampling once at lease-ready, which races the daemon and proves nothing either way.
  check("the daemon's own membership feed came up from the injected store, with no $SYS file on disk",
    await until(() => daemonLog.includes("membership feed up"), 20_000), daemonLog.slice(-600));

  // The renewal owner's seat: a supervisor endpoint on the privileged delivery-admin rail, which is
  // how every eviction below is driven — the REAL request path, not a direct executor call.
  const supId = newIdentity();
  sup = new CotalEndpoint({
    space: spaceA, servers: SERVERS, creds: await mintCreds(authA, supId, "supervisor"),
    card: { id: supId.id, name: "u3-gate-admin", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  sup.on("error", () => {});
  await sup.start();
  const admin = async (op: string, a: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; data?: unknown }> => {
    let last: Error | undefined;
    for (let i = 0; i < 12; i++) {
      try { return await sup!.requestDeliveryAdmin(op, a, 15_000); } catch (e) { last = e as Error; await wait(500); }
    }
    throw last ?? new Error("admin: no attempts ran");
  };
  const evict = async (principal: string) => {
    const r = await admin("evictPrincipal", { principal });
    return { ...r, ev: (r.ok ? r.data : {}) as { kicked?: number; verifiedGone?: boolean; scanComplete?: boolean } };
  };

  // ---------- CELL 2 (arm): tenant B's live principal, under the SAME principal string ----------
  const bId = newIdentity();
  const bCreds = await mintCreds(authB, bId, "operator", { principal: { owner: ownerU, actor: "victim" } });
  const vB = await connectVictim(bCreds, bId.id);
  ncB = vB.nc;
  check("cell 2 (arm): tenant B holds a live connection under the SAME principal string as A's victim",
    !vB.closed(), { principal: sharedPrincipal });

  // ---------- CELL 1: evict a live CALLOUT-MINTED principal in A ----------
  const nonceP = `ibx${randomUUID().replace(/-/g, "")}`;
  ncP = await connect({
    servers: SERVERS,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearerP)],
    maxReconnectAttempts: 0, reconnect: false, timeout: 4000, name: nonceP, inboxPrefix: `_INBOX_${nonceP}`,
  });
  let pClosed = false;
  void ncP.closed().then(() => { pClosed = true; }, () => { pClosed = true; });
  check("cell 1 (arm): a callout-minted user principal is live in tenant A", !ncP.isClosed());
  check("cell 1 (arm): deny-new is committed first (the mandatory precondition)", revokeActor(ledgerDir, ownerU, "victim") === true);

  const c1 = await evict(sharedPrincipal);
  check("cell 1: eviction from the store-injected $SYS pair verifies the principal GONE under a complete scan",
    c1.ok === true && (c1.ev.kicked ?? 0) >= 1 && c1.ev.verifiedGone === true && c1.ev.scanComplete === true, JSON.stringify(c1));
  check("cell 1: the live connection actually dropped — not merely reported gone",
    await until(() => pClosed || ncP!.isClosed(), 5000), { pClosed });

  // ---------- CELL 2 (assert): the other tenant is untouched ----------
  check("cell 2: tenant B's identically-named principal is UNTOUCHED by A's eviction (account-scoped scan contains the broker-wide KICK)",
    !vB.closed());

  // ---------- CELL 3: hand A's daemon tenant B's OBSERVER ----------
  // The load-bearing cell. A well-formed sweep of the WRONG account looks exactly like a gone
  // principal, so this must refuse NAMING BOTH ACCOUNTS and must never answer a confident `gone`.
  const id3 = newIdentity();
  const v3b = await connectVictim(await mintCreds(authA, id3, "operator"), id3.id);
  const principal3 = principalKey(DEV_OWNER, id3.id).key;
  await storeA.put(OBSERVER_KEY_A, observerB);
  const c3 = await evict(principal3);
  check("cell 3: a FOREIGN-tenant observer is refused, naming both accounts — never a confident gone",
    c3.ok === false && (c3.error ?? "").includes(accB.account.pub) && (c3.error ?? "").includes(accA.account.pub), JSON.stringify(c3));
  check("cell 3: the refusal is not a disguised success (no verifiedGone in the reply)", c3.ok === false && c3.ev.verifiedGone === undefined, JSON.stringify(c3));
  check("cell 3: the victim is STILL LIVE after the refusal (nothing was swept, nothing was kicked)", !v3b.closed());
  // POSITIVE CONTROL — the same operation, the correct observer, same process.
  await storeA.put(OBSERVER_KEY_A, observerA);
  const c3ok = await evict(principal3);
  check("cell 3 CONTROL: with A's own observer restored, the SAME eviction succeeds (the refusal was the tenancy check, not a broken path)",
    c3ok.ok === true && (c3ok.ev.kicked ?? 0) >= 1 && c3ok.ev.verifiedGone === true, JSON.stringify(c3ok));
  check("cell 3 CONTROL: that victim's connection actually dropped", await until(() => v3b.closed(), 5000));

  // ---------- CELL 4: the evictor key is GONE from the store ----------
  const id4 = newIdentity();
  const v4 = await connectVictim(await mintCreds(authA, id4, "operator"), id4.id);
  const principal4 = principalKey(DEV_OWNER, id4.id).key;
  await storeA.delete(EVICTOR_KEY_A);
  const c4 = await evict(principal4);
  check("cell 4: a missing evictor key REFUSES LOUD naming the key (fail-loud; the caller reads UNKNOWN, never gone)",
    c4.ok === false && (c4.error ?? "").includes(CONNECTION_EVICTOR_CREDS_KIND) && (c4.error ?? "").includes(EVICTOR_KEY_A), JSON.stringify(c4));
  check("cell 4 (F2/§4.1): the repair names the STORE idiom, not a CLI command the host cannot run",
    /put/.test(c4.error ?? "") && !/cotal up/.test(c4.error ?? ""), c4.error);
  check("cell 4: the victim is STILL LIVE (a refusal never kills)", !v4.closed());
  // POSITIVE CONTROL — restore the key, same eviction, same process.
  await storeA.put(EVICTOR_KEY_A, evictorA);
  const c4ok = await evict(principal4);
  check("cell 4 CONTROL: with the evictor key restored, the SAME eviction succeeds and kicks",
    c4ok.ok === true && (c4ok.ev.kicked ?? 0) >= 1 && c4ok.ev.verifiedGone === true, JSON.stringify(c4ok));
  check("cell 4 CONTROL: that victim's connection actually dropped", await until(() => v4.closed(), 5000));

  // ---------- CELL 5: the observer key is GONE — the FEED degrades, Plane-3 does not ----------
  await storeA.delete(OBSERVER_KEY_A);
  const feedDown = await startMembership({ space: spaceA, server: SERVERS, accountId: accA.account.pub }, storeA);
  check("cell 5: a missing observer key degrades the feed SOFTLY with a {down} naming the key (never a throw, never a silent feed)",
    feedDown.handle === undefined && (feedDown.down ?? "").includes(MEMBERSHIP_OBSERVER_CREDS_KIND) && (feedDown.down ?? "").includes(OBSERVER_KEY_A), JSON.stringify(feedDown.down));
  check("cell 5 (F2/§4.1): the feed's repair also names the STORE idiom", /put/.test(feedDown.down ?? "") && !/cotal up/.test(feedDown.down ?? ""), feedDown.down);
  // Plane-3 is a SEPARATE contract: the feed being down must not touch delivery.
  const stillServing = await admin("noSuchOp"); // a refusal that PROVES the responder is alive
  check("cell 5: Plane-3 delivery still serves while the feed is down (the admin responder answers)", stillServing.ok === false, JSON.stringify(stillServing));
  const probe5 = newIdentity();
  check("cell 5: the delivery lease is still READY (fail-SOFT is scoped to the feed, not the daemon)",
    await waitForDeliveryLease({ servers: SERVERS, space: spaceA, creds: await mintCreds(authA, probe5, "delivery"), id: probe5.id, holder: undefined }));
  // POSITIVE CONTROL — restore the key, the SAME call, same process.
  await storeA.put(OBSERVER_KEY_A, observerA);
  const feedUp = await startMembership({ space: spaceA, server: SERVERS, accountId: accA.account.pub }, storeA);
  check("cell 5 CONTROL: with the observer key restored, the SAME call starts a real feed (the {down} was the missing key, not a broken path)",
    feedUp.handle !== undefined, JSON.stringify(feedUp.down));
  try { await feedUp.handle?.stop(); } catch { /* draining */ }

  // ---------- CELL 6: a principal that is not connected ----------
  const c6 = await evict(principalKey(DEV_OWNER, newIdentity().id).key);
  check("cell 6: evicting a not-live principal is an idempotent verified no-op (kicked:0, verifiedGone, complete scan)",
    c6.ok === true && c6.ev.kicked === 0 && c6.ev.verifiedGone === true && c6.ev.scanComplete === true, JSON.stringify(c6));

  // ---------- CELL 7: a TORN rotation — the two $SYS creds from different system accounts ----------
  // Closing this on the eviction path is one of the changes under test: the check used to live only
  // in the feed, so the path that actually kills connections opened a half-rotated pair blind and got
  // a bare "Authorization Violation" from the broker with nothing naming the cause.
  const id7 = newIdentity();
  const v7 = await connectVictim(await mintCreds(authA, id7, "operator"), id7.id);
  const principal7 = principalKey(DEV_OWNER, id7.id).key;
  await storeA.put(EVICTOR_KEY_A, tornEvictorA);
  const c7 = await evict(principal7);
  check("cell 7 (eviction path): a torn $SYS pair refuses, naming DIFFERENT system accounts — the gap this change closes",
    c7.ok === false && /DIFFERENT system accounts/i.test(c7.error ?? ""), JSON.stringify(c7));
  check("cell 7: the victim is STILL LIVE after the torn-pair refusal", !v7.closed());
  const feedTorn = await startMembership({ space: spaceA, server: SERVERS, accountId: accA.account.pub }, storeA);
  check("cell 7 (feed path): the same torn pair takes the feed down with the same diagnosis (one shared helper, two postures)",
    feedTorn.handle === undefined && /DIFFERENT system accounts/i.test(feedTorn.down ?? ""), JSON.stringify(feedTorn.down));
  // POSITIVE CONTROL — restore the intact pair, both paths, same process.
  await storeA.put(EVICTOR_KEY_A, evictorA);
  const c7ok = await evict(principal7);
  check("cell 7 CONTROL: with an intact generation restored, the SAME eviction succeeds and kicks",
    c7ok.ok === true && (c7ok.ev.kicked ?? 0) >= 1 && c7ok.ev.verifiedGone === true, JSON.stringify(c7ok));
  check("cell 7 CONTROL: that victim's connection actually dropped", await until(() => v7.closed(), 5000));
  const feedOk = await startMembership({ space: spaceA, server: SERVERS, accountId: accA.account.pub }, storeA);
  check("cell 7 CONTROL: the feed also starts on the intact pair", feedOk.handle !== undefined, JSON.stringify(feedOk.down));
  try { await feedOk.handle?.stop(); } catch { /* draining */ }

  // ---------- CELL 8 (after): still nothing on disk, and B is still untouched ----------
  check("cell 8 (after): every cell above ran with NO $SYS cred and NO membership.json on disk", onDisk().length === 0, onDisk());
  check("cell 8: the injected store served every read (reads > 0 and rising)", storeA.reads > 0, { reads: storeA.reads });
  check("cell 2 (final): tenant B's principal survived every eviction round in tenant A", !vB.closed());

  realLog(`\nU3 SYS-INJECTION-EVICT GATE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed) — ${NATS_VERSION}`);
  if (fail) process.exitCode = 1;
} catch (e) {
  untee();
  fail++;
  realErr("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  realErr("  -- delivery daemon output tail (a thrown scenario otherwise hides the daemon's last words):\n", daemonLog.slice(-2000));
  process.exitCode = 1;
} finally {
  untee(); // the daemon is about to be torn down; its console must be its own again
  try { await sup?.stop(); } catch { /* draining */ }
  for (const nc of [ncP, ncB, calloutNc, ...victims]) { try { await nc?.close(); } catch { /* draining */ } }
  await killAndAwaitExit(srv, "SIGKILL"); // exact PID — never pkill nats-server
  process.chdir(startCwd); // leave the mkdtemp roots before removing them
  for (const r of [dir, ledgerDir, rootA, rootB]) rmSync(r, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(process.exitCode ?? 0);
