/**
 * The AUTH SERVICE daemon — the one server-side process a user-auth space runs alongside its broker
 * (the delivery-daemon pattern: spawned detached by `cotal up`, pid-filed per space, torn down by
 * `cotal down`). It hosts BOTH halves of the identity plane, which share state and so belong in one
 * isolated process rather than smeared across the manager/delivery daemons:
 *
 *  - **Plane 2 — the NATS auth callout** ({@link startAuthCallout}): answers `$SYS.REQ.USER.AUTH`
 *    over its own callout-account connection, validating bearers offline against the LOCAL issuer
 *    key set and minting scoped data-account user JWTs.
 *  - **Plane 1 — the token exchange + JWKS, over loopback HTTP**: `POST /exchange` turns a fresh
 *    IdP JWT (from `cotal login`'s cached session) into a Cotal user bearer via the pinned
 *    {@link createIdpBridge}; `GET /jwks` publishes the issuer's public keys.
 *
 * Least-privilege by construction: the daemon loads ONLY provider-owned projected files from its
 * space-scoped state dir (`.cotal/auth/<space>/`) — the data-account signing seed arrives via
 * `service-keys.json` (minting scoped users IS this service's function); the space's operator seed
 * and account seed never enter this process (`prepareServer` wrote the projection and kept the rest).
 *
 * The exchange surface is LOCAL-V1, hardened: loopback bind only; `POST /exchange` requires the
 * per-start high-entropy capability (`Authorization: Bearer <cap>` — readable only from the 0600
 * discovery file, so same-user file ACL is the boundary); requests carrying an `Origin` header are
 * rejected (a browser page can reach loopback; it must not be able to drive the exchange); bodies
 * must be `application/json`; failed exchanges are rate-limited and logged. No CORS headers, ever.
 * Remote/cross-machine exchange is explicitly NOT this surface.
 *
 * Both trust boundaries authorize against the SAME actor ledger, read fresh per request — a revoke
 * bites at the next exchange AND the next connect with no restart.
 *
 * JWKS cache contract (gate 4, explicit): responses carry `Cache-Control: max-age=300`. A verifier
 * may cache the set for up to 5 minutes, so a rotated-out (retired) kid MUST stay published for at
 * least (300s + the max bearer TTL) after rotation before `retire` — otherwise still-live bearers
 * signed by it fail verification at a cold cache. The local callout uses `issuer.localKeySet()`
 * (live, in-process) and is exempt.
 *
 * Readiness contract: the discovery file (`auth-service.json`) is written only AFTER the callout
 * subscription is FLUSHED to the broker and the HTTP listener is bound — its existence (plus a
 * /health probe) IS the readiness signal the provider's `ready()` polls.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { ensureAuthorityStores, isReachable, type ParsedArgs } from "@cotal-ai/core";
import { findCotalRoot, userAuthStateDir } from "@cotal-ai/workspace";
import { decodeJwt } from "jose";
import { startAuthCallout } from "./callout.js";
import { createIdpBridge, type IdpBridge } from "./idp.js";
import type { UserTokenView, ValidatedUserToken } from "./token.js";
import { pinnedJwksResolver, type UserTokenIssuer } from "./issuer.js";
import { calloutPermissions } from "./permissions.js";
import { authorityWriterGrants, openAuthorityClient, openSupervisedConnectReader } from "./authority-client.js";
import { authorizeConnectCredential } from "./connect-reader.js";
import { ensureRootCredential } from "./root-credential.js";
import { openLifecycleRegistry } from "./lifecycle-registry.js";
import {
  AGENT_BEARER_TTL_SEC,
  ledgerAclResolver,
  ledgerAuthorizeAgentExchange,
  ledgerAuthorizeConnect,
  ledgerAuthorizeGrant,
} from "./ledger.js";
import {
  clearAuthServiceInfo,
  loadCalloutAuth,
  loadIssuer,
  loadOwnerSecret,
  loadPinnedIdp,
  loadServiceKeys,
  saveAuthServiceInfo,
  spaceIssuer,
} from "./store.js";

/** JWKS max-age seconds — the cache contract's knob. Exported so a rotation tool can compute the
 *  retire floor (max-age + max bearer TTL) from it. */
