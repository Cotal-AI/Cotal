import { CotalEndpoint, isReachable, mintCreds, newIdentity, type SpaceAuth } from "@cotal-ai/core";

/**
 * The names of the peers live on a mesh now, or undefined when the mesh does not answer. It connects
 * an invisible presence watcher, lets the roster settle and snapshots it, so the answer is advisory:
 * two callers can still race onto one name. Reading presence in auth mode needs a credential (the
 * bucket is open only to agents), so it mints a short-lived least-privilege operator one.
 */
export async function liveMeshNames({ space, server, auth }: { space: string; server: string; auth?: SpaceAuth }): Promise<Set<string> | undefined> {
  const creds = auth ? await mintCreds(auth, newIdentity(), "operator") : undefined;
  if (!(await isReachable(server, { creds }))) return undefined;
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false, // an invisible probe: do not add ourselves to the roster we read
    watchPresence: true,
    card: { name: "name-probe", kind: "endpoint" },
  });
  ep.on("error", () => {}); // advisory: a presence-read hiccup never blocks the caller
  const ignoreNameProbeWarning = () => {};
  ep.on("warning", ignoreNameProbeWarning); // deliberate: this best-effort probe never owns the caller's success
  await ep.start();
  try {
    // Presence replays from the KV bucket right after connect; settle until the roster count holds
    // steady across two polls (≤1s), then snapshot the names of the peers that are actually live.
    let prev = -1;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const n = ep.getRoster().length;
      if (n === prev) break;
      prev = n;
    }
    return new Set(ep.getRoster().filter((p) => p.status !== "offline").map((p) => p.card.name));
  } finally {
    await ep.stop();
  }
}
