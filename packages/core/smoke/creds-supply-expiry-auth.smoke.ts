/**
 * Credential-supply expiry smoke (#1411): the endpoint's refusal to present an expired credential
 * is a property of the credential SUPPLY, not of one dial site, so it holds on the reconnects
 * nats.js performs on its own — the ones no Cotal code calls.
 *
 * WHY THIS SUITE EXISTS, and what the standing-renewal suite cannot say. `standing-renewal-auth`
 * grades the LOCAL refusal (that the warning is raised) and its denial-counting cell inspects a
 * slice that opens at a fixture marker, so a presentation outside that slice is invisible to it.
 * The property here is the WIRE one — zero expired credentials reach the broker — and it is graded
 * over the WHOLE broker log for the identity under test, with no window.
 *
 * THE TWO LIBRARY RECONNECTS, because they are different and only one was ever discussed:
 *
 *   1. The reconnect the broker FORCES at JWT `exp`. It closes the authenticated connection, the
 *      client redials, and the redial re-evaluates the authenticator.
 *   2. A dial loop from an EARLIER drop that is still retrying when `exp` passes. The endpoint's
 *      pre-expiry fence flips nats-core's `reconnect` policy flag, but nats-core reads that flag
 *      when it OBSERVES a drop — a loop already inside `dodialLoop` keeps going, and each of its
 *      attempts re-evaluates the authenticator after `exp`.
 *
 * Case 2 is the one that survives a fence, which is why the repair is on the supply instead.
 *
 * Run: pnpm smoke:creds-supply-expiry   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  serverConfig,
  setupSpaceStreams,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 10_000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};
const awaitExit = (proc: ChildProcess, timeoutMs = 4000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/**
 * Did a client actually send a CONNECT carrying credential material in this slice?
 *
 * NOT the same question as "did anything open a socket", and the difference is load-bearing. The
 * broker logs `Client connection created` for ANY accepted TCP connection, including one that reads
 * the INFO banner and closes without ever sending CONNECT. This suite makes exactly such
 * connections: the `isReachable` liveness poll after each broker restart is a credless probe, and it
 * runs INSIDE the window the non-vacuity control grades. Measured: five polls produce five
 * `Client connection created` lines and zero authentications.
 *
 * So a control keyed on that line could be satisfied entirely by this suite's own probes, and would
 * read "the dial loop reached the broker" when the dial loop had not run at all — the precise
 * vacuity the control exists to rule out, reintroduced by the control itself.
 *
 * A JWT-bearing CONNECT is distinguishable because the broker says what it did with the credential:
 * it either admitted it (`Authenticated JWT`) or refused it by name. Counting those, rather than
 * sockets, is what makes the control mean "a client presented credential material here".
 */
const credentialedConnects = (log: string): string[] =>
  log.split("\n").filter((l) =>
    /Authenticated JWT/.test(l)
    || /User JWT no longer valid/.test(l)
    || /Authentication Expired/.test(l)
    || /Authorization Violation/.test(l));

/**
 * Every broker line that means EXPIRED CREDENTIAL MATERIAL WAS PRESENTED, for one client name.
 *
 * Two shapes, both of which this defect has been observed to produce, because which one appears
 * depends on where the JWT's `exp` sits relative to the CONNECT the broker is validating:
 *   - `User JWT no longer valid ... claim is expired` — the claim was already past at validation.
 *   - `User Authentication Expired` on a cid whose CONNECT this client just made.
 * A detector that knew only one of them would read a real presentation as clean. The name filter
 * keeps other endpoints in the same space (and their own legitimate lifecycles) out of the count.
 *
 * ONE BENIGN LINE MUST NOT COUNT. `Authentication Expired` also appears when the broker retires a
 * connection whose credential it ADMITTED while still live — the designed backstop at `exp`, not a
 * presentation. It is separated by cid: a cid that carried `Authenticated JWT` was admitted, and
 * that line is emitted while processing the CONNECT (before the client name is known to the broker)
 * so it carries the nkey rather than `cotal:<name>` — which is why the caller passes the identity.
 */
