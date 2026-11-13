/**
 * The daemon's local sign-in: one attempt at a time, driven through stock `establishIdpSession`,
 * which persists the session through the stock writer and fences persistence on its AbortSignal.
 *
 * Attempts are named by a daemon-minted id. A cancel names the attempt it means, so a cancel aimed
 * at a finished attempt can never stop its successor. A cancel is answered only after the attempt
 * has settled, meaning its result has been delivered to the requester, and it answers with what
 * actually happened: `cancelled` when the stock fence stopped it before anything was persisted,
 * `completed` when it had already finished (or finished while the cancel raced it), and `not-found`
 * for an attempt this daemon never started or no longer remembers. Until that delivery the attempt
 * stays in flight, so no second sign-in starts underneath an undelivered result.
 *
 * Provider failures cross the endpoint as a fixed sentence per reason. Only typed local cache
 * refusals retain stock's safe diagnosis and recovery step.
 *
 * Cancelling stops this local sign-in. It does not revoke anything at the IdP.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { deleteIdpSpaceCatalog, establishIdpSession, IdpDeviceAuthorizationRefusedError, IdpLoginCancelled, IdpUnreachableError } from "@cotal-ai/auth";
import { homeCotalDir, isCommandFailure, removeCatalogAccount, type KeptCatalogCredential } from "@cotal-ai/workspace";
import type { CancelResult, LoginPrompt, LoginResult } from "./protocol.js";

/** The client id stock `cotal login` presents by default. */
export const DEFAULT_CLIENT_ID = "cotal-cli";
/** How many finished attempt ids are remembered, so a late cancel still gets a truthful answer. */
const REMEMBERED = 16;

type FailReason = Exclude<Extract<LoginResult, { outcome: "failed" }>["reason"], "local-state-error">;
/** Provider failure sentences. They never quote the provider or a stock error. */
const FAILURE: Record<FailReason, string> = {
  denied: "the sign-in was denied at the verification page",
  expired: "the approval code expired before the sign-in was approved",
  unreachable: "the provider could not be reached",
  "authorization-refused": "the provider refused device authorization; check --idp uses the auth base URL and --client-id is accepted by the provider",
  refused: "the provider's answer could not be used to sign in",
};
const failed = (reason: FailReason): LoginResult => ({ outcome: "failed", reason, message: FAILURE[reason] });

type Establish = typeof establishIdpSession;

export interface LoginStart {
  readonly idp: string;
  readonly clientId?: string;
  readonly discoveryPins?: { url: string; issuer: string; audience: string };
  readonly onPrompt: (attempt: string, prompt: LoginPrompt) => void;
  /** Deliver the terminal result to the requester. The attempt counts as settled, for a cancel's
   *  answer, only once this resolves, so a cancel ack never overtakes the result it reports. */
  readonly onResult: (attempt: string, result: LoginResult) => Promise<void>;
}

interface Attempt {
  readonly id: string;
  readonly abort: AbortController;
  readonly settled: Promise<LoginResult>;
}

export interface LoginCoordinator {
  /** Start a sign-in, or return undefined when one is already in flight (nothing is sent to the IdP). */
  start(req: LoginStart): { attempt: string; settled: Promise<LoginResult> } | undefined;
  /** Cancel the named attempt; resolves once it has settled, with the true outcome. */
  cancel(attempt: string): Promise<CancelResult>;
  /** Abort the in-flight attempt (daemon shutdown) and wait for it to settle. */
  close(): Promise<void>;
}

export function createLoginCoordinator(opts: { readonly sessionDir: string; readonly establish?: Establish }): LoginCoordinator {
  const establish = opts.establish ?? establishIdpSession;
  let current: Attempt | undefined;
  const finished = new Map<string, LoginResult["outcome"]>();
  const remember = (id: string, outcome: LoginResult["outcome"]) => {
    finished.set(id, outcome);
    while (finished.size > REMEMBERED) finished.delete(finished.keys().next().value!);
  };

  const run = async (id: string, abort: AbortController, req: LoginStart): Promise<LoginResult> => {
    try {
      const r = await establish({
        dir: opts.sessionDir,
        idpUrl: req.idp,
        discoveryPins: req.discoveryPins,
        clientId: req.clientId ?? DEFAULT_CLIENT_ID,
        signal: abort.signal,
        onPrompt: (p) => req.onPrompt(id, {
          verificationUri: p.verificationUri,
          verificationUriComplete: p.verificationUriComplete,
          userCode: p.userCode,
          expiresAt: new Date(Date.now() + p.expiresInSec * 1000).toISOString(),
        }),
      });
      let credentialsKept: KeptCatalogCredential[] = [];
      if (r.previousSub) {
        const owner = deleteIdpSpaceCatalog(opts.sessionDir, req.idp, r.previousSub);
        // A separate daemon owns its catalog cache, not the shared registry or its credentials.
        if (resolve(opts.sessionDir) === resolve(homeCotalDir())) ({ credentialsKept } = removeCatalogAccount(owner));
      }
      return { outcome: "signed-in", idp: req.idp, sub: r.sub, ...(r.label ? { label: r.label } : {}), ...(r.previousSub ? { previousSub: r.previousSub } : {}), ...(credentialsKept.length ? { credentialsKept } : {}) };
    } catch (e) {
      if (e instanceof IdpLoginCancelled) return { outcome: "cancelled" };
      if (e instanceof IdpUnreachableError) return failed("unreachable");
      if (e instanceof IdpDeviceAuthorizationRefusedError) return failed("authorization-refused");
      // Only stock's typed local-state refusal is safe to relay. Never relay a provider error.
      if (isCommandFailure(e) && e.code === "DEPENDENCY_UNAVAILABLE")
        return { outcome: "failed", reason: "local-state-error", message: e.message, remedy: e.remedy };
      // Stock throws plain Errors for these two IdP answers; match their exact sentences.
      const message = e instanceof Error ? e.message : "";
      if (message.startsWith("idp login: the sign-in was denied at the verification page")) return failed("denied");
      if (message.startsWith("idp login: the device code expired")) return failed("expired");
      return failed("refused");
    }
  };

  return {
    start(req) {
      if (current) return undefined;
      const id = randomBytes(16).toString("base64url").slice(0, 22);
      const abort = new AbortController();
      const settled = run(id, abort, req).then(async (result) => {
        try {
          await req.onResult(id, result);
        } finally {
          remember(id, result.outcome);
          if (current?.id === id) current = undefined;
        }
        return result;
      });
      current = { id, abort, settled };
      return { attempt: id, settled };
    },
    async cancel(attempt) {
      if (current?.id === attempt) {
        const live = current;
        live.abort.abort();
        const result = await live.settled;
        return { outcome: result.outcome === "cancelled" ? "cancelled" : "completed", attempt };
      }
      const past = finished.get(attempt);
      if (past === undefined) return { outcome: "not-found", attempt };
      return { outcome: past === "cancelled" ? "cancelled" : "completed", attempt };
    },
    async close() {
      const live = current;
      if (!live) return;
      live.abort.abort();
      await live.settled;
    },
  };
}
