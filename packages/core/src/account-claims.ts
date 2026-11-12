import type { NatsConnection } from "@nats-io/transport-node";
import { decode, encodeAccount, Types, type Account, type ClaimsData } from "@nats-io/jwt";
import { fromPublic } from "@nats-io/nkeys";
import { isAccountNkey, isUserNkey } from "./identity.js";
import { decodeNatsJwt, nativeNkeySigner } from "./nkey-signer.js";
import type { BrokerAuth } from "./provision.js";

const WILDCARD_FENCE_RETENTION_SECONDS = 86_410;

type AccountClaim = ClaimsData<Account>;

function accountTemplate(
  operation: "hibernateAccountClaim" | "wakeAccountClaim",
  broker: BrokerAuth,
  accountJwt: string,
  iat: number,
): { claims: AccountClaim; signer: ReturnType<typeof nativeNkeySigner> } {
  if (!broker.operator.seed)
    throw new Error(`${operation}: the broker operator seed is required - a stripped broker cannot re-sign the account`);
  if (!Number.isSafeInteger(iat) || iat <= 0)
    throw new Error(`${operation}: iat must be a positive whole number of Unix seconds`);
  let signer: ReturnType<typeof nativeNkeySigner>;
  try {
    signer = nativeNkeySigner(new TextEncoder().encode(broker.operator.seed));
  } catch {
    throw new Error(`${operation}: the broker operator seed is not valid`);
  }
  try {
    const claims = decodeNatsJwt<AccountClaim>(accountJwt);
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== signer.getPublicKey() || claims.nats?.type !== Types.Account ||
        !isAccountNkey(claims.sub ?? ""))
      throw new Error("the account was not signed by this broker's operator");
    if (claims.aud !== "NATS" || typeof claims.name !== "string" || claims.name.length === 0 ||
        !Number.isSafeInteger(claims.iat) || claims.iat < 0 ||
        (claims.exp !== undefined && (!Number.isSafeInteger(claims.exp) || claims.exp <= now)) ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)))
      throw new Error("the account template is not currently valid");
    if (iat <= claims.iat)
      throw new Error(`iat ${iat} must be newer than the template iat ${claims.iat}`);
    const limits = claims.nats.limits;
    const tiered = Object.values(limits?.tiered_limits ?? {});
    const hasJetStreamLimits = limits !== undefined &&
      ((limits.mem_storage !== undefined && limits.mem_storage !== 0) ||
       (limits.disk_storage !== undefined && limits.disk_storage !== 0) ||
       tiered.some((tier) => (tier.mem_storage !== undefined && tier.mem_storage !== 0) ||
         (tier.disk_storage !== undefined && tier.disk_storage !== 0)));
    const authorization = claims.nats.authorization;
    const isCalloutAccount = authorization !== undefined &&
      Array.isArray(authorization.auth_users) && authorization.auth_users.length > 0 &&
      authorization.auth_users.every((key) => isUserNkey(key)) &&
      new Set(authorization.auth_users).size === authorization.auth_users.length &&
      Array.isArray(authorization.allowed_accounts) && authorization.allowed_accounts.length > 0 &&
      authorization.allowed_accounts.every((key) => isAccountNkey(key)) &&
      new Set(authorization.allowed_accounts).size === authorization.allowed_accounts.length &&
      typeof authorization.xkey === "string" && /^X[A-Z2-7]{55}$/.test(authorization.xkey);
    if ((!hasJetStreamLimits && !isCalloutAccount) || limits?.conn === 0)
      throw new Error("the account template is not an active data or auth-callout account claim");
    for (const [key, revokedAt] of Object.entries(claims.nats.revocations ?? {})) {
      if ((key !== "*" && !isUserNkey(key)) || !Number.isSafeInteger(revokedAt) || revokedAt <= 0)
        throw new Error("the account template has an invalid revocation map");
    }
    return { claims, signer };
  } catch (error) {
    signer.clear();
    if (error instanceof Error && error.message.startsWith(`${operation}:`)) throw error;
    throw new Error(`${operation}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function signAccountClaim(
  operation: "hibernateAccountClaim" | "wakeAccountClaim",
  claims: AccountClaim,
  signer: ReturnType<typeof nativeNkeySigner>,
  nats: Partial<Account>,
  iat: number,
): Promise<string> {
  const account = fromPublic(claims.sub);
  try {
    if (Math.floor(Date.now() / 1000) !== iat)
      throw new Error(`${operation}: iat must equal the current Unix second when the claim is signed`);
    const jwt = await encodeAccount(claims.name, account, nats, {
      signer,
      ...(claims.exp === undefined ? {} : { exp: claims.exp }),
      ...(claims.nbf === undefined ? {} : { nbf: claims.nbf }),
      ...(claims.aud === "NATS" ? {} : { aud: claims.aud }),
    });
    if (decodeNatsJwt<AccountClaim>(jwt).iat !== iat)
      throw new Error(`${operation}: the Unix second changed while the claim was signed; retry with a newer iat`);
    return jwt;
  } finally {
    account.clear();
    signer.clear();
  }
}

/** Re-sign an active account claim so no connection is admitted and nats-server unloads its
 * JetStream account. Account identity, signing keys and every per-user revocation are retained.
 * The retirement wildcard is omitted so hibernation cannot be classified as retirement. */
export async function hibernateAccountClaim(
  broker: BrokerAuth,
  currentOrTemplateJwt: string,
  iat: number,
): Promise<string> {
  const { claims, signer } = accountTemplate("hibernateAccountClaim", broker, currentOrTemplateJwt, iat);
  const revocations = Object.fromEntries(
    Object.entries(claims.nats.revocations ?? {}).filter(([key]) => key !== "*"),
  );
  return signAccountClaim("hibernateAccountClaim", claims, signer, {
    ...claims.nats,
    limits: { conn: 0, leaf: 0 },
    ...(Object.keys(revocations).length === 0 ? { revocations: undefined } : { revocations }),
  }, iat);
}

/** Re-sign a saved active account template so nats-server reloads its JetStream account. The
 * template's identity, limits, signing keys and per-user revocations are retained. A temporary
 * wildcard migration fence is retained through its 24-hour grace period, then omitted. */
export async function wakeAccountClaim(
  broker: BrokerAuth,
  activeTemplateJwt: string,
  iat: number,
): Promise<string> {
  const { claims, signer } = accountTemplate("wakeAccountClaim", broker, activeTemplateJwt, iat);
  const revocations = { ...claims.nats.revocations };
  const fence = revocations["*"];
  if (fence !== undefined && iat > fence + WILDCARD_FENCE_RETENTION_SECONDS) delete revocations["*"];
  return signAccountClaim("wakeAccountClaim", claims, signer, {
    ...claims.nats,
    ...(Object.keys(revocations).length === 0 ? { revocations: undefined } : { revocations }),
  }, iat);
}

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
