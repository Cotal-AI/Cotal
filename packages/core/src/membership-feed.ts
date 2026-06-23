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
} from "./subjects.js";
import { openMembersRegistry, listMembers } from "./members.js";
import { idFromCreds } from "./identity.js";
import type { ChannelMembership } from "./types.js";

export interface MembershipFeedOpts {
  servers: string;
  space: string;
  /** DATA account public key — the CONNZ request + CONNECT/DISCONNECT event subjects pin this account. */
  accountId: string;
  /** Scoped SYSTEM-account observer creds (conn A — CONNZ reader). */
  observerCreds: string;
  /** Scoped DATA-account read/write creds (conn B — members read + feed write). */
  rwCreds: string;
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
  stop(): Promise<void>;
}

const enc = (s: string) => new TextEncoder().encode(s);
const MAX_PAGES = 64; // fan-out pagination guard (64 × 1024 = 65k conns/server before a loud under-report)

/** Connect, wire the triggers + safety poll, and run an immediate first reconcile. */
export async function startMembershipFeed(opts: MembershipFeedOpts): Promise<MembershipFeedHandle> {
  const log = opts.log ?? ((m: string) => console.error(`! membership: ${m}`));
  const intervalMs = opts.intervalMs ?? 15_000;
  const debounceMs = opts.debounceMs ?? 400;
  const settleMs = opts.settleMs ?? 250;
  const maxWaitMs = opts.maxWaitMs ?? 1_500;
  const pageLimit = opts.pageLimit ?? 1024;
  const { space, accountId } = opts;

  const connA = await connect({
    servers: opts.servers,
    authenticator: credsAuthenticator(enc(opts.observerCreds)),
    name: "cotal-membership-observer",
    inboxPrefix: MEMBERSHIP_INBOX_PREFIX, // scoped reply inboxes — the cred only allows `<prefix>.>`
    maxReconnectAttempts: -1,
  });
  connA.closed().then((err) => { if (err) log(`conn A (system) closed: ${err.message}`); });

  const rwSelfId = idFromCreds(opts.rwCreds); // conn B's own nkey — the data-account self-presence check below
  const connB = await connect({
    servers: opts.servers,
    authenticator: credsAuthenticator(enc(opts.rwCreds)),
    name: "cotal-membership-rw",
    // The rw cred's sub.allow is `_INBOX_<id>.>`, so the connection's inbox prefix MUST match it — else
    // every KV reply / ordered-consumer delivery (kv.get/keys/watch) lands on a subject it can't subscribe.
    inboxPrefix: `_INBOX_${rwSelfId}`,
    maxReconnectAttempts: -1,
  });
  connB.closed().then((err) => { if (err) log(`conn B (data) closed: ${err.message}`); });

  const kvm = new Kvm(connB);
  const feedKv: KV = await kvm.open(membershipBucket(space));
  const membersKv: KV = await openMembersRegistry(connB, space);

  let stopped = false;
  let polling = false;
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
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * pageLimit;
      const replies = await connzRound(offset);
      if (replies.length === 0) {
        if (page === 0) log(`CONNZ returned no replies (offset 0) — broker unreachable or cred denied; keeping last membership this tick`);
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
        log(`CONNZ still paginating after ${MAX_PAGES} pages (servers ${[...serverMore].join(",")}) — UNDER-REPORTING; skipping this sweep`);
    }
    // SELF-PRESENCE completeness check (socrates): the data account ALWAYS holds at least conn B, so a
    // sweep that doesn't even include our own rw connection missed connections (a mid-reconnect blip, or
    // the server hosting conn B staying silent) — treat it as incomplete so reconcile() neither prunes nor
    // restamps. 1-BROKER SCOPE (truthium): this is sufficient at N=1 (canary == full coverage), but only
    // NECESSARY at cluster scale — conn B is pinned to ONE server, so a DIFFERENT silent server's agents
    // would still pass this canary. The sufficient multi-server check is `distinct responding server_ids
    // == expected server count` (expected set discovered via $SYS.REQ.SERVER.PING); deferred with the rest
    // of multi-broker support — a conscious deferral, not a single-server bake-in.
    if (gotReply && exhausted && !seenSelf)
      log(`CONNZ sweep omitted our own rw connection — treating as incomplete (keeping last membership)`);
    // NO-SILENT-DEGRADATION (socrates): in a real cluster the conn-B floor only proves conn B's OWN server
    // answered — a DIFFERENT silent server would still pass `complete` yet under-report its agents. Until
    // multi-broker responder-accounting ships, surface that limit LOUDLY (once) rather than degrade quietly.
    if (serversSeen.size > 1 && !clusterWarned) {
      clusterWarned = true;
      log(`multi-server cluster detected (${serversSeen.size} responders) — membership completeness uses the conn-B floor only; a silent peer server can under-report (multi-broker accounting deferred, see core-sub-fabric.md)`);
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
    for await (const k of await feedKv.keys()) if (k !== MEMBERSHIP_FEED_KEY) existing.add(k);
    for (const [id, rec] of next) {
      const key = membershipKey(id);
      existing.delete(key);
      const cur = await feedKv.get(key);
      let same = false;
      if (cur && cur.operation !== "DEL" && cur.operation !== "PURGE") {
        try { same = sameMembership(cur.json<ChannelMembership>(), rec); } catch { /* re-write on garble */ }
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
    try {
      do {
        rerun = false;
        await reconcile();
      } while (rerun && !stopped);
    } catch (e) {
      log(`poll failed (graph membership degraded; delivery unaffected): ${(e as Error).message}`);
    } finally {
      polling = false;
    }
  }

  // Re-poll triggers — debounced. There is NO SUB/UNSUB event, so these only shorten join/leave-the-mesh
  // latency; the interval is the real reconcile. A connect storm coalesces into one debounced poll.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const trigger = () => {
    if (stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void poll(), debounceMs);
  };
  const subConnect = connA.subscribe(accountConnectSubject(accountId), { callback: () => trigger() });
  const subDisconnect = connA.subscribe(accountDisconnectSubject(accountId), { callback: () => trigger() });

  const timer = setInterval(() => void poll(), intervalMs);
  await poll(); // first reconcile now

  return {
    poll,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      try { subConnect.unsubscribe(); subDisconnect.unsubscribe(); } catch { /* draining */ }
      await Promise.allSettled([connA.drain(), connB.drain()]);
    },
  };
}

