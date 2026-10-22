/**
 * Live-mesh helpers for manifest runs: a transient, invisible probe endpoint that `down -f` uses to
 * read the roster and drive the running manager, and the manager's `launch` call. Both go over the
 * v0.4 ep rails: the deployer credential or view carries the tier-matched instrument rows (static =
 * admin set; user-mode deployer view = privileged set + an owner-equality `launch` row, the
 * manager's ledger-derived admin flag governs). Channel-registry reads use `readChannelRegistry`,
 * which connects itself.
 */
import { CotalEndpoint, EpEnvelopeError, controlReplyFrom, controlReplyFromThrown, type ControlReply, type MeshLaunchSpec } from "@cotal-ai/core";
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
  // A recoverable bearer refresh failure must remain visible during a long user-mode deploy even
  // though this advisory probe never blocks the operation on its side channel.
  ep.on("warning", (e: Error) => console.error(`! spawn-f probe: ${e.message}`));
  await ep.start();
  return ep;
}

/** Ask the running manager to launch one resolved agent from the run spec — the v0.4 `launch`
 *  command, capability-only: a static deploy credential holds it via the admin instrument set (a
 *  spawn-capable agent holds no row at all), a user-mode deployer view holds the owner-equality
 *  variant (the manager's ledger-derived admin flag keeps spec-owner === caller-owner there). The
 *  manager derives `.cotal/run/<runId>.json` itself; we pass the runId, never a path. When the
 *  serving manager lives in ANOTHER checkout/host, pass `spec` and the resolved spec rides the
 *  control plane inline — the manager validates it as untrusted input and persists it under its own
 *  run tree before launching. */
export async function launchAgent(ep: CotalEndpoint, runId: string, name: string, spec?: MeshLaunchSpec): Promise<ControlReply> {
  // #159 B1: `launch` funnels into the same startAgent readiness wait as `start` — the manager
  // replies only on a real outcome (join / exit / ~30s backstop), so the request must outlive it.
  try {
    // P2 item 2 (2b): launch is an ACTION — follow the acceptance to the terminal so a manifest
    // launch still returns on the real outcome (join / exit / ~30s uncertain), UX unchanged.
    const r = await ep.invokeService("manager", "launch", { runId, name, ...(spec ? { spec } : {}) }, { deadlineMs: START_TIMEOUT_MS, follow: true });
    return controlReplyFrom(r.reply);
  } catch (e) {
    return e instanceof EpEnvelopeError ? controlReplyFromThrown(e, `${e.code}: ${e.message}`) : { ok: false, error: (e as Error).message };
  }
}