export const JWKS_MAX_AGE_SEC = 300;

/** Failed-exchange rate limit: at most this many REFUSED exchanges per rolling minute; further
 *  attempts get 429 until the window drains. Successes are unthrottled (the CLI's normal path). */
const FAILED_EXCHANGE_PER_MIN = 30;

/** Invalid-capability attempts get their OWN window (same size): an unauthenticated local prober
 *  is throttled AND audited, but never consumes the refused-exchange budget of a caller holding
 *  the real capability — a cap-less process must not be able to starve legitimate exchanges. */
const BAD_CAP_PER_MIN = 30;

type Values = Record<string, string | undefined>;

/** The service's AUTHORITY PLANE (R1, SPEC 13.1): the two self-minted data-account connections
 *  behind (a) the composed connect authorizer — the file-ledger arm PLUS the credential deny-new
 *  arm through the supervised, shape-proved reader — and (b) the exchange-time root-credential
 *  ensure both exchange arms stamp `act.credentialId` from. */
export interface AuthAuthorityPlane {
  authorizeConnect: (t: ValidatedUserToken) => Promise<void>;
  mintConnectCredential: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<string>;
  close(): Promise<void>;
}

/**
 * Open the authority plane — the PRODUCTION connect/exchange composition (exported so the live
 * deny-new smoke exercises exactly what the daemon runs). Boot order is the readiness contract:
 * the MINT WRITER connects first and ensures both authority stores exist with their normative
 * shape ({@link ensureAuthorityStores}; the reader's bind proof requires them), then the
 * lifecycle registry binds (its own §13.12 shape proof), then the supervised CONNECT READER
 * binds + proves. Any failure throws — the daemon refuses to come up rather than serving
 * connects it cannot credential-check (no file-only fallback).
 *
 * These are STATIC data-account users (signed by the data-account signing key), so they never
 * transit the auth callout — the callout cannot deadlock on its own reader.
 */
export async function openAuthAuthorityPlane(opts: {
  server: string;
  space: string;
  /** The provider state dir — the file-ledger connect arm reads it fresh per connect. */
  dir: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}): Promise<AuthAuthorityPlane> {
  const { server, space, dataAccount, log } = opts;
  const writer = await openAuthorityClient({ server, space, dataAccount, label: `cotal:auth-mint:${space}`, grants: (id) => authorityWriterGrants(space, id), log });
  let registry;
  try {
    await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), space);
    registry = await openLifecycleRegistry(writer.nc, space);
  } catch (e) {
    await writer.close();
    throw e;
  }
  let reader;
  try {
    reader = await openSupervisedConnectReader({ server, space, dataAccount, log });
  } catch (e) {
    await writer.close();
    throw e;
  }
  const fileArm = ledgerAuthorizeConnect(opts.dir);
  return {
    authorizeConnect: async (t) => {
      fileArm(t);
      await authorizeConnectCredential(reader.current(), t, Date.now);
    },
    mintConnectCredential: (args) => ensureRootCredential(registry, { ...args, managerInstance: `auth-service:${space}` }),
    close: async () => {
      await reader.close();
      await writer.close();
    },
  };
}

/** Run the auth service. Flags: `--space` (required), `--server` (broker URL, required), `--port`
 *  (loopback HTTP port; default ephemeral). All persisted material must already exist in the
 *  space-scoped state dir (the provider's `prepareServer` ran at `cotal up`) — a missing piece is a
 *  fail-loud config error naming the fix, never a silent partial service. */
