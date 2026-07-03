/**
 * Plane-2 auth-callout bridge (ADR-26, operator mode) — the server-side service that turns a
 * validated user bearer into a scoped, short-lived NATS user JWT at connect time.
 *
 * Operator-mode topology (the sentinel pattern):
 *  - a DEDICATED auth account quarantines callout traffic ({@link createCalloutAuth}): the callout
 *    service is its only privileged user, plus a shared deny-all "sentinel" user whose creds
 *    agents present alongside the real bearer in `auth_token`;
 *  - the auth account's JWT carries `authorization { auth_users, allowed_accounts, xkey }`, so the
 *    server routes connects landing there to `$SYS.REQ.USER.AUTH` and lets the response re-bind
 *    the client into the DATA account (`issuer_account` + a user JWT signed by the data account's
 *    signing key);
 *  - the **xkey is mandatory**: {@link startAuthCallout} refuses to start without one, and drops
 *    any request that arrives unsealed or whose signed `server_id.xkey` doesn't match the sealing
 *    header key — without this the bearer crosses the auth path in cleartext (TLS protects the
 *    transport, not this payload).
 *
 * Fail-closed at every step: protocol-shape violations (bad seal, bad signature, key mismatch)
 * get NO response (the server denies on timeout — we cannot authenticate the peer, so we do not
 * talk to it); authenticated-but-invalid bearers get a signed, sealed ERROR response; only a fully
 * validated principal gets a mint. The minted user JWT's expiry is BOUND to the bearer's, so
 * broker access dies with the token (the v1 revocation lever — nats-server disconnects clients at
 * user-JWT expiry).
 */
import {
  Algorithms,
  decode,
  encodeAccount,
  encodeAuthorizationResponse,
  encodeUser,
  fmtCreds,
  type AuthorizationRequest,
} from "@nats-io/jwt";
import { createAccount, createCurve, fromCurveSeed, fromPublic, fromSeed } from "@nats-io/nkeys";
import { assertInboxConnId, newIdentity, principalKey, principalTags, token, type SpaceAuth } from "@cotal-ai/core";
import type { JWTVerifyGetKey, CryptoKey } from "jose";
import { validateUserToken, type ValidatedUserToken } from "./token.js";

/** The one subject the callout serves (ADR-26). */
export const AUTH_CALLOUT_SUBJECT = "$SYS.REQ.USER.AUTH";

/** Header carrying the server's public curve key on sealed callout requests. */
const SERVER_XKEY_HEADER = "Nats-Server-Xkey";

// The auth account is a quarantine: no JetStream, unlimited conns (every callout-mode connect
// transits it). Mirrors core's account limits shape (which is module-private there on purpose —
// the auth account is this package's concern, not part of the wire standard).
const AUTH_ACCOUNT_LIMITS = {
  subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1,
  data: -1, payload: -1, wildcards: true, mem_storage: 0, disk_storage: 0,
} as const;

/** The trust material of the dedicated auth-callout account. */
export interface CalloutAuth {
  /** The auth account: operator-signed JWT carrying `authorization { auth_users, allowed_accounts, xkey }`. */
  account: { pub: string; seed: string; signingSeed: string; signingPub: string; jwt: string };
  /** The callout service's own connection creds (the sole `auth_users` entry). */
  calloutCreds: string;
  /** Shared, deny-all sentinel creds agents present alongside their bearer. Powerless by design. */
  sentinelCreds: string;
  /** The callout curve keypair (xkey). The seed stays with the callout service only. */
  xkey: { seed: string; pub: string };
}

/** Generate the dedicated auth-callout account for a space: account + signing key, the callout
 *  service user, the deny-all sentinel, and the xkey — `authorization` wired so the server seals
 *  requests and lets responses bind users into the data account. Requires the FULL (unstripped)
 *  {@link SpaceAuth}: only the operator can sign a new account. */
