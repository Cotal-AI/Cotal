import { connect } from "@nats-io/transport-node";
import { connzRequestSubject, MEMBERSHIP_INBOX_PREFIX, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, standaloneConnectOpts, type SpaceAuth } from "@cotal-ai/core";

/** Broker-side connection/interest facts. No argv, process names or secrets returned. */
export async function nativeAccountConnections(auth: SpaceAuth, servers: string) {
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds: await mintMembershipObserverCreds(auth, newIdentity()), tls: false }), inboxPrefix: MEMBERSHIP_INBOX_PREFIX });
  try {
    const inbox = `${MEMBERSHIP_INBOX_PREFIX}.${mintLifecycleUid()}`;
    const sub = nc.subscribe(inbox, { max: 1 });
    const reply = (async () => { for await (const m of sub) return m.json<{ data?: { connections?: Array<{ cid?: number; authorized_user?: string; subscriptions_list?: string[] }> } }>(); throw new Error("broker connection observation ended without a response"); })();
    nc.publish(connzRequestSubject(auth.account.pub), new TextEncoder().encode(JSON.stringify({ subscriptions: true, auth: true, limit: 512 })), { reply: inbox });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([reply, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native broker connection observation timed out")), 5000); })]).finally(() => { clearTimeout(timer); sub.unsubscribe(); });
    const rows = result.data?.connections;
    if (!rows || !rows.some((row) => Array.isArray(row.subscriptions_list))) throw new Error("broker omitted native subscription inventory");
    if (!rows.every((row) => typeof row.authorized_user === "string" && Number.isSafeInteger(row.cid))) throw new Error("broker omitted connection auth identities or connection IDs");
    return rows.map((row) => ({ cid: row.cid!, user: row.authorized_user!, subscriptions: row.subscriptions_list ?? [] }));
  } finally { await nc.close(); }
}
