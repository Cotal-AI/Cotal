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
  spaceWildcard,
  chatWildcard,
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

  const connB = await connect({
    servers: opts.servers,
    authenticator: credsAuthenticator(enc(opts.rwCreds)),
    name: "cotal-membership-rw",
    // The rw cred's sub.allow is `_INBOX_<id>.>`, so the connection's inbox prefix MUST match it — else
    // every KV reply / ordered-consumer delivery (kv.get/keys/watch) lands on a subject it can't subscribe.
    inboxPrefix: `_INBOX_${idFromCreds(opts.rwCreds)}`,
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
   *  God-view taps (a connection holding the whole-chat/space wildcard) are excluded entirely. */
  async function liveFromConnz(): Promise<Map<string, Set<string>>> {
    const live = new Map<string, Set<string>>();
    const serverMore = new Set<string>(); // server ids still reporting a full page this round
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * pageLimit;
      const replies = await connzRound(offset);
      if (replies.length === 0) {
        if (page === 0) log(`CONNZ returned no replies (offset 0) — broker unreachable or cred denied; membership not refreshed this tick`);
        break;
      }
      serverMore.clear();
      for (const r of replies) {
        const sid = r.server?.id ?? r.data?.server_id ?? "?";
        const conns = r.data?.connections ?? [];
        for (const c of conns) addConn(space, live, c);
        const total = r.data?.total ?? conns.length;
        if (offset + conns.length < total) serverMore.add(sid);
      }
      if (serverMore.size === 0) break;
      if (page === MAX_PAGES - 1)
        log(`CONNZ still paginating after ${MAX_PAGES} pages (servers ${[...serverMore].join(",")}) — UNDER-REPORTING membership`);
    }
    return live;
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
    const live = await liveFromConnz();
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
 *  unioning its chat-subscription patterns. A connection holding a whole-chat/space god-view wildcard is
 *  an infra tap (the web dashboard, a core tap) — excluded entirely so it never renders as a member of
 *  every channel. The daemon's own conn B + the delivery cred carry no chat sub, so they contribute
 *  nothing on their own. */
function addConn(space: string, live: Map<string, Set<string>>, c: ConnzConnection): void {
  const subs = c.subscriptions_list ?? [];
  const isGodTap = subs.some(
    (s) => s === spaceWildcard(space) || s === chatWildcard(space) || channelFromChatSubscription(space, s) === ">",
  );
  if (isGodTap) return;
  const id = c.authorized_user;
  if (!id) return; // no authenticated identity (open mode) — best-effort handled at the dashboard, not here
  const patterns = subs
    .map((s) => channelFromChatSubscription(space, s))
    .filter((x): x is string => x !== null && x !== ">");
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
