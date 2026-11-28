/**
 * The signer holder's start-up for an endpoint the delivery daemon serves (A1, plan section 2, E1).
 *
 * Order matters and is the plan's: the daemon starts first and binds Plane-3 and the delivery-admin
 * rail with the endpoint `unbound`. Only then does this run, because registration's barrier verify-
 * evicts a superseded serve family through that same rail, so a registration before the daemon had no
 * eviction oracle to call. Then:
 *
 *  1. load or create the persisted instance id and serve identity (the same on every start, so a
 *     restart is a takeover of the same registration);
 *  2. register and mint the serve credential behind the issuance fence (`registerDaemonEndpoint`), and
 *     mint the endpoint's store credentials;
 *  3. write every credential to the store the daemon reads;
 *  4. ask the daemon to adopt, with a fresh adoption op id; the daemon re-derives the grant, checks the
 *     candidate's rows, binds and answers what bound;
 *  5. write `ready` only when that answer names the credential just minted and the op id just sent.
 *
 * Any failure throws, so the caller (`ensureDelivery`) reports the endpoint loudly unbound. Nothing
 * here falls back to serving without the daemon's proof.
 */
import {
  ARTIFACTS_ENDPOINT, artifactsClusterArtifacts, artifactsContractArtifactValues,
  mintCreds, mintLifecycleUid, newIdentity, type ControlReply, type Profile, type SecretStore, type SpaceAuth,
} from "@cotal-ai/core";
import {
  ARTIFACT_DATA_CREDS_KIND, ARTIFACT_SWEEPER_CREDS_KIND,
  daemonEndpointKey, DAEMON_ENDPOINT_SERVE_CREDS_KIND, loadOrCreateDaemonEndpointInstanceId,
  loadOrCreateDaemonEndpointServeIdentity,
} from "./daemon-endpoint-material.js";
import { registerDaemonEndpoint, remintDaemonEndpointServe, writeDaemonEndpointReady, type DaemonEndpointContract } from "./daemon-endpoint-registration.js";
import { DELIVERY_ADMIN_BOOT_WAIT_MS, isUnansweredDeliveryAdmin, untilDeliveryAdminAnswers, withScopedEndpoint } from "./endpoint-evict.js";

/** A store credential a served endpoint needs beside its serve credential: the profile it is minted
 *  under and the material kind it is written to. Its nkey is fresh on every mint. */
export interface DaemonEndpointStoreCred {
  profile: Profile;
  kind: string;
}

/** What one delivery-served endpoint needs from the signer holder. */
export interface DaemonEndpointBootstrap extends DaemonEndpointContract {
  storeCreds: readonly DaemonEndpointStoreCred[];
}

/** The endpoints the signer holder can bootstrap for a delivery daemon, by the name `--serve` takes. */
export const DAEMON_ENDPOINT_BOOTSTRAPS: Readonly<Record<string, () => DaemonEndpointBootstrap>> = Object.freeze({
  [ARTIFACTS_ENDPOINT]: () => ({
    endpoint: ARTIFACTS_ENDPOINT,
    cluster: artifactsClusterArtifacts(),
    artifactValues: artifactsContractArtifactValues,
    storeCreds: [
      { profile: "artifact-data" as const, kind: ARTIFACT_DATA_CREDS_KIND },
      { profile: "artifact-sweeper" as const, kind: ARTIFACT_SWEEPER_CREDS_KIND },
    ],
  }),
});

/** Parse the endpoint names `cotal up --serve` takes: comma-separated, deduplicated, each one an
 *  endpoint the signer holder can bootstrap. Throws naming the unknown names and the known ones. */
export function parseServeEndpoints(raw: string): string[] {
  const names = [...new Set(raw.split(",").map((n) => n.trim()).filter((n) => n.length > 0))];
  if (names.length === 0) throw new Error("--serve needs an endpoint name (for example --serve artifacts)");
  const unknown = names.filter((n) => !Object.hasOwn(DAEMON_ENDPOINT_BOOTSTRAPS, n));
  if (unknown.length)
    throw new Error(`--serve ${unknown.join(",")}: the delivery daemon serves only ${Object.keys(DAEMON_ENDPOINT_BOOTSTRAPS).join(", ")}`);
  return names;
}

/** A daemon whose lease is ready but whose start-up has not finished refuses an adoption with this
 *  text, adopting nothing. The launcher returns as soon as the lease is ready, so the first adoption
 *  can land in that window; it is waited out like an unanswered rail, not reported as a failure. */
const STILL_STARTING = /has not finished starting; nothing adopted/;

class DaemonStillStarting extends Error {}

/** Send one delivery-admin request on a scoped, short-lived `endpoint-evictor` credential: the one
 *  profile that publishes exactly that rail and nothing else. */