/**
 * AND THE IDENTITY FILTER MUST NOT BE APPLIED TO BOTH SHAPES, which is a hole this detector had
 * and a measurement caught. The rejection line is
 *
 *   cid:90 - User JWT no longer valid: &{Issues:[claim is expired]}
 *
 * and it names NEITHER the client nor the nkey: the broker refuses the CONNECT before it adopts
 * either. Requiring an identity match on that shape filtered out the precise line the pre-fix tree
 * emits, and the probe read clean against a tree that was presenting expired credentials. It is
 * attributable without the identity because the caller passes a log SLICE covering one endpoint's
 * activity in a per-run space, and the only other client touching that window is a credless TCP
 * liveness probe that never sends a JWT.
 */
const expiredPresentations = (log: string, clientName: string, nkey: string): string[] => {
  const lines = log.split("\n");
  const admitted = new Set(
    lines
      .filter((l) => /Authenticated JWT/.test(l) && l.includes(nkey))
      .map((l) => l.match(/cid:(\d+)/)?.[1])
      .filter((c): c is string => Boolean(c)),
  );
  return lines.filter((l) => {
    // Shape 1: an outright rejection. Anonymous by construction — never identity-filtered.
    if (/User JWT no longer valid/.test(l) && /claim is expired/.test(l)) return true;
    // Shape 2: attributable, so it IS identity-filtered, and excluded on an admitted cid.
    if (!/Authentication Expired/.test(l)) return false;
    if (!l.includes(`cotal:${clientName}`) && !l.includes(nkey)) return false;
    return !admitted.has(l.match(/cid:(\d+)/)?.[1] ?? "");
  });
};