export async function createCalloutAuth(auth: SpaceAuth): Promise<CalloutAuth> {
  if (!auth.operator.seed) throw new Error("createCalloutAuth: full SpaceAuth required (operator seed missing — stripped auth cannot sign a new account)");
  const okp = fromSeed(new TextEncoder().encode(auth.operator.seed));
  const akp = createAccount();
  const askp = createAccount();
  const xkp = createCurve();
  const callout = newIdentity();
  const sentinel = newIdentity();

  const accountJwt = await encodeAccount(
    `AUTH_${token(auth.space)}`,
    akp,
    {
      limits: { ...AUTH_ACCOUNT_LIMITS },
      signing_keys: [askp.getPublicKey()],
      authorization: {
        auth_users: [callout.id],
        allowed_accounts: [auth.account.pub],
        xkey: xkp.getPublicKey(),
      },
    },
    { signer: okp },
  );

  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  const signer = askp;
  // The callout user: subscribe ONLY the callout subject; publish everywhere it might need to send
  // a reply (server-chosen inbox) EXCEPT the callout subject itself — denying pub on
  // $SYS.REQ.USER.AUTH means even a leaked callout cred cannot inject a forged auth request into
  // its own service (defense-in-depth behind the iss/server-id provenance check in the handler).
  // The sentinel: deny-all both ways — it exists only so a connect can carry a bearer; any
  // capability here would be pre-auth surface.
  const calloutJwt = await encodeUser("callout", fromPublic(callout.id), fromPublic(akp.getPublicKey()), {
    sub: { allow: [AUTH_CALLOUT_SUBJECT] },
    pub: { allow: [">"], deny: [AUTH_CALLOUT_SUBJECT] },
  }, { signer });
  const sentinelJwt = await encodeUser("sentinel", fromPublic(sentinel.id), fromPublic(akp.getPublicKey()), {
    sub: { deny: [">"] },
    pub: { deny: [">"] },
  }, { signer });

  return {
    account: { pub: akp.getPublicKey(), seed: dec(akp.getSeed()), signingSeed: dec(askp.getSeed()), signingPub: askp.getPublicKey(), jwt: accountJwt },
    calloutCreds: dec(fmtCreds(calloutJwt, fromSeed(new TextEncoder().encode(callout.seed)))),
    sentinelCreds: dec(fmtCreds(sentinelJwt, fromSeed(new TextEncoder().encode(sentinel.seed)))),
    xkey: { seed: dec(xkp.getSeed()), pub: xkp.getPublicKey() },
  };
}

/** The minimal connection surface the callout needs — structurally satisfied by a nats.js
 *  `NatsConnection` without this package depending on a transport. */
export interface CalloutConnection {
  subscribe(subject: string, opts?: { queue?: string }): AsyncIterable<CalloutMsg>;
}
export interface CalloutMsg {
  data: Uint8Array;
  headers?: { get(key: string): string | undefined };
  respond(data: Uint8Array): unknown;
}

