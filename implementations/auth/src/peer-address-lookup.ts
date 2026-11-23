import { peerAddressLookupFilter, parsePrincipalKey } from "@cotal-ai/core";
import type { NatsConnection } from "@nats-io/transport-node";
import { openLifecycleMappingReader, readLifecycleMappingLeader } from "./lifecycle-registry.js";

/** Serve the addressable incarnation only. Ordinary members cannot read the underlying records. */
export async function servePeerAddressLookup(nc: NatsConnection, space: string, ready: () => void): Promise<() => void> {
  const reader = await openLifecycleMappingReader(nc, space);
  const sub = nc.subscribe(peerAddressLookupFilter(space), { queue: "peer-address", callback: (error, msg) => {
    if (error || !msg.reply?.startsWith(`${msg.subject}.reply.`) || !/^[0-9a-f-]{36}$/.test(msg.reply.slice(msg.subject.length + 7))) return;
    const id = msg.string();
    if (id.length > 129) return;
    const principal = parsePrincipalKey(id);
    if (!principal) return;
    void (async () => {
      let payload: string;
      try {
        ready();
        const row = await readLifecycleMappingLeader(reader, principal.owner, principal.actor);
        ready();
        payload = JSON.stringify({ id, lifecycleUid: row?.mapping.state === "active" ? row.mapping.lifecycleUid : null });
      } catch {
        payload = JSON.stringify({ id, unavailable: true });
      }
      try { msg.respond(payload); } catch { /* connection closed */ }
    })();
  } });
  await nc.flush();
  return () => sub.unsubscribe();
}
