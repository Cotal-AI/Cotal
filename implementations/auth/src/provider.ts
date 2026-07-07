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
import { fetchIdpJwt, requireIdpSession } from "./login.js";
import {
  ensureCalloutAuth,
  ensureIssuer,
  ensureOwnerSecret,
  ensurePinnedIdp,
  loadAuthServiceInfo,
  loadCalloutAuth,
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
  async userCredentials({ dir, space, actor }: { dir: string; space: string; actor: string }) {
    const idp = loadPinnedIdp(dir);
    const callout = loadCalloutAuth(dir);
    if (!idp || !callout)
      throw new Error(
        `space "${space}" has no user-auth material on this machine — user-mode connects run where \`cotal up --user-auth\` provisioned the space (remote discovery is not supported yet)`,
      );
    // The no-fallback login gate: throws the exact `cotal login --idp …` line when not signed in.
    const session = requireIdpSession(homeCotalDir(), idp.url);
    // Fresh short-lived IdP proof per connect — IdP-side revocation bites HERE, at the next fetch.
    const idpJwt = await fetchIdpJwt(idp.url, session.token);
    const info = loadAuthServiceInfo(dir);
    if (!info || !pidAlive(info.pid))
      throw new Error(
        `the user-auth service for space "${space}" is not running — restart it with \`cotal up\` (or \`cotal auth-service --space ${space} --server <broker>\`)`,
      );
    let res: Response;
    try {
      res = await fetch(`${info.url}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
        body: JSON.stringify({ idpToken: idpJwt, actor }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(
        `the user-auth service for space "${space}" did not answer at ${info.url} (${e instanceof Error ? e.message : String(e)}) — restart it with \`cotal up\``,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // A refused exchange is an authenticated denial with the reason (an ungranted actor names
      // the grant command); surface it verbatim — the service's copy is already operator-exact.
      throw new Error(`signed in, but the exchange for actor "${actor}" was refused: ${body.error ?? `HTTP ${res.status}`}`);
    }
    const out = (await res.json().catch(() => ({}))) as { token?: string };
    if (typeof out.token !== "string" || !out.token)
      throw new Error(`the auth service's exchange returned no token — its build may be stale; restart it with \`cotal up\``);
    return { bearer: out.token, sentinelCreds: callout.sentinelCreds };
  },
};

registry.register(cotalAuthProvider);