// ---- internals ----

interface ConnzConnection {
  authorized_user?: string;
  subscriptions_list?: string[];
  name?: string;
}
interface ConnzReply {
  server?: { id?: string };
  data?: { server_id?: string; total?: number; offset?: number; limit?: number; connections?: ConnzConnection[] };
}

/** Fold one CONNZ connection into the live map: keyed by `authorized_user` (the nkey = `card.id`),
 *  unioning its chat-subscription patterns (wildcards kept, e.g. `team.>` or a whole-chat `>`).
 *
 *  Infra taps SELF-EXCLUDE — no shape heuristic needed (review-general, socrates): the web dashboard taps
 *  `cotal.<space>.>` (spaceWildcard) and `cotal console` taps `cotal.<space>.chat.>` (chatWildcard), both
 *  of which {@link channelFromChatSubscription} maps to `null` (the former isn't `.chat.`-prefixed; the
 *  latter has no channel token after `chat.`), so they contribute zero channels here; conn B / the
 *  delivery cred / the manager hold no chat sub at all. The ONLY subscription that yields the whole-chat
 *  `>` pattern is an AGENT's own `chat.*.>` (allowSubscribe `[">"]` — e.g. the default persona), which is
 *  a legitimate broad reader the feed MUST surface (the source-of-truth goal), NOT drop. So no shape-based
 *  exclusion: a `>` pattern is recorded as-is and the dashboard renders it as a "reads-all" node (a badge,
 *  not a spoke to every hub) rather than expanding it. */
function addConn(space: string, live: Map<string, Set<string>>, c: ConnzConnection): void {
  const subs = c.subscriptions_list ?? [];
  const id = c.authorized_user;
  if (!id) return; // no authenticated identity (open mode) — best-effort handled at the dashboard, not here
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