export async function runAuthService(args: ParsedArgs): Promise<void> {
  const v = args.values as Values;
  const space = v.space;
  if (!space) throw new Error("auth-service: --space is required");
  const server = v.server;
  if (!server) throw new Error("auth-service: --server is required (the broker this callout serves)");
  const port = v.port === undefined ? 0 : Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`auth-service: --port must be a port number, got "${v.port}"`);

  // The provider's space-scoped state dir — every file this daemon reads lives here. The layout
  // fact is workspace-owned (userAuthStateDir); this daemon never touches `.cotal/auth/auth.json`.
  const dir = userAuthStateDir(findCotalRoot(), space);
  // Scrub any stale discovery file FIRST — a dead prior daemon's entry must never satisfy a
  // readiness poll for THIS start (the provider's ready() also pid-checks; belt and braces).
  clearAuthServiceInfo(dir);
  const keys = loadServiceKeys(dir);
  const callout = loadCalloutAuth(dir);
  const issuer = await loadIssuer(dir);
  const ownerSecret = loadOwnerSecret(dir);
  const idp = loadPinnedIdp(dir);
  if (!keys || !callout || !issuer || !ownerSecret || !idp)
    throw new Error(`auth-service: user-auth material is missing under ${dir} - enable it with \`cotal up --user-auth --idp <url>\``);
  if (issuer.issuer !== spaceIssuer(space))
    throw new Error(`auth-service: issuer pin ${issuer.issuer} does not match space "${space}"`);

  if (!(await isReachable(server, { creds: callout.calloutCreds })))
    throw new Error(`auth-service: can't reach the broker at ${server} with the callout creds - is the mesh up (with the callout account preloaded)?`);

  // ---- The authority plane (R1): stores ensured + registry + supervised reader, BEFORE the
  // callout exists — a connect must never be answered without the credential arm bound.
  const plane = await openAuthAuthorityPlane({
    server,
    space,
    dir,
    dataAccount: { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed },
    log: (l) => console.error(l),
  });

  // ---- Plane 2: the callout, on its own callout-account connection ----
  const nc: NatsConnection = await connect({
    servers: server,
    authenticator: credsAuthenticator(new TextEncoder().encode(callout.calloutCreds)),
    name: `cotal:auth-service:${space}`,
  });
  startAuthCallout(nc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed },
    space,
    token: { key: issuer.localKeySet(), issuer: issuer.issuer },
    authorizeActor: plane.authorizeConnect,
    permissionsFor: calloutPermissions(ledgerAclResolver(dir)),
    log: (l) => console.error(l),
  });
  // The subscription must be ON the broker before readiness is signaled — an `up` that recorded a
  // usable user mesh while the SUB was still in flight would intermittently deny first connects.
  await nc.flush();

  // ---- Plane 1: the exchange + JWKS, loopback HTTP ----
  const bridge = createIdpBridge({
    idp: { issuer: idp.issuer, audience: idp.audience, key: pinnedJwksResolver(idp.jwksUri) },
    space,
    spaceSecret: ownerSecret,
    issuer,
    authorizeActor: ledgerAuthorizeGrant(dir),
    mintConnectCredential: plane.mintConnectCredential,
  });
  const cap = randomBytes(32).toString("hex"); // per-start exchange capability (rotates with the daemon)
  const failures: number[] = []; // rolling-window timestamps of REFUSED exchanges
  const badCaps: number[] = []; // rolling-window timestamps of invalid-capability attempts
  const http = createServer((req, res) => void handle(req, res, { issuer, bridge, cap, failures, badCaps, space, dir, mintConnectCredential: plane.mintConnectCredential }));
  await new Promise<void>((resolvePort, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolvePort());
  });
  const addr = http.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://127.0.0.1:${boundPort}`;

  // Both planes bound — NOW write the discovery file (its existence is the readiness signal).
  saveAuthServiceInfo(dir, { url, pid: process.pid, cap });
  console.log(`✓ auth service up (space ${space}) - callout on ${server}, exchange/JWKS at ${url}`);

  const stop = async () => {
    clearAuthServiceInfo(dir); // a dead service must not satisfy the next start's readiness poll
    http.close();
    await plane.close().catch(() => {});
    await nc.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  // A dropped broker connection is fatal-loud, not a zombie: the supervising `up`/`down` lifecycle
  // owns restarts, and a callout that silently stopped answering would hang every user connect.
  await (nc as { closed(): Promise<Error | void> }).closed().then((err) => {
    clearAuthServiceInfo(dir);
    if (err) {
      console.error(`✗ auth-service: broker connection closed (${err.message}) - exiting`);
      process.exit(1);
    }
    process.exit(0);
  });
}

