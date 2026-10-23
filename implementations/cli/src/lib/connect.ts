import { isConnectRefusal, reachableOrThrow, type ConnectRefusal, type Connection } from "@cotal-ai/workspace";

// The connect-or-exit wrappers moved into `@cotal-ai/workspace` (stage 4) so every command
// surface — this CLI and @cotal-ai/web — resolves meshes identically. Re-exported here
// so existing importers keep resolving them from this module unchanged.
export {
  connectOrExit,
  connectOrThrow,
  ConnectRefusal,
  connectUserControlOrExit,
  endpointAuth,
  reachableOrExit,
  refuseStaticCredsForKnownUserAuthOrExit,
  resolveTargetOrExit,
  preflightOrExit,
  classifyPreflightFailure,
  userViewAuth,
  userViewAuthOrExit,
  type UserViewAuth,
  type ConnectFlags,
  type Connection,
  type RawAuth,
  type PreflightFailure,
} from "@cotal-ai/workspace";

/** The refusal a live view ends with once its connection has dropped and its credential can no
 *  longer connect: the one a one-shot command presenting that credential gets now, such as
 *  `credential EXPIRED` or `credentials rejected`. Undefined while the broker cannot be reached or
 *  the credential still connects, because the endpoint's own re-establishing recovers both. A
 *  user-auth bearer and an open mesh present no fixed credential, so they keep re-establishing. */
export async function credentialEnded(conn: Connection): Promise<ConnectRefusal | undefined> {
  if (conn.creds === undefined) return undefined;
  try {
    await reachableOrThrow(conn.server, { creds: conn.creds, ...(conn.tls ? { tls: true } : {}) });
  } catch (e) {
    if (!isConnectRefusal(e)) throw e;
    if (e.kind === "permanent") return e;
  }
  return undefined;
}