export interface StartAuthCalloutOpts {
  /** The callout xkey SEED — MANDATORY. No xkey, no service (fail startup, never plaintext). */
  xkeySeed: string;
  /** The auth account (response issuer): its pub + the signing seed the response is signed with. */
  authAccount: { pub: string; signingSeed: string };
  /** The data account users are bound into: its pub + the signing seed that mints user JWTs. */
  dataAccount: { pub: string; signingSeed: string };
  /** The space — enforced as the bearer's audience. */
  space: string;
  /** Pinned bearer verification: the key resolver (pinned JWKS/local key) + exact issuer. */
  token: { key: JWTVerifyGetKey | CryptoKey; issuer: string };
  /** The spawn-ledger hook: THROW to deny. Client-supplied actor claims are only as good as this
   *  server-side check — the flip wires the manager's authenticated spawn ledger in here. */
  authorizeActor: (t: ValidatedUserToken) => void | Promise<void>;
  /** Allow-list of trusted nats-server ids (`server_id.id`) — the tightest request-provenance pin:
   *  a request whose server id is not listed is dropped (no response). STRONGLY RECOMMENDED for any
   *  hardened / multi-server deploy. When omitted, the ONLY barrier left is NATS $SYS system-subject
   *  isolation (no in-account user can publish `$SYS.REQ.USER.AUTH`, and the callout user is even
   *  explicitly pub-denied it) — the app-layer `iss === server_id.id` + `N…`-prefix check is NOT
   *  independently sufficient, since an attacker who could reach the subject could present their own
   *  `createServer()` key and matching sealing xkey. That isolation holds single-broker, so omitting
   *  the list is safe today; startup logs a WARNING so the over-trust is never silent. */
  expectedServerIds?: string[];
  /** Permission builder for a validated principal (the flip feeds core's `permissionsFor` via a thin
   *  `@cotal-ai/auth` adapter). `connId` is the client-chosen inbox nonce (`req.connect_opts.name`), NOT
   *  the NATS-minted `req.user_nkey` — the builder scopes the private reply inbox `_INBOX_<connId>.>` on
   *  it. The client picks and passes this nonce because neither it nor this callout knows the per-connect
   *  nkey pre-connect; core's `assertInboxConnId` rejects a nonce with subject metacharacters, so it
   *  cannot widen the grant. An absent/invalid nonce makes the builder throw → a signed deny. */
  permissionsFor: (t: ValidatedUserToken, connId: string) => Record<string, unknown>;
  /** Diagnostics sink (default: console.error). Never carries bearer contents. */
  log?: (line: string) => void;
  /** Audit hook fired on each successful mint, BEFORE the response is sent — the minted user JWT
   *  plus its principal and bound expiry. For metering/audit and for asserting the revocation lever
   *  (the mint's `exp` is bound to the bearer's, so broker access dies with the bearer). */
  onMint?: (info: { jwt: string; principal: string; exp: number }) => void;
}

/** Serve the auth callout on an existing (auth-account) connection. Resolves setup synchronously —
 *  throws on missing/invalid xkey or signing material; returns the running service. */