interface HandlerCtx {
  issuer: UserTokenIssuer;
  bridge: IdpBridge;
  cap: string;
  failures: number[];
  badCaps: number[];
  space: string;
  /** The provider state dir — the AGENT grant type reads its ledger rows fresh per exchange. */
  dir: string;
  /** The authority plane's root-credential ensure — the agent-exchange arm stamps from it (the
   *  human arm stamps inside the bridge). */
  mintConnectCredential: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<string>;
}

/** Route one HTTP request. Local-only surface: /jwks (public keys, cacheable), /exchange (IdP JWT →
 *  bearer; capability-gated), /health. Anything else 404s. Errors are JSON `{ error }`. */
async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    // No CORS headers, ever — a browser context must never be granted a readable response here.
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.url === "/health") return send(200, { ok: true, issuer: ctx.issuer.issuer });
    if (req.url === "/jwks") {
      if (req.method !== "GET") return send(405, { error: "GET only" });
      // The explicit cache contract (see the module doc): max-age bounds how stale a verifier's set
      // may be, which in turn floors how long a retired kid must stay published after rotation.
      return send(200, ctx.issuer.jwks(), { "cache-control": `max-age=${JWKS_MAX_AGE_SEC}` });
    }
    if (req.url === "/exchange") {
      if (req.method !== "POST") return send(405, { error: "POST only" });
      // Browser exclusion: a cross-site page CAN reach loopback, but its requests carry `Origin`
      // (and can't strip it). The CLI never sends one. Reject before touching anything else.
      if (req.headers.origin !== undefined) return send(403, { error: "browser-origin requests are not served here" });
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
        return send(415, { error: "content-type must be application/json" });
      // The capability gate: same-user file ACL on the 0600 discovery file is the boundary. An
      // invalid/missing cap is still a failed exchange attempt — audited and throttled, in its own
      // window (see BAD_CAP_PER_MIN), before anything downstream is touched.
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${ctx.cap}`) {
        const now = Date.now();
        while (ctx.badCaps.length && now - ctx.badCaps[0] > 60_000) ctx.badCaps.shift();
        ctx.badCaps.push(now);
        console.error("auth-service: rejected an exchange with a missing/invalid capability");
        if (ctx.badCaps.length > BAD_CAP_PER_MIN)
          return send(429, { error: "too many invalid-capability attempts - wait a minute and retry" });
        return send(401, { error: "missing/invalid exchange capability - read it from the space's auth-service.json" });
      }
      // Refused-exchange rate limit (probing protection): count only FAILURES.
      const now = Date.now();
      while (ctx.failures.length && now - ctx.failures[0] > 60_000) ctx.failures.shift();
      if (ctx.failures.length >= FAILED_EXCHANGE_PER_MIN)
        return send(429, { error: "too many refused exchanges - wait a minute and retry" });
      const body = await readJsonBody(req);
      const { idpToken, actor, actorToken, owner, ttlSec, view } = body as {
        idpToken?: unknown;
        actor?: unknown;
        actorToken?: unknown;
        owner?: unknown;
        ttlSec?: unknown;
        view?: unknown;
      };
      if (ttlSec !== undefined && typeof ttlSec !== "number") return send(400, { error: "ttlSec must be a number" });
      if (view !== undefined && typeof view !== "string") return send(400, { error: "view must be a string when present" });
      // TWO grant types, disjoint by construction: a HUMAN exchange proves an IdP session
      // (idpToken), an AGENT exchange proves a spawn-time ledger secret (owner + actorToken).
      // A request presenting both is malformed — refuse rather than pick.
      if (idpToken !== undefined && actorToken !== undefined)
        return send(400, { error: "exchange takes idpToken (human) OR owner+actorToken (agent), never both" });
      if (actorToken !== undefined) {
        // Elevated views are for signed-in HUMANS only: an agent's secret exchange never mints one,
        // whatever its ledger row carries (v1 — agents hold no god views).
        if (view !== undefined)
          return send(400, { error: "the managed (agent-secret) exchange never mints elevated views - views ride a signed-in human exchange" });
        if (typeof owner !== "string" || !owner || typeof actor !== "string" || !actor || typeof actorToken !== "string" || !actorToken)
          return send(400, { error: "agent exchange needs { owner: string, actor: string, actorToken: string, ttlSec?: number }" });
        try {
          const grant = ledgerAuthorizeAgentExchange(ctx.dir, owner, actor, actorToken);
          if (typeof grant.lifecycleUid !== "string" || !grant.lifecycleUid)
            throw new Error(`actor "${actor}" has no lifecycleUid on its ledger row - respawn it (bearers are lifecycle-bound from v0.4)`);
          // Credential-BIND the bearer (SPEC 13.1, R1): the incarnation's live root credential is
          // ensured (minted release-last on first exchange) BEFORE the bearer bytes are signed,
          // and rides act.credentialId — the connect arm requires it against the LIVE cred row.
          const credentialId = await ctx.mintConnectCredential({ owner, actor, lifecycleUid: grant.lifecycleUid });
          const token = await ctx.issuer.issue({
            owner,
            space: ctx.space,
            actor,
            scope: grant.scope,
            parent: grant.parent,
            // Lifecycle-BIND the bearer (SPEC 13.1): the row's uid rides act.lifecycleUid, and the
            // callout refuses a mismatch against the CURRENT row at connect — a predecessor's
            // still-unexpired bearer dies at the alias's respawn instead of minting the
            // successor's broker authority.
            lifecycleUid: grant.lifecycleUid,
            credentialId,
            ttlSec: Math.min(ttlSec ?? AGENT_BEARER_TTL_SEC, AGENT_BEARER_TTL_SEC),
          });
          const { exp } = decodeJwt(token);
          return send(200, { token, owner, exp });
        } catch (e) {
          ctx.failures.push(Date.now());
          const reason = e instanceof Error ? e.message : String(e);
          console.error(`auth-service: refused an agent exchange: ${reason}`);
          return send(401, { error: reason });
        }
      }
      if (typeof idpToken !== "string" || !idpToken || typeof actor !== "string" || !actor)
        return send(400, { error: "exchange needs { idpToken: string, actor: string, ttlSec?: number, view?: string }" });
      try {
        // The bridge validates `view` against the closed enum and the fresh ledger grant — an
        // unknown or under-scoped view is a refused exchange (audited + throttled like any other).
        const r = await ctx.bridge.exchange(idpToken, { actor, ttlSec, view: view as UserTokenView | undefined });
        return send(200, r);
      } catch (e) {
        // A refused exchange (bad IdP token, ungranted actor, expired proof) is an AUTHENTICATED
        // denial with the reason — the client shows it to the operator verbatim.
        ctx.failures.push(Date.now());
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`auth-service: refused an exchange: ${reason}`);
        return send(401, { error: reason });
      }
    }
    return send(404, { error: "unknown path - /health, /jwks, /exchange" });
  } catch (e) {
    send(400, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Read + parse a small JSON body, bounded — the exchange payload is an IdP JWT plus an actor name;
 *  64 KB clears any sane JWT while keeping the loopback surface un-floodable. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX = 64 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}
