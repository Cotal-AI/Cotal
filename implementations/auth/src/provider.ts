/**
 * The core `auth-provider` extension — how a composition root gets user-mode auth WITHOUT importing
 * this package from the CLI (`bin/cotal.ts` imports `@cotal-ai/auth`; `@cotal-ai/cli` resolves the
 * provider from the registry, generically).
 *
 * `prepareServer` is the `cotal up --user-auth` hook. It receives the NARROW provisioning input
 * (core's {@link AuthPrepareInput}: operator seed + data-account pub/signingSeed + the space-scoped
 * state dir — never the whole space bundle), makes all persisted material exist, projects the ONE
 * signing seed the daemon may hold into `service-keys.json`, and hands back:
 *  - the callout account for the broker config preload,
 *  - the non-secret client metadata (trust pins) the workstation registry records ({@link
 *    assertUserAuthInfo} shape — typed in workspace, opaque to core),
 *  - the service handle: the `auth-service` command name + the readiness contract (poll the
 *    discovery file the daemon writes only after BOTH planes are bound, then confirm /health).
 */
import { registry, type AuthPrepareInput, type AuthPrepared, type AuthProvider } from "@cotal-ai/core";
import { assertUserAuthInfo, homeCotalDir, type UserAuthInfo } from "@cotal-ai/workspace";
import { fetchIdpJwt, loadIdpSession, probeIdpJwks, requireIdpSession } from "./login.js";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { findActorUnified, findInteractiveActor, grantManagedActor, newActorToken, revokeManagedActor } from "./ledger.js";
import { userAuthTrustFingerprint, validateRetainedManagedAgent } from "./continuity.js";
import {
  ensureCalloutAuth,
  ensureIssuer,
  ensureOwnerSecret,
  ensurePinnedIdp,
  loadAuthServiceInfo,
  loadCalloutAuth,
  loadOwnerSecret,
  loadPinnedIdp,
  saveServiceKeys,
} from "./store.js";

