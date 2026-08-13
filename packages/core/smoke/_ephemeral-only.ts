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

/**
 * Assert `servers` is a throwaway loopback broker. Throws (never warns) — a smoke that cannot
 * prove its target is disposable must not proceed to open a connection.
 */
export function assertEphemeralBroker(servers: string): void {
  for (const raw of servers.split(",").map((s) => s.trim()).filter(Boolean)) {
    // `new URL` needs a scheme; NATS URLs may omit it (`127.0.0.1:4222`).
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `nats://${raw}`);
    const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

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
