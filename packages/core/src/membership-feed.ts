/**
 * Authoritative channel-membership feed — the broker-sourced "who is subscribed to each channel"
 * the graph view draws (incl. silent readers and `live` channels that keep no enumerable roster).
 *
 * This is the NATS-client layer of the feature (so it lives in core, like `setupSpaceStreams`); the
 * delivery daemon is the thin composition root that loads the two scoped creds + the account id and
 * calls {@link startMembershipFeed}. It owns TWO connections — NATS accounts are a hard isolation
 * boundary, so the `$SYS` CONNZ read (conn A, system account) and the data-account KV (conn B) cannot
 * share a principal — and merges them IN-PROCESS:
 *
 *   conn A (SYSTEM) — poll `$SYS.REQ.ACCOUNT.<id>.CONNZ {subscriptions,auth}` (fans out: 1 reply/server
 *     → per-server paginate → union-dedupe by nkey); sub CONNECT/DISCONNECT as re-poll triggers.
 *   conn B (DATA)   — read the members registry (durable arm) + read/write the derived feed bucket.
 *   merge           — per agent: live (CONNZ patterns, wildcards kept) ∪ durable (members registry);
 *                     diff-before-put on the normalized {live,durable}; prune departed agents.
 *
 * CONNZ is authoritative for the live half; presence only *enriches* (name/role/status) at the
 * dashboard, never gates here (a momentarily-lapsed heartbeat must not drop a live core-sub). The feed
 * is **display-only** — never an input to delivery/ACL/authorization. Any failure here logs and degrades
 * the graph only; it shares nothing with Plane-3 delivery.
 *
 * Placement note (fowler): every other core connect-site is one-shot (connect → op → drain). This is the
 * FIRST persistently-connected, timer-driven service in core — a new category, deliberately split:
 * **core owns the mechanism + connection lifecycle** (the engine, the two conns, the poll loop), and the
 * **implementation (delivery daemon) owns the DECISION to run it** — creds source, lifetime, N=1, fail-
 * soft. Don't read "it touches NATS → put it in core" and migrate, say, the Plane-3 writer up here; that
 * would undo the daemon's least-privilege extraction. The barrel exports {@link startMembershipFeed}, but
 * the **scoped creds are the real gate**: with no system-account observer cred it simply cannot connect.
 */
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  membershipBucket,
  membershipKey,
  MEMBERSHIP_FEED_KEY,
  MEMBERSHIP_INBOX_PREFIX,
  connzRequestSubject,
  accountConnectSubject,
  accountDisconnectSubject,
  channelFromChatSubscription,
  principalFromConnz,
} from "./subjects.js";
import { openMembersRegistry, listMembers } from "./members.js";
import { liveKvEntries } from "./kv-scan.js";
import { credsClaims, credsFingerprint, credsRenewalDelayMs, idFromCreds } from "./identity.js";
import { withDeadline } from "./deadline.js";
import type { ChannelMembership } from "./types.js";

export interface MembershipFeedOpts {
  servers: string;
  space: string;
  /** DATA account public key — the CONNZ request + CONNECT/DISCONNECT event subjects pin this account. */
  accountId: string;
  /** Scoped SYSTEM-account observer creds (conn A — CONNZ reader): a literal string, or a SOURCE
   *  shaped like `rwCreds`. A literal has no renewal (a workstation drops the $SYS seed at `up`, so
   *  its renewal is a rotation + restart). A source is for a host that keeps a registered system
   *  signer and re-mints the observer into its store: each candidate is renewed on the same 75% timer
   *  and preflight-proven before conn A presents it. A candidate is refused unless it keeps the first
   *  read's issuer and its exact permission block (so its account scope); the user nkey may change. */
  observerCreds: string | (() => string | Promise<string>);
  /** Scoped DATA-account read/write creds (conn B — members read + feed write): a literal string, or
   *  a SOURCE that reads them through the {@link SecretStore} seam — the manager
   *  re-signs the SAME nkey into the store and the feed adopts it. May be async (a hosted `store.get`)
   *  or sync (a local FS read / literal). A source-fed cred is renewed on a 75% timer that PROVES each
   *  candidate on a disposable preflight before conn B ever presents it; conn B's authenticator only
   *  ever presents the last BROKER-PROVEN generation, so an incidental reconnect can never carry an
   *  unproven cred. A read that swaps the nkey fails loud — the feed's identity (inbox scope +
   *  self-presence check) is pinned to the first read. */
  rwCreds: string | (() => string | Promise<string>);
  /** Safety reconcile interval (ms) — primary signal (no SUB/UNSUB event exists). Default 15000. */
  intervalMs?: number;
  /** Connect/disconnect-event → re-poll debounce (ms); coalesces connect storms. Default 400. */
  debounceMs?: number;
  /** Fan-out reply settle gap (ms): finish a CONNZ round this long after the last reply. Default 250. */
  settleMs?: number;
  /** Fan-out hard cap (ms) per CONNZ round. Default 1500. */
  maxWaitMs?: number;
  /** CONNZ per-server page size. Default 1024 (the server default). */
  pageLimit?: number;
  /** Structured log sink (defaults to a `! membership:`-prefixed console.error). */
  log?: (msg: string) => void;
}

export interface MembershipFeedHandle {
  /** Force an immediate reconcile (also used by tests). Never throws — errors are logged. */
  poll(): Promise<void>;
  /** Explicitly adopt a re-signed rw cred on conn B (D5 class-2 renewal): fetch from the source
   *  (deadline-bounded), validate the identity pin, optional fingerprint match against the renewal
   *  owner's `expected` generation, a DISPOSABLE PREFLIGHT proving the broker accepts the bytes, then
   *  commit the proven cache and present it on conn B — reconnect when the client is still open, or
   *  open a fresh data connection and rebind the KV handles when the client has already closed
   *  (the expiry refusal). Returns the BROKER-ACCEPTED generation's window. Runs under the same
   *  single-flight as the 75% timer, so the two can never interleave. THROWS when the source fetch
   *  fails (missing/swapped cred), the fingerprint does not match `expected`, the broker refuses the
   *  preflight, the deadline elapses, or a closed conn B cannot be revived on the proven cache.
   *  Symmetric with the endpoint's {@link CotalEndpoint.reloadCreds}. */
  reloadRwCreds(expected?: string): Promise<{ identity: string; iat?: number; exp?: number }>;
  stop(): Promise<void>;
}

