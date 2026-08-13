/**
 * Refuse to run a smoke against anything but a throwaway loopback broker.
 *
 * #286's smokes do not merely READ the broker: they issue `STREAM.UPDATE` against presence and
 * lease KV buckets. Pointed at the live mesh that is a config write to the buckets every agent's
 * liveness depends on — including the supervision loop that would have to notice the damage. The
 * blast radius is the reason this is a guard and not a convention.
 *
 * It is a CALL, made before the first connection, rather than a rule someone remembers at 2am:
 * a smoke that forgets to call it is the failure mode, so callers put it first and a reviewer can
 * grep for it. Loopback-only (not merely "not the production host") because the next careless
 * target is some other reachable broker, not this one hostname.
 */

/** Hosts that must never be reached by a smoke, named so the failure is unmistakable. */
const LIVE_HOSTS = ["broker.cotal.ai"];

/** Broker coordinates a Cotal client resolves from the environment when not told otherwise. */
const AMBIENT_KEYS = ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"] as const;

/**
 * Remove the ambient broker coordinates from this process (and therefore from every child it
 * spawns), returning what was cleared.
 *
 * {@link assertEphemeralBroker} can only judge a URL somebody hands it. An operator environment
 * carries `COTAL_SERVERS` pointing at the LIVE broker, so a suite that spawns the real CLI, or any
 * client that resolves its target from the environment, reaches production without the fence ever
 * being consulted. The URL check is not weakened by this — it is simply blind to the case, because
 * no URL is passed at all.
 *
 * SCRUB BEFORE ASSERT, and before the first child: asserting a URL says nothing about what a child
 * reads from the environment behind it, and a child that has already inherited the live coordinates
 * cannot be un-told them.
 */
export function scrubAmbientBrokerEnv(): string[] {
  const cleared: string[] = [];
  for (const k of AMBIENT_KEYS) {
    if (process.env[k] !== undefined) { cleared.push(k); delete process.env[k]; }
  }
  return cleared;
}

/**
 * Assert `servers` is a throwaway loopback broker. Throws (never warns) — a smoke that cannot
 * prove its target is disposable must not proceed to open a connection.
 */
export function assertEphemeralBroker(servers: string): void {
  const targets = servers.split(",").map((s) => s.trim()).filter(Boolean);
  // FAIL CLOSED ON NOTHING. An empty or whitespace-only value yielded an empty list, so the loop
  // below ran zero times and the function RETURNED — a guard whose only purpose is to refuse,
  // silently allowing. `process.env.COTAL_SERVERS ?? ""` produces exactly this value, which is the
  // shape a caller reaches for when the ambient variable has been scrubbed.
  if (targets.length === 0)
    throw new Error(
      "REFUSING TO RUN: no broker target given. These smokes issue STREAM.UPDATE on presence/lease " +
        "buckets and must be told, explicitly, which throwaway broker to touch — an empty target is " +
        "not a safe default, it is an unanswered question.",
    );

  for (const raw of targets) {
    // `new URL` needs a scheme; NATS URLs may omit it (`127.0.0.1:4222`).
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `nats://${raw}`);
    // Lowercased and stripped of a trailing root dot before comparison: DNS is case-insensitive and
    // `broker.cotal.ai.` resolves identically to `broker.cotal.ai`, so `BROKER.COTAL.AI` and the
    // FQDN form reach the same host while missing an exact-match denylist. The loopback rule below
    // refuses them either way, but the operator would get the generic message instead of being told
    // they had just aimed a bucket rewrite at production.
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");

    if (LIVE_HOSTS.includes(host))
      throw new Error(
        `REFUSING TO RUN: smoke target "${raw}" is the LIVE broker (${host}). These smokes issue ` +
          `STREAM.UPDATE on presence/lease buckets; against the live mesh that rewrites the config ` +
          `every agent's liveness depends on. Use an ephemeral loopback broker from a scratch dir.`,
      );

    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost")
      throw new Error(
        `REFUSING TO RUN: smoke target "${raw}" is not a loopback broker (host "${host}"). These ` +
          `smokes issue STREAM.UPDATE on presence/lease buckets and must only ever touch a ` +
          `throwaway broker they started themselves.`,
      );
  }
}
