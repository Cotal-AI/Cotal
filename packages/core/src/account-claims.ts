import type { NatsConnection } from "@nats-io/transport-node";
import { decode } from "@nats-io/jwt";
import { isAccountNkey } from "./identity.js";

/** Push one operator-signed account JWT over a system-account connection and wait until every
 *  server in `expectedServerIds` has accepted it. On a broker rendered with the `full` account
 *  resolver (`serverConfig`'s `accountResolver`), each server stores the claim and applies it at
 *  once: a new space account becomes usable, and an updated one (for example from
 *  `retireAccountClaim`) takes effect on its live connections, all without a config reload.
 *
 *  A MEMORY broker answers "jwt update skipped" for an account it has not loaded and keeps an update
 *  to a loaded one only until its next reload, so anything other than "jwt updated" from each
 *  required server, an unexpected server, or a missing answer within `maxWaitMs` refuses. The host
 *  owns the signing, the ordering of pushes for one account and the set of servers it expects. */
export async function pushAccountClaim(
  nc: Pick<NatsConnection, "requestMany">,
  claim: { accountJwt: string; expectedServerIds: readonly string[]; maxWaitMs: number },
): Promise<{ account: string; acknowledgedServerIds: string[] }> {
  const { accountJwt, expectedServerIds, maxWaitMs } = claim;
  if (!Array.isArray(expectedServerIds) || expectedServerIds.length === 0 ||
      expectedServerIds.some((id) => typeof id !== "string" || !/^N[A-Z2-7]{55}$/.test(id)) ||
      new Set(expectedServerIds).size !== expectedServerIds.length)
    throw new Error("pushAccountClaim: expectedServerIds must be distinct server public keys, at least one");
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 30_000)
    throw new Error("pushAccountClaim: maxWaitMs must be a whole number of milliseconds from 1 to 30000");
  let account: string;
  try {
    const claims = decode<{ type?: string }>(accountJwt);
    if (claims.nats?.type !== "account" || !isAccountNkey(claims.sub)) throw new Error("not an account claim");
    account = claims.sub;
  } catch {
    throw new Error("pushAccountClaim: accountJwt is not an account JWT");
  }
  const required = new Set(expectedServerIds), accepted = new Set<string>();
  try {
    const replies = await nc.requestMany(`$SYS.REQ.ACCOUNT.${account}.CLAIMS.UPDATE`, accountJwt,
      { strategy: "count", maxMessages: required.size, maxWait: maxWaitMs, noMux: true });
    for await (const reply of replies) {
      const answer = JSON.parse(reply.string()) as { server?: { id?: unknown }; data?: { account?: unknown; code?: unknown; message?: unknown } } | null;
      const server = answer?.server?.id;
      if (typeof server !== "string" || !required.has(server))
        throw new Error(`pushAccountClaim: account ${account} was answered by a server outside expectedServerIds`);
      if (answer?.data?.account !== account || answer.data.code !== 200 || answer.data.message !== "jwt updated")
        throw new Error(`pushAccountClaim: server ${server} did not accept account ${account}: ${String(answer?.data?.message ?? "no message")}`);
      accepted.add(server);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pushAccountClaim:")) throw error;
    throw new Error(`pushAccountClaim: collecting answers for account ${account} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const missing = [...required].filter((id) => !accepted.has(id));
  if (missing.length) throw new Error(`pushAccountClaim: no answer for account ${account} from ${missing.join(", ")} within ${maxWaitMs} ms`);
  return { account, acknowledgedServerIds: [...accepted].sort() };
}