const enc = (s: string) => new TextEncoder().encode(s);

/** The disposable-preflight connect bound for the rw-cred adoption proof — mirrors the endpoint's: a
 *  rogue/unreachable candidate must resolve fast, well under the manager's delivery-admin request bound. */
const MEMBERSHIP_PREFLIGHT_MS = 4_000;

/** The daemon-side deadline for the WHOLE rw prove-then-adopt transaction (source fetch + preflight +
 *  commit), kept strictly BELOW the manager's delivery-admin request bound (15s) so a slow/hung hosted
 *  store returns a structured component failure rather than an ambiguous client timeout, and a late
 *  fetch can never commit after the caller gave up. Mirrors {@link CotalEndpoint}'s RELOAD_DEADLINE_MS. */
const MEMBERSHIP_RELOAD_DEADLINE_MS = 12_000;

/** How soon a FAILED 75% rw renewal retries (the old cred stays live to its expiry meanwhile). */
const MEMBERSHIP_CREDS_RETRY_MS = 60_000;

/** Prove the broker ACCEPTS these creds on a throwaway connection — the D5 class-2 adoption
 *  proof-of-record for conn B. `reconnect:false` + `maxReconnectAttempts:0` so a refused cred
 *  REJECTS fast instead of entering a retry loop; a genuine accept returns true. Presents exactly
 *  the candidate, so the proof is unambiguous. */
async function brokerAcceptsCreds(servers: string, creds: string, timeoutMs: number): Promise<boolean> {
  try {
    const probe = await connect({ servers, timeout: timeoutMs, reconnect: false, maxReconnectAttempts: 0, authenticator: credsAuthenticator(enc(creds)) });
    await probe.close();
    return true;
  } catch {
    return false;
  }
}
const MAX_PAGES = 64; // fan-out pagination guard (64 × 1024 = 65k conns/server before a loud under-report)

/** Connect, wire the triggers + safety poll, and run an immediate first reconcile.
 *
 *  Startup is TRANSACTIONAL. Conn A opens first, and every step after it can throw: an rw source that
 *  rejects, credential bytes `idFromCreds` refuses, conn B's own dial (its pre-dial checkpoint refuses a
 *  cred that is already expired, and the broker refuses one it will not authenticate), either KV open.
 *  The first reconcile is NOT one of them: `poll()` wraps the whole loop in a catch that logs and has
 *  zero rethrows, so a failing first reconcile resolves startup instead of rejecting it, and the
 *  `await poll()` below cannot be the step that strands a connection. Before this change the only
 *  `drain()` in this file was inside the handle's `stop()`, and a caller
 *  that never receives the handle can never call it — so a reject left the observer connection open for
 *  the life of the process. The rollback above now drains every connection it recorded before the
 *  rejection propagates.
 *
 *  Scope of the word TRANSACTIONAL, stated rather than assumed: the rollback drains CONNECTIONS, and
 *  nothing else. It does not clear the rw or observer renewal timers, the safety interval, or the two
 *  trigger subscriptions, all of which are acquired below. So every check that can throw must run
 *  before the first timer arm: the observer source's renewal window is validated as soon as it is
 *  read, before conn A opens, which keeps the observer arm from throwing after the rw arm. What runs
 *  after the rw arm is the observer arm (validated), `connA.subscribe` twice, the `setInterval`, and
 *  `await poll()`. The two subject helpers passed as subscribe arguments also execute; they format a
 *  string and return. The only one that awaits is `await poll()`, which swallows
 *  its own failures, so the ordinary startup path never rejects down here. `connA.subscribe` on an
 *  already-closed conn A is the one shape that still could, and it would leak the timers rather than a
 *  connection. Left as a known gap rather than papered over: a step added below the arm that can
 *  reject makes this incomplete, and the rollback then has to clear the timers too. */
export async function startMembershipFeed(opts: MembershipFeedOpts): Promise<MembershipFeedHandle> {
  const opened: NatsConnection[] = [];
  try {
    return await startFeed(opts, opened);
  } catch (err) {
    // `allSettled`: a drain that itself fails must not replace the startup error the caller needs.
    await Promise.allSettled(opened.map((c) => c.drain()));
    throw err;
  }
}