async function deliveryAdmin(
  target: { space: string; servers: string; auth: SpaceAuth; tls?: boolean },
  op: string,
  args: Record<string, unknown>,
  log: (line: string) => void,
): Promise<ControlReply> {
  let last: ControlReply | undefined;
  try {
    return await untilDeliveryAdminAnswers(DELIVERY_ADMIN_BOOT_WAIT_MS, async (requestMs) => {
      const reply = await withScopedEndpoint({ space: target.space, servers: target.servers, auth: target.auth, tlsRequired: target.tls }, "endpoint-evictor", `delivery-endpoint-${op}`,
        (ep) => ep.requestDeliveryAdmin(op, args, requestMs(20_000)));
      if (!reply.ok && STILL_STARTING.test(reply.error ?? "")) { last = reply; throw new DaemonStillStarting(reply.error); }
      return reply;
    },
    (reason, delayMs) => log(`• ${String(args.endpoint)}: waiting for the delivery daemon's admin rail (${reason}); retrying in ${delayMs}ms`),
    (e) => e instanceof DaemonStillStarting || isUnansweredDeliveryAdmin(e));
  } catch (e) {
    // The wait ended while the daemon was still starting: its own refusal is the answer.
    if (e instanceof DaemonStillStarting && last !== undefined) return last;
    throw e;
  }
}

/** Register a delivery-served endpoint, hand its credentials to the daemon, and write `ready` on the
 *  daemon's proof. Returns the epoch it bound at. */
export async function bootstrapDaemonEndpoint(
  target: { auth: SpaceAuth; servers: string; space: string; tls?: boolean; store: SecretStore; log: (line: string) => void },
  endpoint: DaemonEndpointBootstrap,
): Promise<{ epoch: number; instanceId: string }> {
  return handOver(target, endpoint, "register");
}

/** Renew a delivery-served endpoint's three credentials (the manager's renewal pass): re-mint the serve
 *  credential for the same registration at the current epoch behind the fence, re-mint the store
 *  credentials, and have the daemon adopt them. The daemon binds the candidate only after its own
 *  checks, and keeps the last-good connection serving on any refusal; `ready` is rewritten only when
 *  it reports this exact credential bound. Throws on any refusal, so the caller records it loudly. */
export async function renewDaemonEndpoint(
  target: { auth: SpaceAuth; servers: string; space: string; tls?: boolean; store: SecretStore; log: (line: string) => void },
  endpoint: DaemonEndpointBootstrap,
): Promise<{ epoch: number; instanceId: string }> {
  return handOver(target, endpoint, "remint");
}

async function handOver(
  target: { auth: SpaceAuth; servers: string; space: string; tls?: boolean; store: SecretStore; log: (line: string) => void },
  endpoint: DaemonEndpointBootstrap,
  mode: "register" | "remint",
): Promise<{ epoch: number; instanceId: string }> {
  const { store, space, log } = target;
  const name = endpoint.endpoint;
  const instanceId = await loadOrCreateDaemonEndpointInstanceId(store, space, name);
  const serveIdentity = await loadOrCreateDaemonEndpointServeIdentity(store, space, name);
  const reg = { auth: target.auth, servers: target.servers, space, tls: target.tls, instanceId, serveIdentity, log };
  const minted = mode === "register" ? await registerDaemonEndpoint(reg, endpoint) : await remintDaemonEndpointServe(reg, endpoint);
  for (const cred of endpoint.storeCreds)
    await store.put(daemonEndpointKey(space, name, cred.kind), await mintCreds(target.auth, newIdentity(), cred.profile));
  await store.put(daemonEndpointKey(space, name, DAEMON_ENDPOINT_SERVE_CREDS_KIND), minted.creds);
  const adoptionOpId = mintLifecycleUid();
  const adopted = await deliveryAdmin(target, "adoptEndpointCreds", { endpoint: name, adoptionOpId }, log);
  if (!adopted.ok) throw new Error(`${name}: the delivery daemon did not bind the credential just minted: ${adopted.error}`);
  const reply = await deliveryAdmin(target, "serveState", { endpoint: name }, log);
  if (!reply.ok) throw new Error(`${name}: the delivery daemon did not report its serve state: ${reply.error}`);
  const state = reply.data as { bound?: boolean; state?: { epoch?: unknown; credentialFingerprint?: unknown; adoptionOpId?: unknown; instanceId?: unknown } } | undefined;
  const s = state?.state;
  if (state?.bound !== true || s === undefined || typeof s.epoch !== "number" || typeof s.credentialFingerprint !== "string")
    throw new Error(`${name}: the delivery daemon reports it unbound after adoption (${JSON.stringify(state ?? null)}); ready was not written`);
  if (s.adoptionOpId !== adoptionOpId || s.instanceId !== instanceId)
    throw new Error(`${name}: the delivery daemon reports a bind from another adoption (op ${String(s.adoptionOpId)}), not the one just sent; ready was not written`);
  await writeDaemonEndpointReady(reg, name, minted, { epoch: s.epoch, credentialFingerprint: s.credentialFingerprint });
  log(`✓ ${name}: ${mode === "register" ? "registered" : "renewed"}, bound by the delivery daemon at epoch ${s.epoch}, ready`);
  return { epoch: s.epoch, instanceId };
}
