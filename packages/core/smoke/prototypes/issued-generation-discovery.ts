import type { NatsConnection } from "@nats-io/transport-node";
import { evidenceKey, type IssuedRef } from "./issued-authority-lifecycle.js";

// Candidate client acquisition of the accepted generation, for isolated tests only.
// The answer comes from the server's view of the connection, never from what the client asked for.
export const ISSUED_DISCOVERY_GRANT = "$SYS.REQ.USER.INFO";

function refFromRow(space: string, row: string): IssuedRef | undefined {
  const parts = row.split(" ")[0].split(".");
  if (parts.length < 9 || parts[0] !== "cotal" || parts[1] !== space || parts[2] !== "ep" || parts[3] !== "v1") return undefined;
  if (!["one", "all", "inst", "reply"].includes(parts[4])) throw new Error(`unsupported issued rail kind in "${row}"`);
  const [owner, actor, uid, generation] = parts.slice(-5, -1);
  return Object.freeze({ space, owner, actor, uid, generation });
}

export async function discoverIssuedAuthority(nc: NatsConnection, space: string, timeout = 3000): Promise<IssuedRef> {
  const response = await nc.request(ISSUED_DISCOVERY_GRANT, new Uint8Array(0), { timeout });
  const info = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.data)) as
    { data?: { permissions?: { publish?: { allow?: unknown } } } };
  const allow = info.data?.permissions?.publish?.allow;
  if (!Array.isArray(allow) || !allow.every((row) => typeof row === "string"))
    throw new Error("the server reports no explicit publish allow list; an unrestricted ceiling names no generation");
  const found = new Map<string, IssuedRef>();
  for (const row of allow as string[]) {
    const ref = refFromRow(space, row);
    // evidenceKey refuses a wildcard or malformed field; a "*" generation binds nothing.
    if (ref) found.set(evidenceKey(ref), ref);
  }
  if (found.size !== 1) throw new Error(`the accepted connection carries ${found.size} issued generations; exactly one is required`);
  return [...found.values()][0];
}

/**
 * The client half of a permission transition. A callout connection that loses its authority
 * closes with an authorization refusal rather than renewing in place, so the client observes
 * that closure and rebinds on a fresh generation. A closure for any other reason is not a
 * transition and refuses here instead of being retried as one.
 */
export async function rebindOnAuthorizationClosure<T extends { nc: NatsConnection }>(
  binding: T,
  open: () => Promise<T>,
): Promise<T> {
  const error = await binding.nc.closed();
  if (!error) throw new Error("the connection closed cleanly; there is no authority transition to rebind from");
  if (!/authoriz/i.test(String((error as Error).message)))
    throw new Error(`closure was not an authorization refusal: ${(error as Error).message}`);
  return open();
}
