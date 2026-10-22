/**
 * The daemon's local sign-in: one attempt at a time, driven through stock `establishIdpSession`,
 * which persists the session through the stock writer and fences persistence on its AbortSignal.
 *
 * Attempts are named by a daemon-minted id. A cancel names the attempt it means, so a cancel aimed
 * at a finished attempt can never stop its successor. A cancel is answered only after the attempt
 * has settled, and it answers with what actually happened: `cancelled` when the stock fence stopped
 * it before anything was persisted, `completed` when it had already finished (or finished while the
 * cancel raced it), and `not-found` for an attempt this daemon never started or no longer remembers.
 *
 * Cancelling stops this local sign-in. It does not revoke anything at the IdP.
 */
import { randomBytes } from "node:crypto";
import { establishIdpSession, IdpLoginCancelled, IdpUnreachableError } from "@cotal-ai/auth";
import type { CancelResult, LoginPrompt, LoginResult } from "./protocol.js";

/** The client id stock `cotal login` presents by default. */
export const DEFAULT_CLIENT_ID = "cotal-cli";
/** How many finished attempt ids are remembered, so a late cancel still gets a truthful answer. */
const REMEMBERED = 16;

type Establish = typeof establishIdpSession;

export interface LoginStart {
  readonly idp: string;
  readonly clientId?: string;
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
        clientId: req.clientId ?? DEFAULT_CLIENT_ID,
        signal: abort.signal,
        onPrompt: (p) => req.onPrompt(id, {
          verificationUri: p.verificationUri,
          verificationUriComplete: p.verificationUriComplete,
          userCode: p.userCode,
          expiresAt: new Date(Date.now() + p.expiresInSec * 1000).toISOString(),
        }),
      });
      return { outcome: "signed-in", idp: req.idp, sub: r.sub, ...(r.label ? { label: r.label } : {}), ...(r.previousSub ? { previousSub: r.previousSub } : {}) };
    } catch (e) {
      if (e instanceof IdpLoginCancelled) return { outcome: "cancelled" };
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof IdpUnreachableError) return { outcome: "failed", reason: "unreachable", message };
      // Stock throws plain Errors for these two IdP answers; match their exact sentences.
      if (message.startsWith("idp login: the sign-in was denied at the verification page")) return { outcome: "failed", reason: "denied", message };
      if (message.startsWith("idp login: the device code expired")) return { outcome: "failed", reason: "expired", message };
      return { outcome: "failed", reason: "refused", message };
    }
  };

  return {
    start(req) {
      if (current) return undefined;
      const id = randomBytes(16).toString("base64url").slice(0, 22);
      const abort = new AbortController();
      const settled = run(id, abort, req).then(async (result) => {
        remember(id, result.outcome);
        if (current?.id === id) current = undefined;
        await req.onResult(id, result);
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
