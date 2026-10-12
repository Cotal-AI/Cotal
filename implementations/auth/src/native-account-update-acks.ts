import type { NatsConnection } from "@nats-io/transport-node";
import { decode } from "@nats-io/jwt";
import { EpEnvelopeError } from "@cotal-ai/core";

export interface NativeAccountUpdateInput {
  accountPublicKey: string;
  accountJwt: string;
  expectedServerIds: readonly string[];
  maxWaitMs: number;
}

/** Collect native acceptance over the host's existing system connection. The host owns the
 * signed claim, serialized current state and required server set. This is not revocation,
 * durable storage, topology discovery or a retirement receipt. */
export async function collectNativeAccountUpdateAcks(
  nc: NatsConnection,
  input: NativeAccountUpdateInput,
): Promise<{ acknowledgedServerIds: string[] }> {
  const fields = ["accountPublicKey", "accountJwt", "expectedServerIds", "maxWaitMs"];
  if (!input || Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key)) ||
      typeof input.accountPublicKey !== "string" || !/^A[A-Z2-7]{55}$/.test(input.accountPublicKey) || typeof input.accountJwt !== "string" ||
      !Array.isArray(input.expectedServerIds) || input.expectedServerIds.length === 0 ||
      input.expectedServerIds.some(id => typeof id !== "string" || !/^N[A-Z2-7]{55}$/.test(id)) ||
      new Set(input.expectedServerIds).size !== input.expectedServerIds.length ||
      !Number.isSafeInteger(input.maxWaitMs) || input.maxWaitMs < 1 || input.maxWaitMs > 30_000)
    throw new EpEnvelopeError("failed-precondition", "native account update coordinates are invalid");
  const { accountPublicKey, accountJwt, maxWaitMs } = input;
  const required = new Set(input.expectedServerIds);
  try {
    const claims = decode<{ type: string }>(accountJwt);
    if (claims.sub !== accountPublicKey || claims.nats?.type !== "account") throw new Error("account mismatch");
  } catch {
    throw new EpEnvelopeError("failed-precondition", "native account update claim does not match its account");
  }

  const accepted = new Set<string>();
  try {
    const replies = await nc.requestMany(`$SYS.REQ.ACCOUNT.${accountPublicKey}.CLAIMS.UPDATE`, accountJwt,
      { strategy: "timer", maxWait: maxWaitMs, noMux: true });
    for await (const reply of replies) {
      const result = JSON.parse(reply.string()) as {
        server?: { id?: unknown };
        data?: { account?: unknown; code?: unknown; message?: unknown };
        error?: unknown;
      } | null;
      if (!result || typeof result.server?.id !== "string" || !required.has(result.server.id))
        throw new EpEnvelopeError("unavailable", "native account update returned an unexpected responder");
      if (result.error !== undefined || result.data?.account !== accountPublicKey ||
          result.data?.code !== 200 || result.data?.message !== "jwt updated")
        throw new EpEnvelopeError("unavailable", "native account update was not accepted by a required server");
      accepted.add(result.server.id);
    }
  } catch (error) {
    if (error instanceof EpEnvelopeError) throw error;
    throw new EpEnvelopeError("unavailable", "native account update response collection failed");
  }
  if ([...required].some(id => !accepted.has(id)))
    throw new EpEnvelopeError("unavailable", "native account update has missing required acknowledgments");
  return { acknowledgedServerIds: [...accepted].sort() };
}
