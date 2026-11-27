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
  mintCreds, mintLifecycleUid, newIdentity, type ControlReply, type Profile, type SecretStore, type SpaceAuth,
} from "@cotal-ai/core";
import {
  daemonEndpointKey, DAEMON_ENDPOINT_SERVE_CREDS_KIND, loadOrCreateDaemonEndpointInstanceId,
  loadOrCreateDaemonEndpointServeIdentity,
} from "./daemon-endpoint-material.js";
import { registerDaemonEndpoint, writeDaemonEndpointReady, type DaemonEndpointContract } from "./daemon-endpoint-registration.js";
import { DELIVERY_ADMIN_BOOT_WAIT_MS, untilDeliveryAdminAnswers, withScopedEndpoint } from "./endpoint-evict.js";

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

/** Send one delivery-admin request on a scoped, short-lived `endpoint-evictor` credential: the one
 *  profile that publishes exactly that rail and nothing else. */
async function deliveryAdmin(
  target: { space: string; servers: string; auth: SpaceAuth; tls?: boolean },
  op: string,
  args: Record<string, unknown>,
  log: (line: string) => void,
): Promise<ControlReply> {
  return untilDeliveryAdminAnswers(DELIVERY_ADMIN_BOOT_WAIT_MS, (requestMs) =>
    withScopedEndpoint({ space: target.space, servers: target.servers, auth: target.auth, tlsRequired: target.tls }, "endpoint-evictor", `delivery-endpoint-${op}`,
      (ep) => ep.requestDeliveryAdmin(op, args, requestMs(20_000))),
  (reason, delayMs) => log(`• ${String(args.endpoint)}: waiting for the delivery daemon's admin rail (${reason}); retrying in ${delayMs}ms`));
}

/** Register a delivery-served endpoint, hand its credentials to the daemon, and write `ready` on the
 *  daemon's proof. Returns the epoch it bound at. */
export async function bootstrapDaemonEndpoint(
  target: { auth: SpaceAuth; servers: string; space: string; tls?: boolean; store: SecretStore; log: (line: string) => void },
  endpoint: DaemonEndpointBootstrap,
): Promise<{ epoch: number; instanceId: string }> {
  const { store, space, log } = target;
  const name = endpoint.endpoint;
  const instanceId = await loadOrCreateDaemonEndpointInstanceId(store, space, name);
  const serveIdentity = await loadOrCreateDaemonEndpointServeIdentity(store, space, name);
  const reg = { auth: target.auth, servers: target.servers, space, tls: target.tls, instanceId, serveIdentity, log };
  const minted = await registerDaemonEndpoint(reg, endpoint);
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
  log(`✓ ${name}: registered, bound by the delivery daemon at epoch ${s.epoch}, ready`);
  return { epoch: s.epoch, instanceId };
}
