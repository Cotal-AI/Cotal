import { tokenAuthenticator } from "@nats-io/transport-node";
import { idFromCreds } from "./identity.js";
import { nativeCredsAuthenticator } from "./creds-authenticator.js";
import { decodeBearerPrincipal } from "./endpoint-dial.js";
import { userInboxConnId } from "./subject-grammar.js";

/** Auth material for a STANDALONE helper connection: a static/raw creds file, OR the user-mode
 *  pair (a view bearer + the deny-all sentinel creds) — exactly what the endpoint's user mode
 *  presents. Never both. Empty = open mode. */
export interface StandaloneAuth {
  /** A creds file, or a getter nats.js reads on every connect and reconnect attempt, so a
   *  long-lived connection presents its owner's current credential instead of the one it dialed with. */
  creds?: string | (() => string);
  bearer?: string;
  sentinelCreds?: string;
  /** Whether this connection must REQUIRE TLS rather than merely tolerate it.
   *
   *  REQUIRED, and it is the point of the field. This helper is the STANDALONE connect path, and it
   *  was derived from the endpoint path's auth half without its transport half: `authOpts`,
   *  `probeConnect` and `RawAuth` all carry a TLS requirement, and this one did not. Every caller
   *  of it therefore built connect options that carried the credentials and dropped the thing that
   *  protects them in transit.
   *
   *  Made required rather than optional because the omitted case is the dangerous one. A client
   *  with no TLS requirement still connects to a TLS broker — it upgrades the same socket once it
   *  reads `tls_required` in the server's unauthenticated INFO — so nothing looks wrong until an
   *  on-path attacker forges an INFO without it and collects the credentials in the clear. An
   *  optional field would leave the seam LOOKING transport-aware while callers kept omitting it.
   *
   *  Note the honest limit of the compile error: smoke files are outside the tsconfigs, so the type
   *  forces every TYPECHECKED caller to state a transport, not every caller. That is why
   *  `standaloneConnectOpts` also throws at runtime — see there. */
  tls: boolean;
}

/** Connection options for a privileged STANDALONE helper (`setupSpaceStreams`, `clearSpaceHistory`,
 *  `clearChannel`, the channel-registry helpers): pin the reply inbox to the connection's own
 *  identity. A scoped cred (provisioner/purger/operator) subscribes only `_INBOX_<id>.>`, so without
 *  this its JS-API replies land on the default `_INBOX.<nuid>` — a subject the cred's sub rejects
 *  (Permissions Violation), hanging every `jetstreamManager`/`streams.*` request.
 *
 *  USER MODE (`bearer` + `sentinelCreds`) mirrors the endpoint's callout-shaped connect: the
 *  sentinel creds land the connection in the callout account, the bearer rides `auth_token`, and
 *  the principal-bound inbox name goes out as the connect `name`. Open mode connects bare. */
export function standaloneConnectOpts(auth: StandaloneAuth): Record<string, unknown> {
  // The `= {}` default is deliberately GONE. It was the omission hole: it let a caller build
  // connect options without ever naming a transport, and the result silently connected non-strict.
  //
  // The throw exists because the type alone does not reach far enough. Smoke files sit outside the
  // tsconfigs, so 16 of this seam's 28 call sites are never typechecked - the compile error covers
  // every TYPECHECKED caller, not every caller. Without this guard those would keep passing no
  // transport and degrade to non-strict in silence, which is precisely the defect being fixed.
  // Positioned BEFORE the options are built and before any connect: a guard only fences what comes
  // after it.
  if (auth?.tls === undefined)
    throw new Error(
      "standaloneConnectOpts requires an explicit `tls` boolean: pass `tls: true` to REQUIRE TLS, " +
      "or `tls: false` for a plaintext broker. It has no default, because defaulting it would " +
      "silently connect without the requirement that protects the credentials being passed.",
    );
  const tlsOpt = auth.tls ? { tls: {} } : {};
  if (auth.bearer !== undefined) {
    if (!auth.sentinelCreds)
      throw new Error("user-mode standalone connect requires sentinelCreds alongside the bearer");
    if (auth.creds) throw new Error("standalone connect takes creds OR bearer+sentinelCreds, never both");
    const { owner, actor } = decodeBearerPrincipal(auth.bearer);
    const connId = userInboxConnId(owner, actor);
    return {
      name: connId,
      inboxPrefix: `_INBOX_${connId}`,
      authenticator: [nativeCredsAuthenticator(auth.sentinelCreds), tokenAuthenticator(auth.bearer)],
      ...tlsOpt,
    };
  }
  const creds = auth.creds;
  if (!creds) return { ...tlsOpt };
  return {
    authenticator: nativeCredsAuthenticator(creds),
    inboxPrefix: `_INBOX_${idFromCreds(typeof creds === "function" ? creds() : creds)}`,
    ...tlsOpt,
  };
}
