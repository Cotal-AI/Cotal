/**
 * Live-mesh helpers for `cotal spawn -f` — the network half: a transient, invisible probe endpoint
 * for reading the roster + membership feed, and the control calls that drive the running manager's
 * `launch` op — admin tier for a static operator deploy, PRIVILEGED tier for a user-mode
 * deployer-view deploy (the manager's owner-equality authorization governs there). (Channel-registry
 * reads use `readChannelRegistry`, which connects itself.)
 */
import { CotalEndpoint, CONTROL_ADMIN, type ControlReply, type ControlTier, type MeshLaunchSpec, type Presence } from "@cotal-ai/core";
import { START_TIMEOUT_MS } from "../control.js";

export interface MeshConn {
  space: string;
  server: string;
  creds?: string;
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

/** Poll the manager's control plane until it answers `ps` — it may have just been started detached,
 *  so it needs a moment to connect + come up. Returns false on timeout. `tier` matches the caller's
 *  deploy credential (admin for static, privileged for the user-mode deployer view). */
export async function waitManagerReady(ep: CotalEndpoint, timeoutMs = 20_000, tier: ControlTier = CONTROL_ADMIN): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await ep.requestControl(tier, { op: "ps" });
      if (r.ok) return true;
    } catch {
      /* manager not answering yet */
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

/** Ask the running manager to launch one resolved agent from the run spec — on the ADMIN tier for
 *  a static operator deploy (the `launch` op is operator-only there; a spawn-capable agent must
 *  not reach it), on the PRIVILEGED tier for a user-mode deployer-view deploy (the manager
 *  enforces spec-owner === caller-owner). The manager derives `.cotal/run/<runId>.json` itself;
 *  we pass the runId, never a path. When the serving manager lives in ANOTHER checkout/host, pass
 *  `spec` and the resolved spec rides the control plane inline — the manager validates it as
 *  untrusted input and persists it under its own run tree before launching. */
export async function launchAgent(ep: CotalEndpoint, runId: string, name: string, tier: ControlTier = CONTROL_ADMIN, spec?: MeshLaunchSpec): Promise<ControlReply> {
  // #159 B1: `launch` funnels into the same startAgent readiness wait as `start` — the manager
  // replies only on a real outcome (join / exit / ~30s backstop), so the request must outlive it.
  return ep.requestControl(tier, { op: "launch", args: { runId, name, ...(spec ? { spec } : {}) } }, START_TIMEOUT_MS);
}
