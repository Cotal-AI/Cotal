import { ConnectRefusal, isConnectRefusal, reachableOrThrow, type Connection } from "@cotal-ai/workspace";

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
 *  user-auth bearer and an open mesh present no fixed credential, so they keep re-establishing. A
 *  credential the command minted from the space's trust says to run the command again when it is
 *  rejected, because a new run mints one from the trust the space has now. */
export async function credentialEnded(conn: Connection): Promise<ConnectRefusal | undefined> {
  if (conn.creds === undefined) return undefined;
  try {
    await reachableOrThrow(conn.server, { creds: conn.creds, ...(conn.tls ? { tls: true } : {}) });
  } catch (e) {
    if (!isConnectRefusal(e)) throw e;
    if (e.kind !== "permanent") return undefined;
    if (conn.auth === undefined || e.code !== "PERMISSION_DENIED") return e;
    const message = e.parts?.message ?? e.rendered.replace(/^✗ /, "");
    const remedy = "the space's trust changed after this command started; run it again to connect with its current trust";
    return new ConnectRefusal(`✗ ${message} - ${remedy}`, undefined, { cause: e, code: e.code, parts: { message, remedy }, ...(e.target ? { target: e.target } : {}) });
  }
  return undefined;
}