export function startAuthCallout(nc: CalloutConnection, opts: StartAuthCalloutOpts): { done: Promise<void> } {
  if (!opts.xkeySeed) throw new Error("auth callout: xkey seed is required — refusing to start a callout that would receive bearer tokens unsealed");
  const xkp = fromCurveSeed(new TextEncoder().encode(opts.xkeySeed)); // throws on non-curve seeds
  const responseSigner = fromSeed(new TextEncoder().encode(opts.authAccount.signingSeed));
  const userSigner = fromSeed(new TextEncoder().encode(opts.dataAccount.signingSeed));
  if (!opts.space) throw new Error("auth callout: space is required");
  const log = opts.log ?? ((l: string) => console.error(l));
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  if (!opts.expectedServerIds?.length)
    log("auth callout: WARNING — no expectedServerIds allow-list set; request provenance rests on $SYS system-subject isolation alone (safe single-broker, but set expectedServerIds for hardened/multi-server deploys)");

  const sub = nc.subscribe(AUTH_CALLOUT_SUBJECT, { queue: "cotal-auth-callout" });

  const done = (async () => {
    for await (const msg of sub) {
      // ---- authenticate the REQUEST itself; shape violations get NO response ----
      const serverXkey = msg.headers?.get(SERVER_XKEY_HEADER);
      if (!serverXkey) {
        log("auth callout: dropped an UNSEALED request (no Nats-Server-Xkey header) — check the account xkey config");
        continue;
      }
      let claims;
      try {
        const plain = xkp.open(msg.data, serverXkey);
        if (plain === null) throw new Error("xkey open failed");
        claims = decode<AuthorizationRequest>(dec(plain)); // ed25519 signature verified in decode()
      } catch (e) {
        log(`auth callout: dropped an undecryptable/unverifiable request (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      const req = (claims as { nats?: AuthorizationRequest }).nats;
      if (!req?.user_nkey || !req.server_id?.id) {
        log("auth callout: dropped a request without user_nkey/server_id");
        continue;
      }
      // Request provenance — prove nats-server sent this, not an in-account publisher. `decode()`
      // verified the signature against the embedded `iss`, but that alone accepts ANY self-signed
      // JWT; without pinning, a holder of callout creds could publish a sealed forged request to a
      // reply subject it controls and be minted a data-account JWT. So: the issuer must be the
      // request's own server id AND a server-prefixed (`N…`) nkey, and — when configured — one of
      // the trusted server ids.
      const issuer = (claims as { iss?: string }).iss;
      if (issuer !== req.server_id.id || !req.server_id.id.startsWith("N")) {
        log("auth callout: dropped a request whose issuer is not its own server identity (forgery guard)");
        continue;
      }
      if (opts.expectedServerIds && !opts.expectedServerIds.includes(req.server_id.id)) {
        log(`auth callout: dropped a request from an untrusted server id ${req.server_id.id}`);
        continue;
      }
      if (req.server_id.xkey !== serverXkey) {
        // The signed payload must vouch for the key that sealed it — otherwise a relay could
        // re-seal someone else's request under its own key.
        log("auth callout: dropped a request whose signed server_id.xkey != sealing header key");
        continue;
      }

      const respond = async (data: { jwt?: string; error?: string }) => {
        const resp = await encodeAuthorizationResponse(
          fromPublic(req.user_nkey),
          fromPublic(req.server_id.id),
          responseSigner,
          { ...data, issuer_account: opts.authAccount.pub },
          { algorithm: Algorithms.v2 },
        );
        msg.respond(xkp.seal(enc(resp), serverXkey));
      };

      // ---- validate the bearer; failures are authenticated denials (signed error response) ----
      try {
        const bearer = req.connect_opts?.auth_token;
        if (!bearer) throw new Error("no user token presented (auth_token empty)");
        const validated = await validateUserToken(bearer, {
          key: opts.token.key,
          issuer: opts.token.issuer,
          audience: opts.space,
        });
        await opts.authorizeActor(validated);
        // The private reply-inbox (`_INBOX_<connId>.>`) must scope on a token the CLIENT knows pre-connect
        // — but under the callout the connection nkey (`req.user_nkey`) is minted per-connect by NATS, so
        // the client cannot set its `inboxPrefix` to match it. So the client picks its own random inbox
        // nonce and passes it as the connection `name`; we scope the grant on THAT (empirically: a scoped
        // `_INBOX_<nonce>.>` round-trips through the rebind, and the nonce is a per-connection secret, the
        // same security model as NATS's default random mux inbox). core's `assertInboxConnId` (via
        // permissionsFor) rejects a nonce carrying subject metacharacters, so a client cannot widen the
        // grant to `_INBOX_>.>`; a missing/garbled name throws → this becomes a signed deny (fail-closed).
        // Validate the nonce HERE, at the boundary where untrusted client input enters — not inside the
        // injected permissionsFor hook (which could be any implementation). assertInboxConnId throws on a
        // missing/wildcard name → the catch below turns it into a signed deny (fail-closed).
        const inboxNonce = assertInboxConnId(req.connect_opts?.name ?? "");
        const perms = opts.permissionsFor(validated, inboxNonce);
        // Stamp the principal into the minted JWT so the live identity is recoverable server-side: the
        // connection's `user_nkey` is a per-connect ephemeral the SERVER generated, not the principal,
        // so the membership feed (which keys CONNZ entries on the connection identity) needs owner+actor
        // carried here. `tags` are the ONE identity field CONNZ surfaces for a JWT-authed connection
        // (proven empirically — `authorized_user` is the nkey, the JWT `name` claim is not surfaced), via
        // core's single-source {@link principalTags}. The JWT `name` is the principal name-form
        // (JetStream-safe), a stable label. The feed-side re-key onto the `principal:` tag ships with
        // the membership-feed migration (Increment D).
        const { key, name } = principalKey(validated.owner, validated.act.actor);
        const userJwt = await encodeUser(
          name,
          fromPublic(req.user_nkey),
          fromPublic(opts.dataAccount.pub),
          { ...perms, tags: principalTags(validated.owner, validated.act.actor) },
          { signer: userSigner, exp: validated.exp }, // NATS access dies with the bearer
        );
        opts.onMint?.({ jwt: userJwt, principal: key, exp: validated.exp });
        await respond({ jwt: userJwt });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log(`auth callout: denied ${req.user_nkey}: ${reason}`);
        try {
          await respond({ error: reason });
        } catch (re) {
          log(`auth callout: failed to send deny response: ${re instanceof Error ? re.message : String(re)}`);
        }
      }
    }
  })();

  return { done };
}