async function startFeed(opts: MembershipFeedOpts, opened: NatsConnection[]): Promise<MembershipFeedHandle> {
  const log = opts.log ?? ((m: string) => console.error(`! membership: ${m}`));
  const intervalMs = opts.intervalMs ?? 15_000;
  const debounceMs = opts.debounceMs ?? 400;
  const settleMs = opts.settleMs ?? 250;
  const maxWaitMs = opts.maxWaitMs ?? 1_500;
  const pageLimit = opts.pageLimit ?? 1024;
  const { space, accountId } = opts;

  // ---- conn A (observer) credential: the last BROKER-PROVEN cache, renewed like conn B's ----
  const obsIsSource = typeof opts.observerCreds === "function";
  const readObs = obsIsSource ? (opts.observerCreds as () => string | Promise<string>) : () => opts.observerCreds as string;
  const initialObs = await Promise.resolve(readObs());
  const obsPin = observerProfile(initialObs);
  // Validate the observer source's renewal window BEFORE any connection or timer exists. Its arm runs
  // after the rw timer is armed, and the startup rollback drains connections only, so a throw there
  // would leave the rw timer live with no handle to stop it. Checked here, the arm below cannot throw.
  if (obsIsSource) credsRenewalDelayMs(initialObs);
  // A renewal keeps the issuer and the authorized profile (permissions, hence the CONNZ account). A
  // changed issuer is a system-account rotation, which this seam never adopts; a different scope
  // would widen or move the observer. Either throws, so nothing is committed.
  const pinObsProfile = (creds: string): string => {
    const p = observerProfile(creds);
    if (p.iss !== obsPin.iss) throw new Error("observer creds re-read returned a different issuer - a renewal may not rotate the system signer; nothing adopted");
    if (p.perms !== obsPin.perms) throw new Error("observer creds re-read returned a different permission scope - a renewal may not change the observer's account or rights; nothing adopted");
    return creds;
  };
  let currentObsCreds = initialObs;
  const refuseExpiredObsCreds = (): void => {
    const exp = credsClaims(currentObsCreds).exp;
    if (typeof exp !== "number" || exp * 1000 > Date.now()) return;
    const why = obsIsSource
      ? "the membership feed's observer creds have expired and renewal is failing - not presenting the expired credential to the broker"
      : "the membership feed's observer creds have expired and the feed holds no observer creds source to renew them - replace the credential and restart the feed";
    log(why);
    throw new Error(why);
  };
  const connectObs = () => connect({
    servers: opts.servers,
    authenticator: (nonce?: string) => { refuseExpiredObsCreds(); return credsAuthenticator(enc(currentObsCreds))(nonce); },
    name: "cotal-membership-observer",
    inboxPrefix: MEMBERSHIP_INBOX_PREFIX, // scoped reply inboxes — the cred only allows `<prefix>.>`
    maxReconnectAttempts: -1,
  });
  let connA = await connectObs();
  opened.push(connA); // the transactional record — `startMembershipFeed` drains this if anything below throws
  connA.closed().then((err) => { if (err) log(`conn A (system) closed: ${err.message}`); });

  // The rw source: async-capable (a hosted `store.get`) or sync (a local FS read / literal). Read ONCE
  // up front to pin conn B's identity and seed the proven cache; thereafter the source is re-read only
  // by a preflight-proven adoption (the 75% timer or the explicit reload), never inside the sync
  // authenticator (nats-core's Authenticator is synchronous and a `store.get` cannot live there).
  const rwIsSource = typeof opts.rwCreds === "function";
  const readRw = rwIsSource ? (opts.rwCreds as () => string | Promise<string>) : () => opts.rwCreds as string;
  const initialRw = await Promise.resolve(readRw());
  const rwSelfId = idFromCreds(initialRw); // conn B's own nkey — the data-account self-presence check below
  // Pin every candidate to the first read's nkey: a renewal (manager re-signs the cred) keeps the
  // identity; a swapped cred would silently break the inbox scope + self-presence check, so it throws
  // (the adoption fails structured and nothing is committed).
  const pinRwIdentity = (creds: string): string => {
    const id = idFromCreds(creds);
    if (id !== rwSelfId) throw new Error(`membership rw creds re-read returned identity ${id}, expected ${rwSelfId} - a renewal may not swap the feed's nkey`);
    return creds;
  };
  // The LAST BROKER-PROVEN rw cred — the ONLY value conn B's synchronous authenticator ever presents.
  // Seeded from the initial fetch (that first connect is its own proof, like the endpoint's initial
  // connect); advanced ONLY by a preflight-proven adoption (the 75% timer or an explicit reload). So an
  // incidental reconnect (broker expiry-close, a network blip) can never present an unproven or
  // broker-refused generation and strand conn B — closing the membership half of the D5 blocker.
  let currentRwCreds = initialRw;
  // Proven when adopted is not unexpired now. The cache only ever advances through a preflight-proven
  // adoption, so it cannot hold an UNPROVEN generation, but the clock alone expires a legitimately
  // proven one. If re-signing has stopped (the manager is down, the store unreachable) and conn B drops
  // after `exp`, the client's own redial presents the expired credential to the broker: a denial that
  // still costs the auth round trip, and one that reports the broker's words instead of the local cause.
  // Refuse here instead, the same pre-dial checkpoint the endpoint raises before its own dial.
  const refuseExpiredRwCreds = (): void => {
    const exp = credsClaims(currentRwCreds).exp;
    if (typeof exp !== "number" || exp * 1000 > Date.now()) return;
    const why = rwIsSource
      ? "the membership feed's rw creds have expired and renewal is failing - not presenting the expired credential to the broker; conn B closed permanently"
      : "the membership feed's rw creds have expired and the feed holds no rw creds source to renew them - replace the credential and restart the feed (pass an rw creds FUNCTION for standing renewal)";
    log(why);
    throw new Error(why);
  };
  // Shared by the initial dial and by a later revive: the authenticator always presents the last
  // BROKER-PROVEN cache, never a fresh un-preflighted source read. The 75% timer / explicit reload
  // advance `currentRwCreds` only AFTER a disposable preflight proves the broker accepts the candidate.
  const connectRw = () => connect({
    servers: opts.servers,
    authenticator: (nonce?: string) => { refuseExpiredRwCreds(); return credsAuthenticator(enc(currentRwCreds))(nonce); },
    name: "cotal-membership-rw",
    // The rw cred's sub.allow is `_INBOX_<id>.>`, so the connection's inbox prefix MUST match it — else
    // every KV reply / ordered-consumer delivery (kv.get/keys/watch) lands on a subject it can't subscribe.
    inboxPrefix: `_INBOX_${rwSelfId}`,
    maxReconnectAttempts: -1,
  });
  let connB = await connectRw();
  opened.push(connB);
  connB.closed().then((err) => { if (err) log(`conn B (data) closed: ${err.message}`); });
  // conn B's own drops, from its status stream. Adopting a renewed rw cred reconnects conn B in place,
  // and until the redial lands the broker has no conn B to report, so a sweep in that window did not
  // miss connections.
  let connBDown = false;
  let connBDrops = 0;
  const watchConnB = (nc: NatsConnection): void => {
    void (async () => {
      for await (const s of nc.status()) {
        if (s.type === "disconnect") { connBDown = true; connBDrops++; }
        else if (s.type === "reconnect") connBDown = false;
      }
    })().catch(() => {});
  };
  watchConnB(connB);

  const kvm = new Kvm(connB);
  let feedKv: KV = await kvm.open(membershipBucket(space));
  let membersKv: KV = await openMembersRegistry(connB, space);

  // ---- conn B standing renewal (D5 class-2): the 75% timer + the explicit reload, both proven ----
  // Mirrors the endpoint's delivery.creds renewal (adoptFreshCreds / renewCredsOnTimer / runCredsTxn).
  // The feed previously had NO credential-refresh timer — only the poll loop and a per-reconnect source
  // re-read; that re-read was the sole self-heal and it presented UNPROVEN bytes. Replaced by a proven
  // cache advanced under a single-flight transaction, plus this timer as the active self-heal.
  let rwStopped = false;
  let rwTimer: ReturnType<typeof setTimeout> | undefined;
  const armRwRefresh = (delayMs: number): void => {
    if (rwStopped) return;
    if (rwTimer) clearTimeout(rwTimer);
    rwTimer = setTimeout(() => void renewRwOnTimer(), Math.max(1_000, delayMs)); // 1s floor: second-scale test TTLs
    rwTimer.unref?.();
  };
  // Single-flight: serialize the 75% timer and the explicit reload over the WHOLE prove-then-adopt
  // transaction (fetch → preflight → commit), so a timer tick can never overwrite the cache with C while
  // an explicit reload is proving B and then reporting B adopted. Runs `fn` after any in-flight txn
  // settles, whatever its outcome; the internal chain never rejects.
  let rwTxn: Promise<unknown> = Promise.resolve();
  const runRwTxn = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = rwTxn.then(fn, fn);
    rwTxn = next.then(() => undefined, () => undefined);
    return next;
  };
  // The one PROVE-then-adopt transaction (run under runRwTxn), shared by the 75% timer and the explicit
  // reload. Fetch (deadline-bounded) → identity-pin → optional expected-generation match → disposable
  // preflight → late-commit fence → advance the proven cache → arm the next 75% timer. `currentRwCreds`
  // is written ONLY after the preflight proves broker acceptance, so a rejected candidate leaves conn B
  // on the last-proven cred. THROWS (structured) on any failure.
  const adoptRwCreds = async (a: { expected?: string; deadline: number }): Promise<{ iat?: number; exp?: number }> => {
    // Fence BEFORE any source I/O: a reload queued behind a hung-store timer tick that already burned the
    // budget fails structured now — it never re-reads the source, preflights, or commits (the absolute
    // deadline was captured at the CALLER's entry, so the queue wait counts against it).
    if (Date.now() > a.deadline)
      throw new Error("reloadRwCreds: the request deadline elapsed while queued behind another credential transaction; nothing adopted");
    const candidate = pinRwIdentity(await withDeadline(Promise.resolve(readRw()), a.deadline - Date.now(), () => new Error("reloadRwCreds: the rw creds source did not return before the daemon deadline; nothing adopted")));
    // Non-material message ON PURPOSE: this text flows to the manager's persisted
    // `RenewalRecord.adoption.error`, so neither the observed nor the expected digest may appear.
    if (a.expected !== undefined && credsFingerprint(candidate) !== a.expected)
      throw new Error("reloadRwCreds: re-read credential generation did not match the expected re-signed generation; nothing adopted");
    // Compute the bounded-window renewal delay BEFORE any commit or preflight: credsRenewalDelayMs throws
    // on a cred lacking a numeric `exp`, and that throw must NOT leave `currentRwCreds` flipped to a
    // candidate the authenticator would then present on the next reconnect (a post-preflight validation
    // failure must be a true no-op on the cache).
    const delay = credsRenewalDelayMs(candidate);
    // An UNCHANGED generation past its own renewal point is a MISSED remint (the renewal owner has not
    // re-signed yet), not a candidate to adopt. Adopting it would recommit the same cred, floor the next
    // timer to 1s (delay <= 0), and reconnect EVERY second for the JWT's remaining 25% of life. Fail it
    // like a renewal error so `renewRwOnTimer` retries at 60s with NO resident reconnect. The explicit
    // reload's `expected` already rejects a stale read; this covers the timer path (no expectation sent).
    //
    // Compared by GENERATION, not by envelope. The envelope carries the nkey seed and is sensitive to
    // formatting (`credsFingerprint`'s own contract says so), and `jwtFromCreds` discards the difference:
    // a store, editor, transport or filesystem round trip that normalises a newline re-serves the SAME
    // generation in bytes `===` calls different, and the refusal below would not fire. Two envelopes
    // differing only in their seed block are the same generation too.
    if (credsFingerprint(candidate) === credsFingerprint(currentRwCreds) && delay <= 0)
      throw new Error("reloadRwCreds: the rw source still holds the previous generation past its renewal point (the renewal owner has not re-signed it - run `cotal doctor auth --fix` or restart the manager); nothing adopted");
    if (!(await brokerAcceptsCreds(opts.servers, candidate, Math.max(500, Math.min(MEMBERSHIP_PREFLIGHT_MS, a.deadline - Date.now())))))
      throw new Error("reloadRwCreds: the broker did not accept the re-signed rw credential; nothing adopted");
    if (Date.now() > a.deadline)
      throw new Error("reloadRwCreds: the proof exceeded the daemon deadline; nothing adopted"); // fence a late commit
    currentRwCreds = candidate; // commit ONLY after identity pin + fingerprint + delay/claims validation + preflight
    armRwRefresh(delay);
    return credsClaims(candidate);
  };
  // Present the proven cache on conn B. An OPEN client reconnects in place (the incidental reconnect
  // of a live feed: nats.js re-evaluates the authenticator, scenario 2). A CLOSED client cannot
  // reconnect — nats-core rejects with ClosedConnectionError — so open a fresh data connection and
  // rebind the KV handles. A revive that cannot land must THROW: the explicit reload surfaces the
  // cause, and the timer path logs it and retries. Half-bound dials are drained before the throw.
  const presentRwCreds = async (): Promise<void> => {
    if (rwStopped) return;
    if (!connB.isClosed()) {
      await connB.reconnect().catch(() => {});
      return;
    }
    let next: NatsConnection;
    try {
      next = await connectRw();
    } catch (e) {
      throw new Error(`reloadRwCreds: could not open a fresh rw connection on the proven credential: ${(e as Error).message}`);
    }
    try {
      const nextKvm = new Kvm(next);
      const nextFeed = await nextKvm.open(membershipBucket(space));
      const nextMembers = await openMembersRegistry(next, space);
      connB = next;
      feedKv = nextFeed;
      membersKv = nextMembers;
      connB.closed().then((err) => { if (err) log(`conn B (data) closed: ${err.message}`); });
      connBDown = false;
      watchConnB(connB);
      // Assign first so a concurrent stop() drains THIS connection rather than the already-closed
      // predecessor. If stop already ran, drain the fresh dial here.
      if (rwStopped) {
        await connB.drain().catch(() => {});
        return;
      }
    } catch (e) {
      await next.drain().catch(() => {});
      throw new Error(`reloadRwCreds: could not rebind the feed on the fresh rw connection: ${(e as Error).message}`);
    }
  };
  // The 75%-of-lifetime renewal tick: prove + adopt + present on conn B. conn B is NOT the
  // delivery-admin rail (that reply rides the delivery endpoint's connection), so the present is inline
  // and a failure just logs + retries while the last-proven cred stays live to its expiry (or, if
  // conn B is already closed, the next successful present revives it).
  async function renewRwOnTimer(): Promise<void> {
    const deadline = Date.now() + MEMBERSHIP_RELOAD_DEADLINE_MS; // captured before the enqueue, like the reload
    try {
      await runRwTxn(async () => {
        await adoptRwCreds({ deadline });
        await presentRwCreds();
      });
    } catch (e) {
      log(`rw creds refresh failed (graph feed writer; delivery unaffected): ${(e as Error).message} - retrying; conn B dies at the current JWT's expiry if renewal keeps failing`);
      armRwRefresh(MEMBERSHIP_CREDS_RETRY_MS);
    }
  }
  // Arm the FIRST 75% timer, but ONLY for a source-fed cred — a literal `rwCreds` string has no renewal
  // seam (nothing re-reads it). A source-fed cred must be bounded (credsRenewalDelayMs is fail-loud on a
  // missing `exp`), which surfaces a misconfigured source at startup rather than silently never renewing.
  if (rwIsSource) armRwRefresh(credsRenewalDelayMs(currentRwCreds));

  // ---- conn A standing renewal: the same prove-then-adopt transaction, for a source-fed observer ----
  // A separate single-flight from conn B's: the two creds have different signers and owners, and a
  // slow store for one must not delay the other. Trigger subscriptions are rebound on a revived conn A.
  let obsTimer: ReturnType<typeof setTimeout> | undefined;
  const armObsRefresh = (delayMs: number): void => {
    if (rwStopped) return;
    if (obsTimer) clearTimeout(obsTimer);
    obsTimer = setTimeout(() => void renewObsOnTimer(), Math.max(1_000, delayMs));
    obsTimer.unref?.();
  };
  let obsTxn: Promise<unknown> = Promise.resolve();
  const runObsTxn = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = obsTxn.then(fn, fn);
    obsTxn = next.then(() => undefined, () => undefined);
    return next;
  };
  const adoptObsCreds = async (deadline: number): Promise<void> => {
    if (rwStopped) throw new Error("observer creds refresh: the feed stopped; nothing adopted");
    const candidate = pinObsProfile(await withDeadline(Promise.resolve(readObs()), deadline - Date.now(), () => new Error("observer creds refresh: the source did not return before the deadline; nothing adopted")));
    const delay = credsRenewalDelayMs(candidate);
    if (credsFingerprint(candidate) === credsFingerprint(currentObsCreds) && delay <= 0)
      throw new Error("observer creds refresh: the source still holds the previous generation past its renewal point (the signer owner has not re-minted it); nothing adopted");
    if (!(await brokerAcceptsCreds(opts.servers, candidate, Math.max(500, Math.min(MEMBERSHIP_PREFLIGHT_MS, deadline - Date.now())))))
      throw new Error("observer creds refresh: the broker did not accept the candidate; nothing adopted");
    if (Date.now() > deadline) throw new Error("observer creds refresh: the proof exceeded the deadline; nothing adopted");
    if (rwStopped) throw new Error("observer creds refresh: the feed stopped during the proof; nothing adopted");
    currentObsCreds = candidate;
    armObsRefresh(delay);
  };
  // Present the proven observer cache on conn A: reconnect in place when open, else open a fresh
  // conn A and rebind the two trigger subscriptions. A revive that cannot land throws.
  const presentObsCreds = async (): Promise<void> => {
    if (rwStopped) return;
    if (!connA.isClosed()) {
      await connA.reconnect().catch(() => {});
      return;
    }
    let next: NatsConnection;
    try {
      next = await connectObs();
    } catch (e) {
      throw new Error(`observer creds refresh: could not open a fresh observer connection on the proven credential: ${(e as Error).message}`);
    }
    connA = next;
    connA.closed().then((err) => { if (err) log(`conn A (system) closed: ${err.message}`); });
    if (rwStopped) {
      await connA.drain().catch(() => {});
      return;
    }
    bindTriggers();
  };
  async function renewObsOnTimer(): Promise<void> {
    const deadline = Date.now() + MEMBERSHIP_RELOAD_DEADLINE_MS;
    try {
      await runObsTxn(async () => {
        await adoptObsCreds(deadline);
        await presentObsCreds();
      });
    } catch (e) {
      if (rwStopped) return;
      log(`observer creds refresh failed (graph membership; delivery unaffected): ${(e as Error).message} - retrying; conn A dies at the current JWT's expiry if renewal keeps failing`);
      armObsRefresh(MEMBERSHIP_CREDS_RETRY_MS);
    }
  }
  if (obsIsSource) armObsRefresh(credsRenewalDelayMs(currentObsCreds));

  let stopped = false;
  let polling = false;
  /** The poll currently running, so {@link stop} can wait for it instead of draining underneath it. */
  let inFlight: Promise<void> | undefined;
  let rerun = false; // a trigger fired mid-poll → run once more after
  let reqSeq = 0;
  let clusterWarned = false; // log the multi-server completeness limit at most once (never fires at N=1)

  /** One CONNZ round: publish the account request, collect every server's reply within the window. */
  async function connzRound(offset: number): Promise<ConnzReply[]> {
    return new Promise<ConnzReply[]>((resolve) => {
      const inbox = `${MEMBERSHIP_INBOX_PREFIX}.${reqSeq++}`;
      const out: ConnzReply[] = [];
      let settle: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (settle) clearTimeout(settle);
        clearTimeout(hard);
        try { sub.unsubscribe(); } catch { /* draining */ }
        resolve(out);
      };
      const sub = connA.subscribe(inbox, {
        callback: (err, msg) => {
          if (err) return;
          try { out.push(msg.json<ConnzReply>()); } catch { /* skip undecodable */ }
          if (settle) clearTimeout(settle);
          settle = setTimeout(finish, settleMs);
        },
      });
      const hard = setTimeout(finish, maxWaitMs);
      connA.publish(connzRequestSubject(accountId), enc(JSON.stringify({ subscriptions: true, auth: true, offset, limit: pageLimit })), { reply: inbox });
    });
  }

  /** Fan-out + per-server pagination + union-dedupe → nkey → live channel-subscription patterns.
   *  God-view taps (a connection holding the whole-chat/space wildcard) are excluded entirely. Returns
   *  `complete:false` for a sweep that didn't fully drain (zero replies = broker unreachable/denied, or a
   *  MAX_PAGES truncation) so the caller can skip the write — a PARTIAL CONNZ read must never prune real
   *  members or stamp a fresh heartbeat (truthium). */
  async function liveFromConnz(): Promise<{ live: Map<string, Set<string>>; complete: boolean }> {
    const live = new Map<string, Set<string>>();
    const serverMore = new Set<string>(); // server ids still reporting a full page this round
    const serversSeen = new Set<string>(); // distinct responders across the whole sweep
    let gotReply = false, exhausted = false, seenSelf = false;
    const dropsBefore = connBDrops;
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * pageLimit;
      const replies = await connzRound(offset);
      if (replies.length === 0) {
        if (page === 0) log(`CONNZ returned no replies (offset 0) - broker unreachable or cred denied; keeping last membership this tick`);
        break;
      }
      gotReply = true;
      serverMore.clear();
      for (const r of replies) {
        const sid = r.server?.id ?? r.data?.server_id ?? "?";
        serversSeen.add(sid);
        const conns = r.data?.connections ?? [];
        for (const c of conns) {
          if (c.authorized_user === rwSelfId) seenSelf = true; // our own conn B must be in a complete read
          addConn(space, live, c);
        }
        const total = r.data?.total ?? conns.length;
        // A server has more ONLY if it returned a FULL page that hasn't reached its total. A short page
        // (len < requested limit) means exhausted regardless of `total` — this is filter-proof: if a
        // server-side filter_subject is ever added, `total` stays the pre-filter account total and
        // `offset+len >= total` would never trip, but the short page still terminates the loop (truthium).
        if (conns.length >= pageLimit && offset + conns.length < total) serverMore.add(sid);
      }
      if (serverMore.size === 0) { exhausted = true; break; }
      if (page === MAX_PAGES - 1)
        log(`CONNZ still paginating after ${MAX_PAGES} pages (servers ${[...serverMore].join(",")}) - UNDER-REPORTING; skipping this sweep`);
    }
    // SELF-PRESENCE completeness check (socrates): the data account ALWAYS holds at least conn B, so a
    // sweep that doesn't even include our own rw connection missed connections (a mid-reconnect blip, or
    // the server hosting conn B staying silent) — treat it as incomplete so reconcile() neither prunes nor
    // restamps. 1-BROKER SCOPE (truthium): this is sufficient at N=1 (canary == full coverage), but only
    // NECESSARY at cluster scale — conn B is pinned to ONE server, so a DIFFERENT silent server's agents
    // would still pass this canary. The sufficient multi-server check is `distinct responding server_ids
    // == expected server count` (expected set discovered via $SYS.REQ.SERVER.PING); deferred with the rest
    // of multi-broker support — a conscious deferral, not a single-server bake-in.
    // A sweep that ran while conn B itself was down (its own reconnect) is still incomplete, but it
    // missed nothing: conn B's return emits a CONNECT event, which polls again.
    if (gotReply && exhausted && !seenSelf && !connBDown && connBDrops === dropsBefore)
      log(`CONNZ sweep omitted our own rw connection - treating as incomplete (keeping last membership)`);
    // NO-SILENT-DEGRADATION (socrates): in a real cluster the conn-B floor only proves conn B's OWN server
    // answered — a DIFFERENT silent server would still pass `complete` yet under-report its agents. Until
    // multi-broker responder-accounting ships, surface that limit LOUDLY (once) rather than degrade quietly.
    if (serversSeen.size > 1 && !clusterWarned) {
      clusterWarned = true;
      log(`multi-server cluster detected (${serversSeen.size} responders) - membership completeness uses the conn-B floor only; a silent peer server can under-report (multi-broker accounting deferred, see core-sub-fabric.md)`);
    }
    return { live, complete: gotReply && exhausted && seenSelf };
  }

  /** The durable arm: open, activated (non-tombstoned) members from the privileged registry. Mirrors
   *  endpoint `channelMembers()` so the daemon's union and the manager surface agree. */
  async function durableFromMembers(): Promise<Map<string, Set<string>>> {
    const durable = new Map<string, Set<string>>();
    for (const r of await listMembers(membersKv)) {
      if (r.leaveCursor !== undefined || r.activated !== true) continue;
      (durable.get(r.owner) ?? durable.set(r.owner, new Set()).get(r.owner)!).add(r.channel);
    }
    return durable;
  }

  async function reconcile(): Promise<void> {
    const { live, complete } = await liveFromConnz();
    // A partial CONNZ sweep (unreachable / truncated) would prune real members and lie about freshness —
    // keep the last good state untouched and don't stamp the heartbeat. Self-heals on the next full poll.
    if (!complete) return;
    const durable = await durableFromMembers();
    const observedAt = Date.now();

    // Merge per agent: CONNZ live patterns ∪ durable concrete channels. An agent with neither is omitted.
    const next = new Map<string, ChannelMembership>();
    for (const id of new Set<string>([...live.keys(), ...durable.keys()])) {
      const liveArr = [...(live.get(id) ?? [])].sort();
      const durableArr = [...(durable.get(id) ?? [])].sort();
      if (liveArr.length === 0 && durableArr.length === 0) continue;
      next.set(id, { live: liveArr, durable: durableArr, observedAt });
    }

    // Diff-before-put on the normalized {live,durable} (NOT observedAt), then prune departed agents — so a
    // quiet poll bumps no revision and wakes no watcher. Feed-wide freshness rides the heartbeat key below.
    const existing = new Set<string>();
    const current = new Map<string, ChannelMembership>();
    for (const e of await liveKvEntries(feedKv)) {
      if (e.key === MEMBERSHIP_FEED_KEY) continue;
      existing.add(e.key);
      try {
        current.set(e.key, e.json<ChannelMembership>());
      } catch {
        /* re-write on garble */
      }
    }
    for (const [id, rec] of next) {
      const key = membershipKey(id);
      existing.delete(key);
      const curRec = current.get(key);
      let same = false;
      if (curRec) {
        try { same = sameMembership(curRec, rec); } catch { /* re-write on garble */ }
      }
      if (!same) await feedKv.put(key, enc(JSON.stringify(rec)));
    }
    for (const stale of existing) await feedKv.delete(stale);

    // Heartbeat: re-stamp every successful poll (even with zero membership change) so the dashboard can
    // distinguish "feed is live" from "feed is stale/dead" — the diff-before-put above would otherwise
    // freeze every observedAt and make a healthy feed read stale.
    await feedKv.put(MEMBERSHIP_FEED_KEY, enc(JSON.stringify({ observedAt, count: next.size })));
  }

  async function poll(): Promise<void> {
    if (stopped) return;
    if (polling) { rerun = true; return; } // a poll is in flight — coalesce, run once more after it
    polling = true;
    // The running poll is held as a PROMISE, not just a boolean, because `stop()` has to await it and a
    // flag cannot be awaited. Every caller drives this through `void poll()` off a timer or a trigger, so
    // without this handle nothing in the process holds the work and teardown cannot wait for it.
    inFlight = (async () => {
      try {
        do {
          rerun = false;
          await reconcile();
        } while (rerun && !stopped);
      } catch (e) {
        log(`poll failed (graph membership degraded; delivery unaffected): ${(e as Error).message}`);
      } finally {
        polling = false;
        inFlight = undefined;
      }
    })();
    await inFlight;
  }

  // Re-poll triggers — debounced. There is NO SUB/UNSUB event, so these only shorten join/leave-the-mesh
  // latency; the interval is the real reconcile. A connect storm coalesces into one debounced poll.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const trigger = () => {
    if (stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void poll(), debounceMs);
  };
  let subConnect: ReturnType<NatsConnection["subscribe"]>;
  let subDisconnect: ReturnType<NatsConnection["subscribe"]>;
  function bindTriggers(): void {
    subConnect = connA.subscribe(accountConnectSubject(accountId), { callback: () => trigger() });
    subDisconnect = connA.subscribe(accountDisconnectSubject(accountId), { callback: () => trigger() });
  }
  bindTriggers();

  const timer = setInterval(() => void poll(), intervalMs);
  await poll(); // first reconcile now

  return {
    poll,
    async reloadRwCreds(expected?: string) {
      // Explicit class-2 adoption for conn B. Capture the ABSOLUTE deadline at ENTRY,
      // before the single-flight enqueue, so a reload queued behind a hung-store 75% tick is bounded by
      // the SAME window (the queue wait counts) and can never commit/swap after the renewal owner's
      // request bound has already elapsed. The prove-then-adopt transaction runs under runRwTxn so it
      // cannot interleave with the timer; the observer conn (A) is rotation-renewed and not reloadable.
      const deadline = Date.now() + MEMBERSHIP_RELOAD_DEADLINE_MS;
      const { iat, exp } = await runRwTxn(async () => {
        const claims = await adoptRwCreds({ expected, deadline });
        await presentRwCreds();
        return claims;
      });
      return { identity: rwSelfId, iat, exp };
    },
    async stop() {
      stopped = true;
      rwStopped = true;
      clearInterval(timer);
      if (rwTimer) clearTimeout(rwTimer);
      if (obsTimer) clearTimeout(obsTimer);
      if (debounce) clearTimeout(debounce);
      try { subConnect.unsubscribe(); subDisconnect.unsubscribe(); } catch { /* draining */ }
      // WAIT FOR THE POLL ALREADY RUNNING, BEFORE THE DRAIN. `stopped` is set above, so the do/while
      // exits after the reconcile in progress rather than starting another; this only waits out the one
      // already in flight. Skipping it drains the connection out from under a live `reconcile()`, which
      // then throws and is logged as `poll failed ... connection closed` — a manufactured error for an
      // ordinary shutdown, printed AFTER the caller believed teardown had finished. That line is not
      // free: it reads as a leak to whoever greps the log next, and it has already cost one
      // investigation. A teardown must not invent evidence.
      //
      // Unbounded on purpose, and stated rather than hidden: a `reconcile()` that never settles hangs
      // `stop()`. The drain below is already unbounded in exactly the same way, so this adds no new class
      // of risk, and a timeout here would silently resume tearing down underneath a live poll, which is
      // the behaviour being removed. `inFlight` never rejects (the poll catches internally), so no
      // `.catch` is needed to keep `stop()` from throwing.
      await inFlight;
      // A refresh already past its stop fence may be opening a replacement conn A or conn B; wait it
      // out so the drain below sees the connection that is actually live. Both chains never reject.
      await Promise.allSettled([obsTxn, rwTxn]);
      await Promise.allSettled([connA.drain(), connB.drain()]);
      // A disconnected drain can reject without closing its reconnect loop. Stop owns both
      // connections even when the broker is gone; neither may reappear after stop resolves.
      await Promise.all([connA.close(), connB.close()]);
    },
  };
}