const space = `creds-supply-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));

let brokerLog = "";
let srv = spawn("nats-server", ["-D", "-c", conf], { stdio: ["ignore", "pipe", "pipe"] });
const capture = (p: ChildProcess) => {
  p.stdout?.on("data", (d: Buffer) => { brokerLog += d.toString(); });
  p.stderr?.on("data", (d: Buffer) => { brokerLog += d.toString(); });
};
capture(srv);
let releaseBroker = teardownOnSignal(srv, dir);

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });

  // ══ A. LIBRARY RECONNECT 2: a dial loop that crosses `exp` while it is already retrying.
  // The broker is killed BEFORE `exp` and restarted AFTER it, with the renewal source down the
  // whole time. Nothing Cotal calls runs the redial that lands: it is nats-core's own loop,
  // started by the pre-`exp` drop and still spinning when the credential dies under it.
  {
    const TTL = 6;
    const id = newIdentity();
    const NAME = "supply-dialloop";
    let reads = 0;
    const warnings: string[] = [];
    // Timestamped so the control can tell a refusal raised AFTER the broker returned from one raised
    // while it was down. Both are the same message; only the ordering distinguishes them.
    const errors: string[] = [];
    const source = () => {
      reads++;
      if (reads === 1) return mintCreds(auth, id, "supervisor", { expiresInSeconds: TTL });
      throw new Error("fixture renewal source offline");
    };
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds: source,
      card: { id: id.id, name: NAME, kind: "endpoint" },
      consume: false, lifecycleUid: mintLifecycleUid(),
      registerPresence: false, watchChannels: false, watchPresence: false,
    });
    ep.on("error", (e: Error) => { errors.push(`${Date.now()}|${e.message}`); });
    ep.on("warning", (e: Error) => warnings.push(e.message));
    const t0 = Date.now();
    await ep.start();
    const expAtMs = t0 + TTL * 1000;
    check("a creds-source endpoint connects on its first fetch", reads === 1, reads);

    // Drop ~2.5s before exp: far enough that the loop is established, close enough that it is
    // still retrying when the credential dies.
    await wait(Math.max(0, expAtMs - 2_500 - Date.now()));
    srv.kill("SIGKILL");
    await awaitExit(srv);
    const droppedBeforeExp = Date.now() < expAtMs;

    // Back up AFTER exp. From here any CONNECT this client makes carries a dead JWT unless the
    // supply refuses it.
    await wait(Math.max(0, expAtMs + 1_500 - Date.now()));
    const markAtRestart = brokerLog.length;
    srv = spawn("nats-server", ["-D", "-c", conf], { stdio: ["ignore", "pipe", "pipe"] });
    capture(srv);
    releaseBroker();
    releaseBroker = teardownOnSignal(srv, dir);
    const restartedAfterExp = Date.now() > expAtMs;
    const restartAtMs = Date.now();
    for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) break; await wait(200); }

    // The control's own preconditions. Without these the zero below could be vacuous: a drop
    // that landed after exp, or a restart before it, is not the scenario at all.
    check("CONTROL: the transport dropped BEFORE the JWT expired", droppedBeforeExp);
    check("CONTROL: the broker returned AFTER the JWT expired", restartedAfterExp);
    check(
      "CONTROL: renewal stayed down across the whole window (so the cache could only hold dead material)",
      reads >= 2,
      reads,
    );

    // Give the library's loop a wide berth to present something: its retry spacing is 2s and the
    // cap on our own rebuild backoff is far longer, so 12s covers several attempts of each.
    await wait(12_000);
    const postRestart = brokerLog.slice(markAtRestart);
    // NON-VACUITY, and this cell is what makes the zero below mean anything. A zero is reachable two
    // ways: the supply refused every attempt (the property), or nothing tried at all (a quiet window,
    // which proves nothing). This must hold on BOTH a fixed and an unfixed tree, or it is not a
    // control — it is a second copy of the assertion.
    //
    // TWO EARLIER VERSIONS OF THIS CELL WERE WRONG, in opposite directions, and both were caught by
    // running them rather than by reading them:
    //
    //   1. `Client connection created` — satisfied by ANY accepted socket. This suite polls
    //      `isReachable` after each restart, a credless probe that never sends CONNECT; measured,
    //      five polls produce five such lines and zero authentications. The control could be
    //      satisfied entirely by the suite's own probes, i.e. it could not fail.
    //   2. A credentialed CONNECT on the wire (`Authenticated JWT` / a named refusal). Correct on the
    //      UNFIXED tree, and impossible on the fixed one: the whole point of the fix is that the
    //      refusal happens locally and NO CONNECT is ever sent. Measured green pre-fix, red post-fix.
    //
    // The invariant both missed is that the DIAL ATTEMPT is client-side, so the evidence must be too.
    // Each attempt evaluates the authenticator; on an expired cache that raises the refusal, and on a
    // tree without the checkpoint it instead produces a wire rejection. Accepting either means "the
    // loop was alive and asked the supply for a credential after the broker returned", which is the
    // precondition the zero needs, and it is observable on both trees.
    const refusalsAfterRestart = errors.filter((e) =>
      Number(e.split("|")[0]) >= restartAtMs && /creds have expired/.test(e)).length;
    check(
      "CONTROL: the dial loop was alive and asked the supply after the broker returned (a quiet window would prove nothing)",
      refusalsAfterRestart > 0 || credentialedConnects(postRestart).length > 0,
      {
        localRefusalsAfterRestart: refusalsAfterRestart,
        credentialedConnectsOnWire: credentialedConnects(postRestart).length,
        bareSockets: postRestart.split("\n").filter((l) => /Client connection created/.test(l)).length,
      },
    );
    const presented = expiredPresentations(postRestart, NAME, id.id);
    check(
      "an in-flight library dial loop that crosses expiry presents the expired credential ZERO times",
      presented.length === 0,
      { presented, reads },
    );
    check(
      "the refusal is loud and names the failing renewal path",
      warnings.some((m) => /creds have expired.*renewal.*failing/.test(m)),
      warnings,
    );
    await ep.stop();
  }

  // ══ B. LIBRARY RECONNECT 1: the reconnect the broker forces at `exp`, then RECOVERY.
  // Same supply, no broker interference: the connection dies of its own expiry, the client
  // redials, and the source comes back. The recovery half is what proves the refusal FAILS
  // CLOSED rather than dead — a guard that stranded a renewable endpoint would pass the zero
  // above and be useless.
  {
    const TTL = 4;
    const id = newIdentity();
    const NAME = "supply-brokerforced";
    let reads = 0;
    let allowRecovery = false;
    const warnings: string[] = [];
    const source = () => {
      reads++;
      if (reads === 1) return mintCreds(auth, id, "supervisor", { expiresInSeconds: TTL });
      if (!allowRecovery) throw new Error("fixture renewal source offline");
      return mintCreds(auth, id, "supervisor", { expiresInSeconds: 60 });
    };
    const markStart = brokerLog.length;
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds: source,
      card: { id: id.id, name: NAME, kind: "endpoint" },
      consume: false, lifecycleUid: mintLifecycleUid(),
      registerPresence: false, watchChannels: false, watchPresence: false,
    });
    ep.on("error", () => { /* the expiry close rides here */ });
    ep.on("warning", (e: Error) => warnings.push(e.message));
    // RECOVERY WITNESS. `setActivity` is NOT one: this endpoint is constructed with
    // registerPresence:false, so `publishPresence` returns at its first line (`!this.doRegister`)
    // without touching the wire, and the call therefore CANNOT throw whether or not a connection
    // exists. An earlier version of the cell below looped on it and would have gone green against
    // an endpoint that never reconnected at all. Count successful binds instead: endpoint.ts:1304
    // emits `connection {connected:true}` at the end of every successful bind, on the initial
    // start and on each self-heal rebuild alike, so a SECOND one is positive evidence that
    // `reestablishLoop` re-fetched from the recovered source and re-bound a real wire.
    let successfulBinds = 0;
    ep.on("connection", (s: { connected: boolean }) => { if (s.connected) successfulBinds++; });
    const t0 = Date.now();
    await ep.start();

    // Cross exp with the source down, then wait out the library's redials.
    await wait(Math.max(0, t0 + TTL * 1000 + 4_000 - Date.now()));
    check(
      "CONTROL: renewal failed before expiry, so the cache is past-dated at the forced reconnect",
      reads >= 2 && warnings.some((m) => /creds refresh failed/.test(m)),
      { reads, warnings },
    );
    // The SAME detector as section A: a cid the broker admitted is a live connection being retired
    // at `exp` (the designed backstop), a cid it never admitted is a refused CONNECT.
    const windowLog = brokerLog.slice(markStart);
    const admittedCids = new Set(
      windowLog.split("\n")
        .filter((l) => /Authenticated JWT/.test(l) && l.includes(id.id))
        .map((l) => l.match(/cid:(\d+)/)?.[1])
        .filter((c): c is string => Boolean(c)),
    );
    check(
      "CONTROL: the original connection did authenticate (so there was a live wire for the broker to expire)",
      admittedCids.size >= 1,
      [...admittedCids],
    );
    const presented = expiredPresentations(windowLog, NAME, id.id);
    check(
      "the broker-forced reconnect at expiry presents the expired credential ZERO times",
      presented.length === 0,
      { presented, admittedCids: [...admittedCids] },
    );

    allowRecovery = true;
    const bindsBeforeRecovery = successfulBinds;
    const deadline = Date.now() + 30_000;
    while (successfulBinds <= bindsBeforeRecovery && Date.now() < deadline) await wait(200);
    const recovered = successfulBinds > bindsBeforeRecovery;
    check(
      "the refusal fails CLOSED, not dead: the endpoint reconnects once its source returns",
      recovered,
      { reads, successfulBinds, bindsBeforeRecovery },
    );
    check(
      "CONTROL: the recovery above is a NEW bind, not the one start() already made",
      bindsBeforeRecovery >= 1 && successfulBinds >= 2,
      { successfulBinds, bindsBeforeRecovery },
    );
    await ep.stop();
  }

  // ══ C. THE ADOPTION PREFLIGHT: the one presentation that does NOT read the cache.
  // `reloadCreds` proves a candidate on a disposable connection. That candidate comes straight
  // from the store, so a supply check that only covered the cache would miss it entirely.
  {
    const id = newIdentity();
    const NAME = "supply-preflight";
    let serveExpired = false;
    const source = async () => serveExpired
      ? mintCreds(auth, id, "supervisor", { expiresAt: Math.floor(Date.now() / 1000) - 1 })
      : mintCreds(auth, id, "supervisor", { expiresInSeconds: 120 });
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds: source,
      card: { id: id.id, name: NAME, kind: "endpoint" },
      consume: false, lifecycleUid: mintLifecycleUid(),
      registerPresence: false, watchChannels: false, watchPresence: false,
    });
    ep.on("error", () => {});
    ep.on("warning", () => {});
    await ep.start();

    // ACCEPTING: a live candidate is adopted and its window reported.
    const adopted = await ep.reloadCreds();
    check(
      "ACCEPT: an explicit reload of a LIVE candidate is adopted and reports its window",
      adopted.identity === id.id && typeof adopted.exp === "number",
      adopted,
    );

    // REFUSING, differing from the case above ONLY in the candidate's exp.
    serveExpired = true;
    const markPreflight = brokerLog.length;
    let refusal = "";
    try { await ep.reloadCreds(); } catch (e) { refusal = (e as Error).message; }
    check(
      "REFUSE: an explicit reload of an EXPIRED candidate is refused",
      /creds have expired/.test(refusal),
      refusal,
    );
    check(
      "the refused candidate never reaches the broker (no preflight presentation on the wire)",
      expiredPresentations(brokerLog.slice(markPreflight), NAME, id.id).length === 0,
      expiredPresentations(brokerLog.slice(markPreflight), NAME, id.id),
    );
    // The resident connection must be untouched: a refused candidate is not adopted, so the
    // endpoint still works on the generation it already had.
    let stillServing = false;
    try { await ep.setActivity("post-refusal"); stillServing = true; } catch { /* recorded below */ }
    check(
      "a refused candidate leaves the resident connection on its previous credential",
      stillServing,
    );
    await ep.stop();
  }

  // ══ D. STATIC (no source) creds: the SAME checkpoint, the other message, and its accepting twin.
  // These two differ only in whether the credential carries a past `exp`, which is the axis the
  // check turns on; the diagnostic must also name the right remedy, because a static endpoint
  // cannot renew and telling its operator to wait for renewal is a dead end.
  {
    const id = newIdentity();
    const expired = await mintCreds(auth, id, "probe", { expiresAt: Math.floor(Date.now() / 1000) - 1 });
    const markStatic = brokerLog.length;
    let threw = "";
    try {
      const ep = new CotalEndpoint({
        space, servers: SERVERS, creds: expired,
        card: { id: id.id, name: "supply-static-expired", kind: "endpoint" },
        consume: false, registerPresence: false, watchChannels: false, watchPresence: false,
      });
      await ep.start();
      await ep.stop();
    } catch (e) { threw = (e as Error).message; }
    check(
      "REFUSE: a STATIC expired cred is refused and names replacement, not renewal",
      /creds have expired/.test(threw) && /no creds source/.test(threw) && !/retrying with backoff/.test(threw),
      threw,
    );
    check(
      "the refused static cred never reaches the broker",
      expiredPresentations(brokerLog.slice(markStatic), "supply-static-expired", id.id).length === 0,
      expiredPresentations(brokerLog.slice(markStatic), "supply-static-expired", id.id),
    );

    // ACCEPTING twin: same static path, an UNBOUNDED credential. A cred with no `exp` has no
    // expiry to be past, so the checkpoint must pass it through rather than refuse what it
    // cannot date. Without this cell a checkpoint that refused every static cred would look
    // correct.
    const unboundedId = newIdentity();
    const unbounded = await mintCreds(auth, unboundedId, "teardown", { lifecycleUid: mintLifecycleUid() });
    let connected = false, unboundedErr = "";
    try {
      const ep = new CotalEndpoint({
        space, servers: SERVERS, creds: unbounded,
        card: { id: unboundedId.id, name: "supply-static-unbounded", kind: "endpoint" },
        consume: false, lifecycleUid: mintLifecycleUid(),
        registerPresence: false, watchChannels: false, watchPresence: false,
      });
      ep.on("error", () => {});
      ep.on("warning", () => {});
      await ep.start();
      connected = true;
      await ep.stop();
    } catch (e) { unboundedErr = (e as Error).message; }
    check(
      "ACCEPT: a STATIC cred with no expiry claim is presentable (nothing to be past)",
      connected,
      unboundedErr,
    );

    // ACCEPTING twin for the renewed path: a bounded, unexpired cred connects. The accepting
    // counterpart to A and B, differing only in that its credential is still live.
    const liveId = newIdentity();
    const liveCreds = await mintCreds(auth, liveId, "supervisor", { expiresInSeconds: 120 });
    let liveOk = false, liveErr = "";
    try {
      const ep = new CotalEndpoint({
        space, servers: SERVERS, creds: () => Promise.resolve(liveCreds),
        card: { id: liveId.id, name: "supply-bounded-live", kind: "endpoint" },
        consume: false, lifecycleUid: mintLifecycleUid(),
        registerPresence: false, watchChannels: false, watchPresence: false,
      });
      ep.on("error", () => {});
      ep.on("warning", () => {});
      await ep.start();
      await ep.setActivity("live");
      liveOk = true;
      await ep.stop();
    } catch (e) { liveErr = (e as Error).message; }
    check(
      "ACCEPT: a bounded, UNEXPIRED source cred is presentable and round-trips",
      liveOk,
      liveErr,
    );
  }

  // ══ E. The supply refuses when it holds NOTHING, rather than presenting `undefined`.
  // The getter used to be `() => this.currentCreds!`, a non-null assertion over a field that is
  // genuinely empty until the first fetch returns. A library reconnect firing in that window
  // encoded an empty credential. This is the accepting branch's absence, not an expiry.
  {
    const id = newIdentity();
    let firstCall = true;
    let threw = "";
    try {
      const ep = new CotalEndpoint({
        space, servers: SERVERS,
        creds: () => {
          if (firstCall) { firstCall = false; throw new Error("store unavailable at first fetch"); }
          return mintCreds(auth, id, "supervisor", { expiresInSeconds: 60 });
        },
        card: { id: id.id, name: "supply-empty", kind: "endpoint" },
        consume: false, lifecycleUid: mintLifecycleUid(),
        registerPresence: false, watchChannels: false, watchPresence: false,
      });
      ep.on("error", () => {});
      ep.on("warning", () => {});
      await ep.start();
      await ep.stop();
    } catch (e) { threw = (e as Error).message; }
    check(
      "REFUSE: a first fetch that never returned fails loud instead of dialing with no credential",
      threw.includes("store unavailable at first fetch"),
      threw,
    );
  }

  // E2. A STATIC EMPTY CREDENTIAL. Found by a surviving mutation: the cell above proves the FETCH
  // rethrows, which happens before the getter is consulted, so it never graded the getter's empty
  // branch at all. Probing that branch directly showed the endpoint dialing ANONYMOUSLY — the dial
  // gate tested the cached cred for TRUTHINESS, and an empty string took the same path as "no creds
  // configured", so the connection went out with no auth material and came back `Authorization
  // Violation`. The caller's actual mistake (an empty credential) was never named, and the failure
  // read as a permissions problem on the broker rather than a supply problem here.
  //
  // This is the same defect class as the one this change is about: a credential path that routes
  // AROUND the checkpoint rather than through it. It is included because the guard is "every path
  // presents something checked", and dialing with nothing is not an exception to that.
  {
    const id = newIdentity();
    let threw = "";
    try {
      const ep = new CotalEndpoint({
        space, servers: SERVERS, creds: "",
        card: { id: id.id, name: "supply-empty-static", kind: "endpoint" },
        consume: false, registerPresence: false, watchChannels: false, watchPresence: false,
      });
      ep.on("error", () => {});
      ep.on("warning", () => {});
      await ep.start();
      await ep.stop();
    } catch (e) { threw = (e as Error).message; }
    check(
      "REFUSE: a STATIC EMPTY creds string fails loud instead of dialing anonymously",
      /empty creds string/.test(threw) && !/Authorization Violation/.test(threw),
      threw,
    );
  }

  // THE ACCEPTING TWIN, and the reason the refusal above is a `!== undefined` check rather than a
  // truthiness one. Passing NO creds at all is a legitimate configuration (a dev broker with no auth
  // account), and it must still connect. It differs from the cell above ONLY in whether the creds
  // key is absent or present-but-empty, which is exactly the distinction the fix turns on: a gate
  // that refused both would have broken anonymous access, and one that allowed both is the defect.
  {
    const anonPort = await pickFreePort();
    const anonServers = `nats://127.0.0.1:${anonPort}`;
    const anonDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
    const anonConf = join(anonDir, "server.conf");
    writeFileSync(anonConf, `port: ${anonPort}\njetstream: { store_dir: "${join(anonDir, "js")}" }\n`);
    const anonSrv = spawn("nats-server", ["-c", anonConf], { stdio: "ignore" });
    const releaseAnon = teardownOnSignal(anonSrv, anonDir);
    let connected = false;
    let detail = "";
    try {
      for (let i = 0; i < 60; i++) { if (await isReachable(anonServers)) break; await wait(200); }
      const ep = new CotalEndpoint({
        space, servers: anonServers,
        card: { name: "supply-no-creds", kind: "endpoint" },
        consume: false, registerPresence: false, watchChannels: false, watchPresence: false,
      });
      ep.on("error", () => {});
      ep.on("warning", () => {});
      await ep.start();
      await ep.setActivity("anonymous-ok");
      connected = true;
      await ep.stop();
    } catch (e) { detail = (e as Error).message; }
    finally {
      anonSrv.kill("SIGKILL");
      await awaitExit(anonSrv);
      rmSync(anonDir, { recursive: true, force: true });
      releaseAnon();
    }
    check(
      "ACCEPT: NO creds at all still connects (the refusal is about an empty credential, not about anonymity)",
      connected,
      detail,
    );
  }

  const total = pass + fail;
  console.log(fail === 0
    ? `\nCREDS SUPPLY EXPIRY SMOKE OK ✅  (${pass} passed, ${fail} failed, ${total} cells)`
    : `\nCREDS SUPPLY EXPIRY SMOKE FAILED ❌  (${pass} passed, ${fail} failed, ${total} cells)`);
  // The MACHINE-READABLE line the shard grades on, last so nothing can print after it. The human
  // banner above is not a substitute: its legacy form carries a third `N cells` clause, which the
  // parser reads as prose rather than a tally, so it yields NO sentinel at all and the shard treats
  // this suite as a zero-cell run. Measured against the parser directly rather than assumed.
  emitSentinel({ passed: pass, failed: fail, cells: total });
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
