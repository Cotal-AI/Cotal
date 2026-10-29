/** User-auth composition for the controller-owned stack. It reuses the native preparation that
 *  `up.ts` owns (`authSetup` through `prepareServer`), the auth package's `auth-service` adapter
 *  and child, the provider's own `service.ready({dir, pid})`, the existing local login read
 *  (`userStatus`), and the provider's `confirmLogin` before a manager start. It mints nothing,
 *  grants nothing and invents no endpoint.
 *
 *  Limits kept from the native seams, never weakened:
 *  - The auth-service child serves only a registered plain loopback broker (`targetFor` in the
 *    auth adapter). A TLS-required or non-loopback user stack refuses before any effect.
 *  - Readiness of a user stack's manager uses the invoking user's signed-in, granted login
 *    (`userViewAuth("manager-caller")`). No static or borrowed caller replaces it. Without that
 *    login the manager is not attempted and the result is a known partial `AUTH_REQUIRED`. Its stop
 *    reads the manager's own local receipt, so the folder's owner stops it without a sign-in.
 *  - The registry entry for a first enable is recorded before the auth service exists, because the
 *    adapter resolves a registered user target. It carries only the prepared trust pins and is
 *    reported as incomplete until the provider's readiness for the exact child process answers. */
import { resolveAuthProvider, type AuthPrepared } from "@cotal-ai/core";
import {
  CommandFailure, assertRecordIdentity, assertUserAuthInfo, CLI_USER_ACTOR, findMesh, hasUserAuthState, userAuthStateDir,
  workspaceSecretStore, type UserAuthInfo,
} from "@cotal-ai/workspace";
import { serviceInstanceStore, type ServiceInstanceSnapshot } from "../lib/service-instances.js";

/** The prepared material a user stack's broker preparation returns. Private to this process. */
export interface StackUserPrepared { prepared: AuthPrepared; stateDir: string }

/** The registered user transport the native auth-service child accepts: plain loopback only. */
export function assertUserStackTransport(server: string, tlsRequired: boolean): void {
  let url: URL;
  try { url = new URL(server.includes("://") ? server : `nats://${server}`); }
  catch { throw new CommandFailure("refused", "UNSUPPORTED", "the user stack's broker address is not one URL; nothing was prepared"); }
  if (tlsRequired || url.protocol !== "nats:" || !["127.0.0.1", "[::1]", "::1"].includes(url.hostname))
    throw new CommandFailure("refused", "UNSUPPORTED", "the controller auth service requires a plain loopback IP address; TLS, DNS and remote broker requirements were not weakened and nothing was prepared", { target: { server, tlsRequired } });
}

/** The pre-effect half of a first user-auth enable, run before the stack writes any journal,
 *  space trust, broker configuration or registry entry. It reads the provider's existing pin and,
 *  on a first enable, proves the IdP serves a JWKS, through the provider's own read-only
 *  `preflightServer`. A provider without that hook refuses: no check is skipped silently. The
 *  provider's `prepareServer` repeats these checks authoritatively later, so a race is still
 *  caught there and its effects are reported, never rolled back. */