// ---- internals ----

/** The parts of an observer cred a renewal must keep: its issuer and its whole permission block
 *  (which names the CONNZ account). Unverified claims; the broker preflight is the acceptance proof. */
function observerProfile(creds: string): { iss: string; perms: string } {
  const c = credsClaims(creds);
  if (typeof c.iss !== "string" || c.iss === "") throw new Error("observer creds carry no issuer");
  const p = c.nats ?? {};
  const norm = (x?: { allow?: string[]; deny?: string[] }) => ({ allow: [...(x?.allow ?? [])].sort(), deny: [...(x?.deny ?? [])].sort() });
  return { iss: c.iss, perms: JSON.stringify({ pub: norm(p.pub), sub: norm(p.sub), issuer_account: p.issuer_account ?? null }) };
}

interface ConnzConnection {
  authorized_user?: string;
  subscriptions_list?: string[];
  name?: string;
  tags?: string[];
}
interface ConnzReply {
  server?: { id?: string };
  data?: { server_id?: string; total?: number; offset?: number; limit?: number; connections?: ConnzConnection[] };
}

/** Fold one CONNZ connection into the live map: keyed by the connection's PRINCIPAL dot-form
 *  (`<owner>.<actor>`), recovered via {@link principalFromConnz} — a STATICALLY-minted user surfaces
 *  its `principal:` tag, while a CALLOUT-minted (user-mode) connection surfaces the principal
 *  NAME-form as `authorized_user` and NO tags (nats-server 2.10/2.14 behavior; the live-eviction
 *  work proved a tags-only read misses every user-mode connection — they'd never appear in the
 *  graph). Unions its chat-subscription patterns (wildcards kept, e.g. `team.>` or a whole-chat `>`).
 *  A STATIC user's raw ephemeral nkey `authorized_user` is NOT a principal name-form, so it stays
 *  unattributable — an un-principal connection is DROPPED (fail-closed), never keyed by its nkey,
 *  which would fork one agent into two graph nodes.
 *
 *  Infra taps SELF-EXCLUDE — no shape heuristic needed (review-general, socrates): the web dashboard taps
 *  `cotal.<space>.>` (spaceWildcard) and `cotal console` taps `cotal.<space>.chat.>` (chatWildcard), both
 *  of which {@link channelFromChatSubscription} maps to `null` (the former isn't `.chat.`-prefixed; the
 *  latter has no channel token after `chat.`), so they contribute zero channels here; conn B / the
 *  delivery cred / the manager hold no chat sub at all. The ONLY subscription that yields the whole-chat
 *  `>` pattern is an AGENT's own `chat.*.*.>` (allowSubscribe `[">"]` — e.g. the default persona), which is
 *  a legitimate broad reader the feed MUST surface (the source-of-truth goal), NOT drop. So no shape-based
 *  exclusion: a `>` pattern is recorded as-is and the dashboard renders it as a "reads-all" node (a badge,
 *  not a spoke to every hub) rather than expanding it. */
function addConn(space: string, live: Map<string, Set<string>>, c: ConnzConnection): void {
  const subs = c.subscriptions_list ?? [];
  const id = principalFromConnz(c); // tag (static) OR authorized_user name-form (callout) — see doc above
  if (!id) return; // no attributable principal (open mode / legacy / infra) — not a member here
  const patterns = subs
    .map((s) => channelFromChatSubscription(space, s))
    .filter((x): x is string => x !== null);
  if (patterns.length === 0) return; // connected but subscribed to no channel — member of nothing
  const set = live.get(id) ?? live.set(id, new Set()).get(id)!;
  for (const p of patterns) set.add(p);
}

/** Equal on the normalized membership (sorted live + durable), IGNORING `observedAt` — the diff that
 *  decides whether a poll re-writes an agent's key (so a quiet poll wakes no watcher). */
function sameMembership(a: ChannelMembership, b: ChannelMembership): boolean {
  return arrEq(a.live, b.live) && arrEq(a.durable, b.durable);
}
function arrEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
