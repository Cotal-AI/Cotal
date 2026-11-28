/**
 * Where the material of an endpoint the delivery daemon serves lives in the secret store (A1).
 *
 * The signer holder writes it (`ensureDelivery` at start, the manager's renewal after) and the daemon
 * reads it. Both build every key here, so the writer and the reader cannot spell a key two ways. Every
 * key sits under the space's own segment and then under the endpoint's name, in the same store as
 * `delivery.creds`:
 *
 *   `<space segment>/endpoints/<endpoint>/<kind>`
 *
 * The instance id and the serve identity are load-or-create: the first start writes them with an
 * atomic create, and every later start reads the same values back. The same instance id makes a
 * restart a takeover of the same registration, and the same serve nkey keeps the issuance gate's
 * principal, so a restarted daemon is the instance it was.
 */
import { ARTIFACTS_ENDPOINT, endpointToken, mintLifecycleUid, newIdentity, assertLifecycleToken, type Identity, type SecretStore } from "@cotal-ai/core";
import { segmentedKey } from "./space-segmentation.js";

/** The persisted instance id of the endpoint instance this daemon serves. */
export const DAEMON_ENDPOINT_INSTANCE_KIND = "instance-id";
/** The persisted serve identity, `{id, seed}` JSON. The seed signs every serve credential's nkey. */
export const DAEMON_ENDPOINT_SERVE_IDENTITY_KIND = "serve-identity.json";
/** The endpoint's current serve credential, minted behind the issuance fence. */
export const DAEMON_ENDPOINT_SERVE_CREDS_KIND = "serve.creds";
/** The artifacts service's request-path store credential (profile `artifact-data`). */
export const ARTIFACT_DATA_CREDS_KIND = "artifact-data.creds";
/** The artifacts service's sweep credential (profile `artifact-sweeper`). */
export const ARTIFACT_SWEEPER_CREDS_KIND = "artifact-sweeper.creds";
/** The name of the artifact store a space's bytes live in (draft). Not a secret and not a grant: it
 *  names where bytes sit, never who may read them. Absent means the daemon's default store. */
export const ARTIFACT_STORE_BINDING_KIND = "store-binding";

/** The store key of one kind of an endpoint's material in a space. */
export function daemonEndpointKey(space: string, endpoint: string, kind: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(kind) || kind.includes(".."))
    throw new Error(`daemonEndpointKey: "${kind}" is not a material kind`);
  return segmentedKey(`endpoints/${endpointToken(endpoint)}/${kind}`, space);
}

/** Read a load-or-create value: write `fresh` only while the key is absent, and adopt the stored
 *  value when another first writer won, so two first callers never keep values of their own. */
async function loadOrCreate(store: SecretStore, key: string, fresh: () => string): Promise<string> {
  const existing = await store.get(key);
  if (existing !== undefined) return existing;
  const value = fresh();
  if (await store.create(key, value)) return value;
  const won = await store.get(key);
  if (won === undefined) throw new Error(`${key} was created by another writer and is now absent`);
  return won;
}

/** The persisted instance id, created on first use. */
export async function loadOrCreateDaemonEndpointInstanceId(store: SecretStore, space: string, endpoint: string): Promise<string> {
  const key = daemonEndpointKey(space, endpoint, DAEMON_ENDPOINT_INSTANCE_KIND);
  return assertLifecycleToken((await loadOrCreate(store, key, mintLifecycleUid)).trim(), `${key}`);
}

/** The persisted instance id, or `undefined` when the signer holder has not registered yet. */
export async function readDaemonEndpointInstanceId(store: SecretStore, space: string, endpoint: string): Promise<string | undefined> {
  const key = daemonEndpointKey(space, endpoint, DAEMON_ENDPOINT_INSTANCE_KIND);
  const raw = await store.get(key);
  return raw === undefined ? undefined : assertLifecycleToken(raw.trim(), key);
}

function parseIdentity(raw: string, key: string): Identity {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${key} is not JSON`); }
  const o = parsed as Partial<Identity> | null;
  if (o === null || typeof o !== "object" || typeof o.id !== "string" || !o.id.startsWith("U") || typeof o.seed !== "string" || !o.seed.startsWith("SU"))
    throw new Error(`${key} does not hold a user nkey identity`);
  return { id: o.id, seed: o.seed };
}

/** The persisted serve identity, created on first use. Only the signer holder calls this. */
export async function loadOrCreateDaemonEndpointServeIdentity(store: SecretStore, space: string, endpoint: string): Promise<Identity> {
  const key = daemonEndpointKey(space, endpoint, DAEMON_ENDPOINT_SERVE_IDENTITY_KIND);
  return parseIdentity(await loadOrCreate(store, key, () => JSON.stringify(newIdentity())), key);
}

/** The serve nkey's public id, or `undefined` before the first registration. The daemon reads only
 *  the public half: the seed rides inside the serve credential the signer holder mints. */
export async function readDaemonEndpointServeId(store: SecretStore, space: string, endpoint: string): Promise<string | undefined> {
  const key = daemonEndpointKey(space, endpoint, DAEMON_ENDPOINT_SERVE_IDENTITY_KIND);
  const raw = await store.get(key);
  return raw === undefined ? undefined : parseIdentity(raw, key).id;
}

/** A store name a binding may hold: lowercase, digits and dashes, at most 64 characters. */
const ARTIFACT_STORE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The artifact store `space` is bound to, or `undefined` when it has no binding. The value is taken
 *  exactly as stored, never trimmed, and anything that is not a store name throws before any caller
 *  can look it up. The refusal does not echo the value. */
export async function readArtifactStoreBinding(store: SecretStore, space: string): Promise<string | undefined> {
  const raw = await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_STORE_BINDING_KIND));
  if (raw === undefined) return undefined;
  if (!ARTIFACT_STORE_NAME.test(raw))
    throw new Error(`delivery: the artifact store binding for space "${space}" is not a store name; nothing was started`);
  return raw;
}
