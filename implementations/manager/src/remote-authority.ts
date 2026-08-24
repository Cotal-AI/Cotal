import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  credsFromJwt,
  mintLifecycleUid,
  newIdentity,
  remoteManagerActors,
  writeSecretFileAtomic,
  type Identity,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";

interface RemoteManagerIdentityState {
  v: 1;
  space: string;
  instanceId: string;
  lifecycleUid: string;
  identities: {
    supervisor: Identity;
    executor: Identity;
    serve: Identity;
    goalWriter: Identity;
    sessionLedger: Identity;
  };
}

function stateFile(root: string, space: string): string {
  return join(root, ".cotal", `remote-manager.${Buffer.from(space, "utf8").toString("hex")}.json`);
}

function parseIdentity(v: unknown, what: string): Identity {
  const o = v as Partial<Identity>;
  if (o === null || typeof o !== "object" || typeof o.id !== "string" || typeof o.seed !== "string")
    throw new Error(`${what} is malformed`);
  const identity = { id: o.id, seed: o.seed };
  // A synthetic JWT subject check is unnecessary here; credsFromJwt validates the seed when the
  // host-signed generation is materialized, before any connect.
  return identity;
}

/** Load or create one participant-owned manager lifecycle identity. Private seeds never leave it. */
export function loadOrCreateRemoteManagerIdentity(root: string, space: string): RemoteManagerIdentityState {
  const path = stateFile(root, space);
  if (existsSync(path)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { throw new Error(`${path}: remote manager authority state does not parse (${(e as Error).message}); refusing to rotate over it`); }
    const o = raw as Partial<RemoteManagerIdentityState>;
    if (o.v !== 1 || o.space !== space || typeof o.instanceId !== "string" || typeof o.lifecycleUid !== "string" || !o.identities)
      throw new Error(`${path}: remote manager authority state is malformed; refusing to mint a fresh instance over it`);
    const state: RemoteManagerIdentityState = {
      v: 1, space, instanceId: o.instanceId, lifecycleUid: o.lifecycleUid,
      identities: {
        supervisor: parseIdentity(o.identities.supervisor, "supervisor identity"),
        executor: parseIdentity(o.identities.executor, "executor identity"),
        serve: parseIdentity(o.identities.serve, "serve identity"),
        goalWriter: parseIdentity(o.identities.goalWriter, "goal-writer identity"),
        sessionLedger: parseIdentity(o.identities.sessionLedger, "session-ledger identity"),
      },
    };
    return state;
  }
  const state: RemoteManagerIdentityState = {
    v: 1,
    space,
    instanceId: mintLifecycleUid(),
    lifecycleUid: mintLifecycleUid(),
    identities: {
      supervisor: newIdentity(),
      executor: newIdentity(),
      serve: newIdentity(),
      goalWriter: newIdentity(),
      sessionLedger: newIdentity(),
    },
  };
  writeSecretFileAtomic(path, JSON.stringify(state, null, 2));
  return state;
}

export function remoteManagerAuthorityRequest(
  state: RemoteManagerIdentityState,
  actor: string,
  operation: RemoteManagerAuthorityRequest["operation"],
  registrationProof?: string,
  contractArtifacts?: unknown[],
  session?: RemoteManagerAuthorityRequest["session"],
): RemoteManagerAuthorityRequest {
  const requestId = `${operation}${mintLifecycleUid()}`;
  return {
    v: 1,
    kind: "manager-service-authority",
    operation,
    space: state.space,
    actor,
    instanceId: state.instanceId,
    managerLifecycleUid: state.lifecycleUid,
    requestId,
    ...(registrationProof ? { registrationProof } : {}),
    ...(contractArtifacts ? { contractArtifacts } : {}),
    ...(session ? { session } : {}),
    identities: {
      supervisor: { id: state.identities.supervisor.id },
      executor: { id: state.identities.executor.id },
      serve: { id: state.identities.serve.id },
      goalWriter: { id: state.identities.goalWriter.id },
      sessionLedger: { id: state.identities.sessionLedger.id },
    },
  };
}

/** Combine a host-signed JWT with the participant's private seed, after exact identity checks. */
export function materialCredential(
  material: RemoteManagerAuthorityMaterial,
  name: keyof RemoteManagerAuthorityMaterial["credentials"],
  identity: Identity,
): string {
  const credential = material.credentials[name];
  if (!credential) throw new Error(`manager-service ${material.operation} returned no ${name} credential`);
  let claims: { sub?: unknown; exp?: unknown };
  try { claims = JSON.parse(Buffer.from(credential.jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown }; }
  catch { throw new Error(`manager-service ${name} credential is not a JWT`); }
  if (claims.sub !== identity.id) throw new Error(`manager-service ${name} JWT is for ${String(claims.sub)}, not the requested identity ${identity.id}`);
  if (claims.exp !== credential.exp || credential.exp * 1000 > material.expiresAt + 1)
    throw new Error(`manager-service ${name} expiry does not match the material envelope`);
  return credsFromJwt(credential.jwt, identity);
}

export function expectedRemoteManagerActors(state: RemoteManagerIdentityState) {
  return remoteManagerActors(state.instanceId);
}
