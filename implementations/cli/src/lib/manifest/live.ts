/**
 * Live-mesh helpers for `cotal spawn -f` — the network half: a transient, invisible probe endpoint
 * for reading the roster + membership feed, and the manager calls that drive the running manager's
 * `launch`/`ps` — over the v0.4 ep rails (1c.2c): the deployer credential/view carries the
 * tier-matched instrument rows (static = admin set; user-mode deployer view = privileged set + an
 * owner-equality `launch` row, the manager's ledger-derived admin flag governs). (Channel-registry
 * reads use `readChannelRegistry`, which connects itself.)
 */
import { CotalEndpoint, EpEnvelopeError, type ControlReply, type Presence } from "@cotal-ai/core";
import { START_TIMEOUT_MS } from "../control.js";

export interface MeshConn {
  space: string;
  server: string;
  creds?: string;
  /** The deploy credential's v0.4 lifecycle uid (static: the instrument mint's; user: the
   *  bearer's ledger claim) — the probe endpoint's caller triple is keyed on it. */
  lifecycleUid?: string;
  /** User mode: the "deployer" VIEW material — a bearer SOURCE (a deploy spans several ≤5-min
   *  token lives across launch readiness waits) + sentinel + the pinned principal a source-mode
   *  endpoint requires. */
  user?: { source: () => Promise<string>; sentinelCreds: string; owner: string; actor: string };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Connect a transient, presence-invisible endpoint (it watches the roster but doesn't register
 *  itself) used to read live state + drive control. The caller stops it. */
export async function connectProbe(conn: MeshConn): Promise<CotalEndpoint> {
  const ep = new CotalEndpoint({
    space: conn.space,
    servers: conn.server,
    ...(conn.user
      ? {
          bearer: conn.user.source,
          sentinelCreds: conn.user.sentinelCreds,
          card: { owner: conn.user.owner, actor: conn.user.actor, name: "spawn-f", kind: "endpoint" as const },
        }
      : { creds: conn.creds, card: { name: "spawn-f", kind: "endpoint" as const } }),
    lifecycleUid: conn.lifecycleUid,
    channels: [],
    consume: false,
    registerPresence: false, // an invisible probe — don't add ourselves to the roster we read
    watchPresence: true,
  });
  ep.on("error", () => {}); // a presence/control hiccup must never crash the deploy
  await ep.start();
  return ep;
}

/** Let the presence KV replay settle (roster count steady across two polls, ≤1s), then snapshot the
 *  live peers — mirrors the dedup probe in `cotal spawn`. */
export async function settleRoster(ep: CotalEndpoint): Promise<Presence[]> {
  let prev = -1;
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    const n = ep.getRoster().length;
    if (n === prev) break;
    prev = n;
  }
  return ep.getRoster();
}

/** Poll the manager until it answers `ps` on the ep rails — it may have just been started
 *  detached, so it needs a moment to connect, register its service, and come up. Returns false on
 *  timeout. The deploy credential's instrument rows carry the read regardless of tier. */
export async function waitManagerReady(ep: CotalEndpoint, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await ep.invokeService("manager", "ps", undefined, { deadlineMs: 4_000 });
      if (r.reply.ok === true) return true;
    } catch {
      /* manager not answering / not registered yet */
    }
    await sleep(500);
  }
  return false;
}

/** Poll until the manager lease for this space is GONE (a crashed holder's key lingers until the bucket
 *  TTL). Returns true once absent, false on timeout. `spawn -f` uses this to wait out a STALE lease
 *  before standing up a replacement — a held lease alone is not proof a manager is alive. */
export async function waitLeaseGone(ep: CotalEndpoint, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await ep.readManagerLease())) return true;
    await sleep(1000);
  }
  return !(await ep.readManagerLease());
}

/** Ask the running manager to launch one resolved agent from the run spec — the v0.4 `launch`
 *  command, capability-only: a static deploy credential holds it via the admin instrument set (a
 *  spawn-capable agent holds no row at all), a user-mode deployer view holds the owner-equality
 *  variant (the manager's ledger-derived admin flag keeps spec-owner === caller-owner there). The
 *  manager derives `.cotal/run/<runId>.json` itself; we pass the runId, never a path. */
export async function launchAgent(ep: CotalEndpoint, runId: string, name: string): Promise<ControlReply> {
  // #159 B1: `launch` funnels into the same startAgent readiness wait as `start` — the manager
  // replies only on a real outcome (join / exit / ~30s backstop), so the request must outlive it.
  try {
    const r = await ep.invokeService("manager", "launch", { runId, name }, { deadlineMs: START_TIMEOUT_MS });
    if (r.reply.ok !== true) return { ok: false, error: r.reply.error?.message ?? r.reply.error?.code ?? "launch failed" };
    return { ok: true, ...(r.reply.data !== undefined ? { data: r.reply.data } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message };
  }
}
