import { readFileSync, rmSync, statSync } from "node:fs";
import { type LaunchSpec, type ManagedLifecycleHandoff, type SecretStore, attemptCleanup, type CleanupFailure } from "@cotal-ai/core";
import { agentActorTokenKey, agentSentinelCredsKey, type Check, type SpaceMaterialComposition } from "@cotal-ai/workspace";
import {
  checkDialPolicy,
  checkEnforcement,
  checkServer,
  checkBundleDocument,
  persistRemoteUserEntry,
  probeEnforcement,
  tlsIntent,
  userExchangeIssuer,
  verifyUserExchange,
  type UserBundle,
} from "./meshes-add.js";

export const ENROLLMENT_URL_ENV = "COTAL_ENROLLMENT_URL";
export const ENROLLMENT_FILE_ENV = "COTAL_ENROLLMENT_FILE";

/** Remove the one line terminator a text file ends with, and nothing else: the file holds the URL
 *  and at most that terminator. Any other whitespace belongs to the credential the owner minted and
 *  must reach the URL grammar, which refuses it rather than silently redeeming a repaired URL. The
 *  environment value is taken byte for byte; nothing is stripped from it. */
export function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

export function enrollmentInput(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const rawUrl = env[ENROLLMENT_URL_ENV];
  const file = env[ENROLLMENT_FILE_ENV]?.trim();
  if (rawUrl && file)
    throw new Error(`both ${ENROLLMENT_URL_ENV} and ${ENROLLMENT_FILE_ENV} are set - pass one enrollment source, not both`);
  if (rawUrl) return rawUrl;
  if (!file) return undefined;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch (e) {
    throw new Error(`cannot read the enrollment file (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!st.isFile()) throw new Error("the enrollment file path is not a regular file");
  if (process.platform !== "win32" && (st.mode & 0o777) !== 0o600)
    throw new Error("the enrollment file must have mode 0600");
  const value = stripTrailingNewline(readFileSync(file, "utf8"));
  if (!value) throw new Error("the enrollment file is empty");
  return value;
}

export function scrubEnrollmentEnv(env: Record<string, string | undefined> | undefined): void {
  if (!env) return;
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized === ENROLLMENT_URL_ENV || normalized === ENROLLMENT_FILE_ENV) delete env[key];
  }
}

/** Carry the launching manager's validated `COTAL_MANAGER_INSTANCE` onto a managed-handoff
 *  child's connector launch spec (`spawnProcess` passes `env: spec.env` only, and `launchEnv`
 *  does not forward `COTAL_MANAGER_INSTANCE` from `process.env`). */
export function applyHandoffManagerInstance(
  spec: LaunchSpec,
  handoffManagerInstanceId: string | undefined,
): void {
  if (handoffManagerInstanceId !== undefined) {
    spec.env = { ...spec.env, COTAL_MANAGER_INSTANCE: handoffManagerInstanceId };
  }
}

export interface EnrollmentBundle extends RemoteAgentMaterial {
  space: string;
  brokerAccess: { kind: string; [key: string]: unknown };
  authServiceUrl: string;
  idp: { url: string; issuer: string; audience: string };
  server?: string;
  tlsRequired?: boolean;
  userAuth?: unknown;
  policy?: unknown;
}

export function checkEnrollmentBundle(raw: unknown, actor: string): { bundle: EnrollmentBundle; stock?: UserBundle } {
  const material = checkRemoteAgentMaterial(raw, actor);
  if (!material.ok) throw new Error(material.message.replaceAll("agent-provisioning endpoint", "enrollment endpoint"));
  const o = raw as Partial<EnrollmentBundle>;
  if (typeof o.space !== "string" || !o.space) throw new Error("the enrollment bundle names no space");
  if (o.brokerAccess === null || typeof o.brokerAccess !== "object" || typeof o.brokerAccess.kind !== "string" || !o.brokerAccess.kind)
    throw new Error("the enrollment bundle carries no brokerAccess kind");
  if (typeof o.authServiceUrl !== "string" || !o.authServiceUrl)
    throw new Error("the enrollment bundle carries no authServiceUrl");
  const idp = o.idp;
  if (idp === null || typeof idp !== "object" || typeof idp.url !== "string" || !idp.url ||
      typeof idp.issuer !== "string" || !idp.issuer || typeof idp.audience !== "string" || !idp.audience)
    throw new Error("the enrollment bundle carries no complete idp { url, issuer, audience }");
  let stock: UserBundle | undefined;
  const hasStock = [o.server, o.tlsRequired, o.userAuth].some((v) => v !== undefined);
  const rawPolicy = (o as { policy?: unknown }).policy;
  if (rawPolicy !== undefined && !hasStock)
    throw new Error("the enrollment bundle's policy requires its stock server, tlsRequired, and userAuth fields");
  if (hasStock) {
    if ([o.server, o.tlsRequired, o.userAuth].some((v) => v === undefined))
      throw new Error("the enrollment bundle's stock mesh fields must include server, tlsRequired, and userAuth together");
    const checked = checkBundleDocument({
      space: o.space,
      server: o.server,
      tlsRequired: o.tlsRequired,
      userAuth: o.userAuth,
      policy: (o as { policy?: unknown }).policy,
      sentinelCreds: material.material.sentinelCreds,
    });
    if (!checked.ok) throw new Error(checked.message.replace(/^✗\s*/, ""));
    stock = checked.value;
    if (stock.userAuth.idp.url !== idp.url || stock.userAuth.idp.issuer !== idp.issuer || stock.userAuth.idp.audience !== idp.audience)
      throw new Error("the enrollment bundle's stock userAuth IdP pins do not match its top-level idp pins");
    if (stock.userAuth.endpoints.url !== o.authServiceUrl)
      throw new Error("the enrollment bundle's stock userAuth exchange URL does not match authServiceUrl");
    const access = o.brokerAccess as Record<string, unknown>;
    if (access.kind === "direct" && (typeof access.url !== "string" || !access.url))
      throw new Error("the enrollment bundle's direct brokerAccess carries no url");
    if (access.kind === "direct" && access.url !== stock.server)
      throw new Error("the enrollment bundle's direct brokerAccess url does not match its stock server");
  }
  return { bundle: { ...o, ...material.material, idp } as EnrollmentBundle, ...(stock ? { stock } : {}) };
}

/** What a managed handoff's bootstrap refuses with at each phase that runs a check shared with the
 *  enrollment path. Those checks' diagnostics, and the filesystem errors under them, quote the
 *  space, the server, the exchange URL, the actor or a path named for one of them, and a handoff
 *  refusal never echoes the document, so each sentence names only the field and the phase. */
export const HANDOFF_REFUSALS = {
  space: "the managed handoff's space is malformed",
  bundle: "the managed handoff's mesh fields failed the user-auth bundle check",
  registration: "the managed handoff's space failed the local registration",
  target: "the managed handoff's space failed target resolution",
  server: "the managed handoff's server is not a broker URL this machine may dial",
  exchange: "the managed handoff's exchangeUrl failed the exchange check",
  enforcement: "the managed handoff's server failed the enforcement check",
  policy: "the managed handoff's exchangeUrl failed the policy refresh",
  preflight: "the managed handoff's server failed the broker preflight",
  bearer: "the managed handoff's actorToken failed the agent auth preflight",
} as const;

/** Map a parsed handoff onto the redeem consumer's shapes. Pure. */
export function handoffEnrollmentBundle(h: ManagedLifecycleHandoff): { bundle: EnrollmentBundle; stock: UserBundle } {
  const userAuth = { provider: h.authProvider, idp: h.idp, endpoints: { url: h.exchangeUrl }, remote: true };
  try {
    const { bundle, stock } = checkEnrollmentBundle({
      space: h.space, actor: h.actor, owner: h.owner, lifecycleUid: h.lifecycleUid, actorToken: h.actorToken, sentinelCreds: h.sentinelCreds,
      subscribe: h.subscribe, allowSubscribe: h.allowSubscribe, allowPublish: h.allowPublish,
      brokerAccess: { kind: "direct", url: h.server }, authServiceUrl: h.exchangeUrl, idp: h.idp,
      server: h.server, tlsRequired: h.tlsRequired, userAuth, ...(h.policy ? { policy: h.policy } : {}),
    }, h.actor);
    return { bundle, stock: stock! };
  } catch {
    throw new Error(HANDOFF_REFUSALS.bundle);
  }
}

/** With `refusals`, a step that fails its check or throws refuses with its phase's sentence instead
 *  of its diagnostic. */
export async function registerEnrollmentMesh(stock: UserBundle, root: string, refusals?: typeof HANDOFF_REFUSALS): Promise<void> {
  const step = async <T>(phase: "server" | "exchange" | "enforcement" | "registration", run: () => Check<T> | Promise<Check<T>>): Promise<T> => {
    let check: Check<T>;
    try {
      check = await run();
    } catch (e) {
      throw refusals ? new Error(refusals[phase]) : e;
    }
    if (!check.ok) throw new Error(refusals?.[phase] ?? check.message.replace(/^✗\s*/, ""));
    return check.value;
  };
  await step("server", () => checkServer(stock.server, "the enrollment bundle's server"));
  const tlsRequired = stock.tlsRequired || tlsIntent(stock.server, false);
  const dial = await step("server", () => checkDialPolicy(stock.server, { tlsRequired, allowUnencryptedOverlay: false }));
  await step("exchange", () => verifyUserExchange(stock.userAuth.endpoints.url, userExchangeIssuer(stock.space)));
  await step("enforcement", async () => checkEnforcement("user", await probeEnforcement(stock.server), stock.server, stock.space, root));
  await step("registration", () => ({ ok: true, value: persistRemoteUserEntry(stock.space, stock.server, root, stock, tlsRequired, Boolean(dial.residual)) }));
}

/** What a remote mesh's agent-provisioning endpoint returns (U6 §2). The client validates every
 *  field it uses: this arrives over the network from a deployment, so a missing or wrong-typed
 *  piece must be a named refusal here, never an `undefined` written into a 0600 file. */
export interface RemoteAgentMaterial {
  actor: string;
  owner: string;
  lifecycleUid: string;
  actorToken: string;
  sentinelCreds: string;
  subscribe?: string[];
  allowSubscribe?: string[];
  allowPublish?: string[];
}

/** Validate the provisioning response. Returns the material, or the refusal sentence. */
export function checkRemoteAgentMaterial(v: unknown, actor: string): { ok: true; material: RemoteAgentMaterial } | { ok: false; message: string; exists?: true } {
  const o = v as Partial<RemoteAgentMaterial> & { exists?: boolean };
  const bad = (m: string): { ok: false; message: string } => ({ ok: false, message: m });
  if (o === null || typeof o !== "object") return bad("the mesh's agent-provisioning endpoint did not answer with a JSON object");
  // An occupied actor carries no material. Only an implicit new launch may try a different actor.
  if (o.exists === true) return { ok: false, exists: true, message: `agent "${actor}" already exists on this mesh and its credentials were not reissued - spawn it under a different name, or ask the mesh operator to reissue it` };
  const str = (k: keyof RemoteAgentMaterial): string | undefined => (typeof o[k] === "string" && o[k] ? (o[k] as string) : undefined);
  for (const k of ["actor", "owner", "lifecycleUid", "actorToken", "sentinelCreds"] as const)
    if (!str(k)) return bad(`the mesh's agent-provisioning endpoint returned no ${k} - it cannot provision agents for this mesh`);
  const list = (k: "subscribe" | "allowSubscribe" | "allowPublish"): string[] | undefined =>
    Array.isArray(o[k]) && (o[k] as unknown[]).every((s) => typeof s === "string") ? (o[k] as string[]) : undefined;
  if (o.actor !== actor)
    return bad(`the mesh provisioned actor "${String(o.actor)}" for a request naming "${actor}" - refusing material that does not match what was asked for`);
  return {
    ok: true,
    material: {
      actor: o.actor!, owner: o.owner!, lifecycleUid: o.lifecycleUid!, actorToken: o.actorToken!, sentinelCreds: o.sentinelCreds!,
      ...(list("subscribe") ? { subscribe: list("subscribe") } : {}),
      ...(list("allowSubscribe") ? { allowSubscribe: list("allowSubscribe") } : {}),
      ...(list("allowPublish") ? { allowPublish: list("allowPublish") } : {}),
    },
  };
}

/** Shred a user-mode agent's local material: both secrets from the store, then their files and the
 *  health file. Each step is attempted and a failed one is recorded in `failed`. */
export async function shredAgentMaterial(
  failed: CleanupFailure[],
  store: SecretStore,
  space: string,
  name: string,
  composition: SpaceMaterialComposition,
  paths: { actorToken: string; sentinelCreds: string; health: string },
): Promise<void> {
  await attemptCleanup(failed, "actor token secret", () => store.delete(agentActorTokenKey(space, name, composition)));
  await attemptCleanup(failed, "sentinel creds secret", () => store.delete(agentSentinelCredsKey(space, name, composition)));
  await attemptCleanup(failed, "actor token file", () => rmSync(paths.actorToken, { force: true }));
  await attemptCleanup(failed, "sentinel creds file", () => rmSync(paths.sentinelCreds, { force: true }));
  await attemptCleanup(failed, "health file", () => rmSync(paths.health, { force: true }));
}

/** Both remote arms refuse a record that pins no exchange URL with this sentence, before any request. */
export function noExchangeEndpoint(space: string): string {
  return `mesh "${space}" records no exchange endpoint - re-register it with \`cotal meshes add ${space} --from <url> --mode user\``;
}
