/**
 * The client half of the registry's `endpoints` question (SPEC 13.15, 13.20): the caller a listing
 * rides on a connection, and one page asked over it. The describe and the question may ride two
 * connections of one caller triple: a connector describes on the session's own connection and asks
 * over its manager-call connection, whose view holds no registry describe.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import { BIND_SPLIT_REISSUES, invokeCommand, type ResolvedService } from "./endpoint-invoke.js";
import { EpEnvelopeError, replyRefusedBeforeEffect } from "./endpoint-error.js";
import { isIssuedCaller, type EpCaller, type IssuedCaller } from "./endpoint-subjects.js";
import type { EpAttributedReply } from "./endpoint-verbs.js";
import { issuedCallerOfToken, listingAcceptedToken } from "./issued-authority.js";
import { isPermissionDenied } from "./permission-denied.js";
import { REGISTRY_CONTRACTS, REGISTRY_ENDPOINTS_COMMAND, type RegistryEndpointsInput, type RegistryEndpointsOutput } from "./registry-contract.js";

/** The caller a listing rides on `nc`. An issued caller lists as itself. Any other reads the
 *  listing generation the issuer bound to the credential the connection presented, under the token
 *  its connection id and that credential's expiry derive. `undefined`: that credential carries no
 *  listing binding, because it predates listing issuance or has no expiry. */
export async function registryListingCaller(
  nc: NatsConnection,
  space: string,
  caller: EpCaller,
  credential: { connId: string; exp?: number },
): Promise<IssuedCaller | undefined> {
  if (isIssuedCaller(caller)) return caller;
  if (credential.exp === undefined) return undefined;
  try {
    return await issuedCallerOfToken(nc, space, listingAcceptedToken(credential.connId, credential.exp), caller);
  } catch (e) {
    // The broker refused the read: the credential holds no row for this token.
    if (isPermissionDenied(e)) return undefined;
    throw e;
  }
}

/** One page of the `endpoints` answer. `describe` resolves the registry; `ask` is the connection the
 *  question rides, under `caller` on a mesh with a permission system. The registry must serve the
 *  contract this client implements. A call the answering instance refused before running (a
 *  class-queue split) is resolved and asked again, up to {@link BIND_SPLIT_REISSUES} times.
 *  `unbound`: the broker refused the question, so the caller's credential holds no listing row, as
 *  an issued credential minted before listing issuance does not. */
export async function listRegistryEndpoints(
  space: string,
  describe: (deadlineMs: number, signal?: AbortSignal) => Promise<ResolvedService>,
  ask: { nc: NatsConnection; caller?: IssuedCaller },
  input: RegistryEndpointsInput,
  opts: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<{ unbound: true } | { unbound?: false; reply: EpAttributedReply; page?: RegistryEndpointsOutput }> {
  const deadline = Date.now() + (opts.deadlineMs ?? 10_000);
  const ours = REGISTRY_CONTRACTS[REGISTRY_ENDPOINTS_COMMAND]!;
  let reply: EpAttributedReply | undefined;
  for (let attempt = 0; attempt <= BIND_SPLIT_REISSUES && Date.now() < deadline; attempt++) {
    const service = await describe(deadline - Date.now(), opts.signal);
    const theirs = service.commands.get(REGISTRY_ENDPOINTS_COMMAND)!.contract;
    if (theirs.input.closureDigest !== ours.input.closureDigest || theirs.output.closureDigest !== ours.output.closureDigest)
      throw new EpEnvelopeError("contract-mismatch", `the registry serves a version of "${REGISTRY_ENDPOINTS_COMMAND}" this client does not implement; upgrade the client (SPEC 13.20)`);
    try {
      reply = await invokeCommand(ask.nc, space, service, REGISTRY_ENDPOINTS_COMMAND, { ...input }, {
        deadlineMs: deadline - Date.now(), signal: opts.signal, ...(ask.caller ? { caller: ask.caller } : {}),
      });
    } catch (e) {
      if (ask.caller !== undefined && e instanceof EpEnvelopeError && e.code === "permission-denied" && e.outcome === "not-executed") return { unbound: true };
      throw e;
    }
    if (reply.reply.ok !== false || !replyRefusedBeforeEffect(reply.reply.error)) break;
  }
  if (reply === undefined) throw new EpEnvelopeError("deadline-exceeded", "the registry was not reached before the deadline");
  return { reply, ...(reply.reply.ok === true ? { page: reply.reply.data as RegistryEndpointsOutput } : {}) };
}