const READY_TIMEOUT_MS = 15_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const cotalAuthProvider: AuthProvider = {
  kind: "auth-provider",
  name: "cotal",
  async prepareServer(input: AuthPrepareInput): Promise<AuthPrepared> {
    const { space, dir, idpUrl } = input;
    // On a FRESH enable, prove the IdP actually serves a JWKS before we pin + provision a space
    // around it — a dead or typo'd `--idp` must fail loud here, not silently boot a broken space
    // that only errors at the first user connect. Skip on re-up (an already-pinned IdP was validated
    // at first enable; re-probing every boot would couple mesh liveness to IdP liveness).
    if (idpUrl && !loadPinnedIdp(dir)) await probeIdpJwks(idpUrl);
    // Pin the IdP FIRST, so a fresh `up --user-auth` without --idp fails on the config error before
    // any key material is generated.
    const idp = ensurePinnedIdp(dir, idpUrl);
    ensureOwnerSecret(dir);
    await ensureIssuer(dir, space);
    const callout = await ensureCalloutAuth(dir, { space, operatorSeed: input.operatorSeed, accountPub: input.account.pub });
    // The daemon's ONLY signing material: the data-account user-minting seed. Written by this
    // (briefly privileged) call; the long-lived service loads this file, never the space bundle.
    saveServiceKeys(dir, { dataAccount: { pub: input.account.pub, signingSeed: input.account.signingSeed } });

    const publicAuth: UserAuthInfo = assertUserAuthInfo({
      provider: "cotal",
      idp: { url: idp.url, issuer: idp.issuer, audience: idp.audience },
    });
    return {
      extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
      publicAuth: publicAuth as unknown as Record<string, unknown>,
      service: {
        command: "auth-service",
        // Readiness = the daemon wrote its discovery file (which it does only after the callout SUB
        // is flushed AND the HTTP listener is bound) and /health answers. Poll until timeoutMs, then
        // THROW with the reason — the caller (`up`) surfaces it loudly (U5), never records a usable
        // user mesh on a half-started service.
        async ready({ dir: stateDir, timeoutMs = READY_TIMEOUT_MS }) {
          const deadline = Date.now() + timeoutMs;
          let lastReason = "the auth service has not written its discovery file yet";
          while (Date.now() < deadline) {
            try {
              const info = loadAuthServiceInfo(stateDir);
              if (info && pidAlive(info.pid)) {
                // pid-liveness first: a STALE file from a dead prior daemon must never satisfy
                // this poll (the daemon also scrubs it at startup and on exit — belt and braces).
                const res = await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(2000) });
                if (res.ok) return { url: info.url };
                lastReason = `health probe at ${info.url}/health returned HTTP ${res.status}`;
              } else if (info) {
                lastReason = `discovery file names pid ${info.pid}, which is not running (stale entry)`;
              }
            } catch (e) {
              lastReason = e instanceof Error ? e.message : String(e);
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          // No log-path guess here — the CALLER owns the daemon's log location and appends it.
          throw new Error(`auth service not ready after ${timeoutMs}ms (${lastReason})`);
        },
      },
    };
  },

  /** Client side: this machine's login session → a fresh IdP JWT → the local auth service's
   *  exchange → the Cotal bearer, plus the space's sentinel creds. NO fallback anywhere; each
   *  failure is one sentence with the exact operator action (U1/U10/U11 acceptance strings). */
  async userCredentials({ dir, space, actor, view }: { dir: string; space: string; actor: string; view?: string }) {
    const idp = loadPinnedIdp(dir);
    const callout = loadCalloutAuth(dir);
    if (!idp || !callout)
      throw new Error(
        `space "${space}" has no user-auth material on this machine - user-mode connects run where \`cotal up --user-auth\` provisioned the space (remote discovery is not supported yet)`,
      );
    // The no-fallback login gate: throws the exact `cotal login --idp …` line when not signed in.
    const session = requireIdpSession(homeCotalDir(), idp.url);
    // Daemon liveness BEFORE the IdP round-trip: a down auth service must surface its exact
    // restart recovery (U10) without spending an IdP /token call — and without an unrelated
    // IdP/network failure masking it. Missing-login stays primary (the session gate above).
    const info = loadAuthServiceInfo(dir);
    if (!info || !pidAlive(info.pid))
      throw new Error(
        `the user-auth service for space "${space}" is not running - restart it with \`cotal up\` (or \`cotal auth-service --space ${space} --server <broker>\`)`,
      );
    // Fresh short-lived IdP proof per connect — IdP-side revocation bites HERE, at the next fetch.
    const idpJwt = await fetchIdpJwt(idp.url, session.token);
    let res: Response;
    try {
      res = await fetch(`${info.url}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
        body: JSON.stringify({ idpToken: idpJwt, actor, ...(view !== undefined ? { view } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(
        `the user-auth service for space "${space}" did not answer at ${info.url} (${e instanceof Error ? e.message : String(e)}) - restart it with \`cotal up\``,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // A refused exchange is an authenticated denial with the reason (an ungranted actor names
      // the grant command); surface it verbatim — the service's copy is already operator-exact.
      throw new Error(
        `signed in, but the exchange for actor "${actor}"${view ? ` (view "${view}")` : ""} was refused: ${body.error ?? `HTTP ${res.status}`}`,
      );
    }
    const out = (await res.json().catch(() => ({}))) as { token?: string };
    if (typeof out.token !== "string" || !out.token)
      throw new Error(`the auth service's exchange returned no token - its build may be stale; restart it with \`cotal up\``);
    return { bearer: out.token, sentinelCreds: callout.sentinelCreds };
  },

  /** WHO the local login is, as this space's derived owner — offline (cached session sub + the
   *  space's owner secret; no IdP round trip). The spawn paths' "whose agents are these" answer. */
  async ownerForLogin({ dir, space }) {
    const idp = loadPinnedIdp(dir);
    const secret = loadOwnerSecret(dir);
    if (!idp || !secret)
      throw new Error(`space "${space}" has no user-auth material on this machine - spawns for a user-auth space run where \`cotal up --user-auth\` provisioned it`);
    const session = requireIdpSession(homeCotalDir(), idp.url);
    if (!session.sub)
      throw new Error(`your cached login for ${idp.url} predates this build (no subject recorded) - re-run \`cotal login --idp ${idp.url}\``);
    return deriveOwnerForIdpSubject(secret, idp.issuer, session.sub);
  },

  /** Offline status read: the pinned IdP, this machine's cached login, and (when the local ledger
   *  has material) the actor's grant row. No IdP round trip, no service call, no mint — `cotal
   *  status` must be able to say "not signed in" without becoming a connect. */
  async userStatus({ dir, space, actor }) {
    const idp = loadPinnedIdp(dir);
    if (!idp)
      throw new Error(
        `space "${space}" has no user-auth material on this machine - user-mode status reads run where \`cotal up --user-auth\` provisioned the space`,
      );
    const session = loadIdpSession(homeCotalDir(), idp.url);
    if (!session?.sub) return { idpUrl: idp.url };
    const login = { sub: session.sub, expiresAt: session.expiresAt };
    const secret = loadOwnerSecret(dir);
    if (!secret) return { idpUrl: idp.url, login };
    const owner = deriveOwnerForIdpSubject(secret, idp.issuer, session.sub);
    const row = findInteractiveActor(dir, owner, actor);
    return {
      idpUrl: idp.url,
      login,
      owner,
      grant: row
        ? {
            scope: row.scope,
            allowSubscribe: row.allowSubscribe,
            allowPublish: row.allowPublish,
            ...(row.role ? { role: row.role } : {}),
            ...(row.label ? { label: row.label } : {}),
          }
        : "not-granted",
    };
  },

  /** Spawn-path grant authorship: one atomic MANAGED-AGENT row (its own row space — never
   *  IdP-exchangeable by construction) carrying the agent's ACLs + the hash of a fresh per-agent
   *  secret. Upsert semantics rotate the secret on respawn — a captured old secret dies the moment
   *  its agent is respawned. */
  async grantAgent({ dir, space, owner, actor, scope, allowSubscribe, allowPublish, role, parent, label }) {
    const callout = loadCalloutAuth(dir);
    if (!callout)
      throw new Error(`space "${space}" has no user-auth material under ${dir} - enable it with \`cotal up --user-auth --idp <url>\` before spawning user-mode agents`);
    const { actorToken, tokenHash } = newActorToken();
    grantManagedActor(dir, {
      owner,
      actor,
      scope,
      allowSubscribe,
      allowPublish,
      ...(role ? { role } : {}),
      ...(parent ? { parent } : {}),
      ...(label ? { label } : {}),
      tokenHash,
    });
    return { actorToken, sentinelCreds: callout.sentinelCreds };
  },

  async revokeAgent({ dir, owner, actor }) {
    return revokeManagedActor(dir, owner, actor);
  },

  /** Fresh read across BOTH row spaces (actor names are disjoint between them, so the unified
   *  lookup is unambiguous): the manager's control authorization must see an operator's
   *  `actor grant` scope edit — or a revoke — on the very next stop/attach, hence no caching. */
  async actorScope({ dir, owner, actor }) {
    const row = findActorUnified(dir, owner, actor);
    return row ? [...row.scope] : undefined;
  },

  async trustFingerprint({ dir, space }) {
    return userAuthTrustFingerprint(dir, space);
  },

  async validateRetainedAgent(opts) {
    return validateRetainedManagedAgent(opts);
  },

  agentBearerCommand: "agent-bearer",
};

registry.register(cotalAuthProvider);