export async function preflightUserStack(root: string, space: string, idpUrl: string | undefined): Promise<void> {
  let provider;
  try { provider = resolveAuthProvider(); }
  catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "no single auth provider is installed, so a user-auth stack cannot be prepared; no stack was prepared", { target: { root, space }, native: { code: "AUTH_PROVIDER", outcome: "refused", detail: (error as Error).message } }); }
  if (!provider.preflightServer) throw new CommandFailure("refused", "UNSUPPORTED", "the installed auth provider has no read-only server preflight, so a user-auth stack cannot check its inputs before writing trust; no stack was prepared", { target: { root, space, provider: provider.name } });
  const dir = userAuthStateDir(root, space, { readOnly: true });
  let verdict;
  try { verdict = await provider.preflightServer({ space, dir, ...(idpUrl !== undefined ? { idpUrl } : {}) }); }
  catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the auth provider's read-only preflight did not answer; no stack was prepared", { target: { root, space }, native: { code: "AUTH_PREFLIGHT", outcome: "refused" } }); }
  if (verdict.ok) return;
  const code = verdict.reason === "required" || verdict.reason === "invalid" ? "USAGE_INVALID" : verdict.reason === "conflict" ? "CONFLICT" : "DEPENDENCY_UNAVAILABLE";
  const remedy = verdict.reason === "required" ? "cotal up --user-auth --idp <auth base URL>"
    : verdict.reason === "conflict" ? "run bare `cotal up` to keep the space's pinned IdP; re-pointing it is a deliberate migration"
      : verdict.reason === "invalid" ? "pass an https IdP auth base URL, or http on a loopback IP, without credentials, a query or a fragment"
        : "check --idp <auth base URL>; it must serve <base>/jwks";
  const message = verdict.reason === "required" ? "a first user-auth stack needs the IdP it trusts; no stack was prepared"
    : verdict.reason === "unavailable" ? "the configured IdP did not serve usable JWKS; no stack was prepared"
      : "the auth provider refused this stack's IdP before preparation; no stack was prepared";
  // Malformed inputs or pins can contain credentials. Preserve the typed cause, not their bytes.
  const detail = verdict.reason === "invalid" || verdict.reason === "conflict" ? "the IdP input or existing pin was refused; no input was echoed" : verdict.message;
  throw new CommandFailure("refused", code, message, { target: { root, space }, native: { code: `AUTH_PREFLIGHT_${verdict.reason.toUpperCase()}`, outcome: "refused", detail }, remedy });
}

/** The existing local login and interactive grant for the CLI actor, read without any network.
 *  `ready` means a signed-in login whose locally readable ledger holds a granted CLI row. */
export async function userLoginState(root: string, space: string): Promise<{ state: "ready" | "absent" | "not-granted"; idpUrl?: string } | { state: "unreadable" }> {
  try {
    const status = await resolveAuthProvider().userStatus({ store: workspaceSecretStore(root), dir: userAuthStateDir(root, space, { readOnly: true }), space, actor: CLI_USER_ACTOR });
    if (!status.login) return { state: "absent", idpUrl: status.idpUrl };
    if (!status.grant || status.grant === "not-granted") return { state: "not-granted", idpUrl: status.idpUrl };
    return { state: "ready", idpUrl: status.idpUrl };
  } catch { return { state: "unreadable" }; }
}

/** The refusal a user stack reports when the manager cannot be attempted for want of a login.
 *  `then` is the step after the sign-in: a bare `up` again, or the manager command that was refused. */
export function userLoginRequired(space: string, login: Awaited<ReturnType<typeof userLoginState>> | { state: "rejected"; idpUrl?: string }, then = "run bare `cotal up` again"): CommandFailure {
  const idp = "idpUrl" in login && login.idpUrl ? ` --idp ${login.idpUrl}` : "";
  const message = login.state === "not-granted"
    ? "the signed-in user has no granted interactive row for the CLI in this space; the manager was not attempted"
    : login.state === "unreadable"
      ? "this machine's login for the space could not be read; the manager was not attempted"
      : login.state === "rejected"
        ? "the IdP rejected this machine's sign-in, which has expired or was revoked; the manager was not attempted"
        : "no user is signed in for this space; the manager was not attempted";
  const remedy = login.state === "not-granted"
    ? `ask the space owner to grant the CLI actor, then ${then}`
    : `cotal login${idp}, then ${then}`;
  return new CommandFailure("refused", "AUTH_REQUIRED", message, { target: { space }, remedy });
}

