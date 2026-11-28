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
import { resolveSpaceCatalogConsumer } from "@cotal-ai/core";
import { commitStagedIdpSession, deleteIdpSpaceCatalog, establishIdpSession, fetchStagedIdpSpaceCatalog, IdpDeviceAuthorizationRefusedError, IdpLoginCancelled, IdpUnreachableError, normalizeIdpUrl, signedInMachineAccounts, stageIdpSession } from "@cotal-ai/auth";
import { CommandFailure, homeCotalDir, isCommandFailure, loadMeshes, removeCatalogAccount, resolveNativeMigration, withProjectTrustMigration, type KeptCatalogCredential } from "@cotal-ai/workspace";
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

interface LoginStart {
  readonly idp: string;
  readonly clientId?: string;
  readonly discoveryPins?: { url: string; issuer: string; audience: string };
  readonly migrateFrom?: string;
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

const localMigrationRefusal = (message: string, remedy: string): CommandFailure =>
  new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", message, { remedy });

function translateMigrationError(e: unknown): unknown {
  if (e instanceof IdpLoginCancelled || e instanceof IdpUnreachableError || e instanceof IdpDeviceAuthorizationRefusedError || isCommandFailure(e)) return e;
  const msg = e instanceof Error ? e.message : "";
  if (msg.startsWith("idp login: the sign-in was denied at the verification page") || msg.startsWith("idp login: the device code expired")) return e;
  if (msg.startsWith("idp login: the approved account does not match") || msg === "catalog migration requires the same issuer and subject")
    return localMigrationRefusal("The account approved in your browser does not match the previous sign-in, so nothing was moved.", "Approve with the same account, or open Space conflicts to sign out of the previous provider.");
  if (msg.startsWith("idp login: the old account sign-in or catalog state changed during approval") || msg === "catalog migration registry changed after preparation")
    return localMigrationRefusal("Your saved sign-in or space registrations changed while waiting for approval, so nothing was moved.", "Refresh spaces and try the move again.");
  if (msg === "catalog migration requires an undamaged registry")
    return localMigrationRefusal("Some local space registrations could not be read, so nothing was moved.", "Repair the damaged registration records and try again.");
  if (msg === "catalog migration cannot migrate an unavailable owned space")
    return localMigrationRefusal("One of your spaces is currently unavailable at the new provider, so nothing was moved.", "Wait until all of your spaces are available and try the move again.");
  if (msg === "catalog migration must preserve the owned space ID set" || msg === "catalog migration must preserve owned space IDs and slugs" || msg === "catalog migration requires unique catalog-owned stable space IDs" || msg === "catalog migration repeats a space ID")
    return localMigrationRefusal("Your spaces at the new address do not match the spaces saved under the previous address, so nothing was moved.", "Open Space conflicts to sign out of the previous provider or keep individual registrations.");
  if (msg.startsWith("catalog migration "))
    return localMigrationRefusal("The saved space registrations could not be verified for an automatic move, so nothing was changed.", "Refresh spaces, or open Space conflicts to sign out of the previous provider.");
  return e;
}

async function runEndorsedMigration(sessionDir: string, id: string, abort: AbortController, req: LoginStart): Promise<LoginResult> {
  if (resolve(sessionDir) !== resolve(homeCotalDir()))
    throw localMigrationRefusal("Account migration requires the default Cotal home.", "Run the desktop app with the default Cotal home and try again.");
  const oldUrl = normalizeIdpUrl(req.migrateFrom!);
  const targetUrl = normalizeIdpUrl(req.idp);
  const entries = loadMeshes().filter((entry) => entry.origin === "catalog" && entry.userAuth && normalizeIdpUrl(entry.userAuth.idp.url) === oldUrl);
  const pins = new Map(entries.map((entry) => [JSON.stringify([entry.userAuth!.idp.issuer, entry.userAuth!.idp.audience]), entry.userAuth!.idp]));
  if (!entries.length || pins.size !== 1)
    throw localMigrationRefusal("No single trusted account registration was found at the previous provider address.", "Open Space conflicts to sign out of that provider or keep the existing registrations.");
  const trusted = [...pins.values()][0]!;
  const accounts = signedInMachineAccounts(sessionDir).filter((account) => account.idpUrl === oldUrl);
  const oldAccount = accounts[0];
  if (accounts.length !== 1 || !oldAccount || oldAccount.issuer !== trusted.issuer || entries.some((entry) => entry.catalogOwner !== oldAccount.ownerKey))
    throw localMigrationRefusal("The previous provider account is not signed in on this computer.", "Refresh spaces and open Space conflicts to replace or keep the existing registrations.");
  const consumer = resolveSpaceCatalogConsumer();
  if (!consumer.prepareMigration)
    throw localMigrationRefusal("Space catalog migration is unavailable in this daemon.", "Restart the background service and try again.");
  let resolution: Awaited<ReturnType<typeof resolveNativeMigration>>;
  try {
    resolution = await resolveNativeMigration({ url: oldUrl, issuer: trusted.issuer, audience: trusted.audience });
  } catch (e) {
    if (e instanceof IdpUnreachableError) throw e;
    throw localMigrationRefusal("The previous provider address could not be verified as endorsing this move.", "Refresh spaces and open Space conflicts to sign out of the previous provider or keep the existing registrations.");
  }
  const idp = normalizeIdpUrl(resolution.bundle.userAuth.idp.url);
  if (idp !== targetUrl)
    throw localMigrationRefusal("The previous provider address does not endorse moving to the selected provider.", "Open Space conflicts to sign out of the previous provider or keep the existing registrations.");
  try {
    const candidate = await stageIdpSession({
      dir: sessionDir,
      idpUrl: idp,
      migrationFrom: oldUrl,
      clientId: req.clientId ?? DEFAULT_CLIENT_ID,
      expectedPins: { idpUrl: idp, issuer: trusted.issuer, audience: trusted.audience, sub: oldAccount.sub },
      signal: abort.signal,
      onPrompt: (p) => req.onPrompt(id, {
        verificationUri: p.verificationUri,
        verificationUriComplete: p.verificationUriComplete,
        userCode: p.userCode,
        expiresAt: new Date(Date.now() + p.expiresInSec * 1000).toISOString(),
      }),
    });
    if (abort.signal.aborted) throw new IdpLoginCancelled();
    const catalog = await fetchStagedIdpSpaceCatalog(candidate, consumer.validate);
    if (abort.signal.aborted) throw new IdpLoginCancelled();
    let committed: ReturnType<typeof commitStagedIdpSession> | undefined;
    await withProjectTrustMigration(true, false, async () => {
      const commit = consumer.prepareMigration!(oldAccount, catalog.account, catalog.snapshot);
      committed = commitStagedIdpSession(candidate);
      commit();
    });
    return { outcome: "signed-in", idp, sub: candidate.sub, ...(committed?.label ? { label: committed.label } : {}) };
  } catch (e) {
    throw translateMigrationError(e);
  }
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
      if (req.migrateFrom !== undefined) return await runEndorsedMigration(opts.sessionDir, id, abort, req);
      const r = await establish({
        dir: opts.sessionDir,
        idpUrl: req.idp,
        expectedPins: req.discoveryPins && { idpUrl: req.discoveryPins.url, issuer: req.discoveryPins.issuer, audience: req.discoveryPins.audience },
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
