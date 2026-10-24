import { PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { isAccountNkey, isUserNkey } from "./identity.js";

/** Native NATS service imported into each account by a configured system account. It reports
 *  the requesting connection, not an arbitrary user/account selected in a payload. */
export const BROKER_USER_INFO_SUBJECT = "$SYS.REQ.USER.INFO";

export type BrokerConnectionIdentityObservation =
  | { state: "matched"; user: string; account: string; serverId: string; effectivePermissionsVerified: false; applyAuthorityEstablished: false }
  | { state: "permission-denied" | "target-mismatch" | "observation-failed"; effectivePermissionsVerified: false; applyAuthorityEstablished: false };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One bounded native self query on an existing connection. No system-account credential,
 *  alternate connection, grant derivation, renewal or retry. Reply permissions/expiry/metadata
 *  are not copied or treated as an effective ceiling, generation or lifecycle proof. */
export async function observeBrokerConnectionIdentity(nc: Pick<NatsConnection, "request" | "info">, expected: { user: string; account: string }): Promise<BrokerConnectionIdentityObservation> {
  const base = { effectivePermissionsVerified: false as const, applyAuthorityEstablished: false as const };
  const serverId = nc.info?.server_id, user = expected.user, account = expected.account;
  if (!isUserNkey(user) || !isAccountNkey(account) || typeof serverId !== "string" || !serverId || serverId.length > 256 || /[\u0000-\u001f\u007f]/u.test(serverId)) throw new Error("native self-identity observation requires validated public user/account pins and one connected server identity; no query was submitted");
  try {
    const reply = await nc.request(BROKER_USER_INFO_SUBJECT, new Uint8Array(), { timeout: 5000 });
    if (reply.data.byteLength > 65536) return { ...base, state: "observation-failed" };
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.data));
    if (!object(value)) return { ...base, state: "observation-failed" };
    if (value.error !== undefined) return { ...base, state: object(value.error) && value.error.code === 403 ? "permission-denied" : "observation-failed" };
    if (!object(value.server) || !object(value.data)) return { ...base, state: "observation-failed" };
    if (nc.info?.server_id !== serverId || value.server.id !== serverId || value.data.user !== user || value.data.account !== account) return { ...base, state: "target-mismatch" };
    return { ...base, state: "matched", user, account, serverId };
  } catch (error) { return { ...base, state: error instanceof PermissionViolationError ? "permission-denied" : "observation-failed" }; }
}