/** Refuse a start of the manager of a user-auth space that `root` hosts while no signed-in, granted
 *  login exists: its readiness is read as that login, so it could not be confirmed. `manager start`
 *  and `restart`, `up` and a team boot all start the manager behind this check. A space registered here from
 *  another host needs the login alone, since its grant is not readable here. The cached login is
 *  then confirmed with its IdP, so one the IdP rejects as expired or revoked is refused the same way.
 *  Any other failure of that check, such as an IdP that does not answer, is left to the launch,
 *  which reports it as before. Runs before a definition is saved, a running manager stopped or a
 *  child launched. */
export async function assertManagerLogin(root: string, space: string, then: string): Promise<void> {
  const registered = findMesh(space)?.userAuth;
  // The IdP the remedy names. A stopped stack, such as one a team boot resumes, has no registration,
  // so the hosting folder's own pin comes first.
  let idpUrl = registered?.idp.url;
  if (registered?.remote !== true) {
    if (!hasUserAuthState(root, space, { readOnly: true })) return;
    const login = await userLoginState(root, space);
    if (login.state !== "ready") throw userLoginRequired(space, login, then);
    idpUrl = login.idpUrl ?? idpUrl;
  }
  const provider = resolveAuthProvider();
  if (!provider.confirmLogin) throw new CommandFailure("refused", "UNSUPPORTED", "the installed auth provider cannot confirm a login with its IdP; the manager was not attempted", { target: { space, provider: provider.name } });
  let answer: "confirmed" | "signed-out" | "rejected";
  try { answer = await provider.confirmLogin({ dir: userAuthStateDir(root, space, { readOnly: true }), space }); }
  catch { return; }
  if (answer !== "confirmed") throw userLoginRequired(space, { state: answer === "rejected" ? "rejected" : "absent", idpUrl }, then);
}

/** The provisional registry metadata: the prepared trust pins only. No endpoint is copied from a
 *  declaration or guessed; the auth service's own readiness supplies them afterwards. */
export function provisionalUserAuth(setup: StackUserPrepared): UserAuthInfo {
  return assertUserAuthInfo({ ...setup.prepared.publicAuth });
}

/** Ask the provider whether the exact controller child is serving, bound to that child's
 *  creation-pinned PID. The endpoints come only from the provider's answer, which reads the
 *  daemon's own discovery file and probes `/health`. The PID is checked again afterwards, so a
 *  recycled PID never contributes an endpoint. */
export async function confirmUserAuthEndpoints(setup: StackUserPrepared, space: string, instance: ServiceInstanceSnapshot): Promise<UserAuthInfo> {
  const process_ = serviceInstanceStore(space).read(instance.name)?.record.value.process;
  if (!process_ || assertRecordIdentity(process_).kind !== "match")
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the started auth-service child is no longer the recorded creation-pinned process; its endpoints were not read", { target: { space, instanceId: instance.name } });
  let raw: Record<string, unknown>;
  try { raw = await setup.prepared.service.ready({ dir: setup.stateDir, pid: process_.pid }); }
  catch (error) { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the auth-service child reported its startup, but the provider's readiness for that process did not confirm its endpoints", { target: { space, instanceId: instance.name }, native: { code: "AUTH_READY", outcome: "unknown", detail: (error as Error).message } }); }
  if (assertRecordIdentity(process_).kind !== "match")
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the auth-service child changed while its endpoints were read; they were not recorded", { target: { space, instanceId: instance.name } });
  const base = typeof raw.publicUrl === "string" ? raw.publicUrl : typeof raw.url === "string" ? raw.url : undefined;
  if (!base) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the provider's readiness named no exchange endpoint; none was recorded", { target: { space, instanceId: instance.name } });
  return assertUserAuthInfo({ ...setup.prepared.publicAuth, endpoints: { url: base, ...(typeof raw.publicUrl === "string" ? { managerAuthorityUrl: `${base.replace(/\/$/, "")}/manager-service-authority` } : {}) } });
}

/** Whether the registered entry still lacks the endpoints a confirmed auth service records. */
export function userRegistrationIncomplete(space: string): boolean {
  const entry = findMesh(space);
  return entry?.mode === "user" && entry.userAuth?.endpoints?.url === undefined;
}
