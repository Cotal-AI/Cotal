import { createHash } from "node:crypto";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager, JetStreamApiCodes, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { assertDerivedOwnerToken, assertValidUsername, canonicalBackupStreamConfig, DEV_OWNER, isCasLoss, isJetStreamMissing, PLATFORM_OWNER_PREFIX, usernameBucket, USERNAME_MAX_LENGTH, validateCanonicalBackupStreamConfig, walkKvLatest } from "@cotal-ai/core";
import { serializedFor } from "./serialized.js";
import type { ScanGuard } from "./plane-claim.js";
import { parseUsernamePolicy, type UsernamePolicy } from "./username-policy.js";

export interface UsernameClaims {
  preferred_username?: string;
  email?: string;
  name?: string;
}

export type AssignUsername = (owner: string, claims: UsernameClaims, supplied?: string) => Promise<string | undefined>;

export function usernameWriterGrants(space: string): string[] {
  const bucket = usernameBucket(space);
  const stream = `KV_${bucket}`;
  return [`$JS.API.STREAM.CREATE.${stream}`, `$JS.API.STREAM.INFO.${stream}`, `$JS.API.STREAM.MSG.GET.${stream}`,
    `$KV.${bucket}.owner.*`, `$KV.${bucket}.username.*`];
}

function derivedUsername(owner: string, claims: UsernameClaims, emailLocalPart: boolean): string {
  const local = emailLocalPart ? claims.email?.match(/^([^@]+)@[^@]+$/)?.[1] : undefined;
  for (const claim of [claims.preferred_username, claims.name, local]) {
    const name = claim?.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, USERNAME_MAX_LENGTH);
    if (name) return name;
  }
  return `user_${createHash("sha256").update(owner).digest("hex").slice(0, 10)}`;
}

async function readKey(jsm: JetStreamManager, bucket: string, key: string): Promise<string | undefined> {
  try {
    const message = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${key}` });
    return message ? new TextDecoder("utf-8", { fatal: true }).decode(message.data) : undefined;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 10037) return undefined;
    throw error;
  }
}

async function createKey(js: JetStreamClient, subject: string, value: string): Promise<boolean> {
  try {
    await js.publish(subject, new TextEncoder().encode(value), { expect: { lastSubjectSequence: 0 } });
    return true;
  } catch (error) {
    if (isCasLoss(error)) return false;
    throw error;
  }
}

async function openRegistry(nc: NatsConnection, jsm: JetStreamManager, space: string, bucket: string) {
  const stream = `KV_${bucket}`;
  const info = await jsm.streams.info(stream).catch((error: unknown) => {
    if (!isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) throw error;
    // An existing user-auth space may start its upgraded issuer without a broker setup pass.
    return jsm.streams.add(canonicalBackupStreamConfig(space, stream));
  });
  validateCanonicalBackupStreamConfig(space, stream, info.config as unknown as Record<string, unknown>);
  return new Kvm(nc).open(bucket);
}

type CreateKey = (key: string, value: string) => Promise<boolean>;

async function reconcileReservations(kv: Awaited<ReturnType<typeof openRegistry>>, create: CreateKey, guard: ScanGuard) {
  await guard.assertHeld("before");
  const owners = new Map<string, string>();
  const reservations = new Map<string, string>();
  for (const entry of await walkKvLatest(kv, ">")) {
    if (entry.operation !== "PUT") throw new Error("the username registry contains a reservation deletion marker");
    const [kind, key, extra] = entry.key.split(".");
    if (extra !== undefined || (kind !== "owner" && kind !== "username")) throw new Error("the username registry contains an invalid key");
    if (kind === "owner") owners.set(assertDerivedOwnerToken(key), assertValidUsername(entry.string()));
    else reservations.set(assertValidUsername(key), assertDerivedOwnerToken(entry.string()));
  }
  for (const [owner, username] of owners)
    if (reservations.get(username) !== owner) throw new Error("the username registry contains an inconsistent owner binding");
  for (const [username, owner] of reservations) {
    if (owners.has(owner)) continue;
    await guard.assertHeld("before");
    if (!await create(`owner.${owner}`, username)) throw new Error("the username registry moved during startup reconciliation");
    owners.set(owner, username);
  }
  await guard.assertHeld("after");
}

/** Both writes are create-only. A reader accepts only the reciprocal pair elected by the forward key. */
export async function openUsernameAssignment(nc: NatsConnection, space: string, guard: ScanGuard, config?: UsernamePolicy): Promise<AssignUsername> {
  const policy = parseUsernamePolicy(config);
  const bucket = usernameBucket(space);
  const jsm = await jetstreamManager(nc);
  const kv = await openRegistry(nc, jsm, space, bucket);
  const read = (key: string) => readKey(jsm, bucket, key);
  const create = (key: string, value: string) => createKey(jsm.jetstream(), `$KV.${bucket}.${key}`, value);
  await reconcileReservations(kv, create, guard);
  const owners = new Map<string, Promise<unknown>>();
  const assigned = async (owner: string, supplied?: string) => {
    const value = await read(`owner.${owner}`);
    if (value === undefined) return undefined;
    const username = assertValidUsername(value);
    if (await read(`username.${username}`) !== owner) throw new Error("the username registry contains an inconsistent owner binding");
    if (supplied !== undefined && username !== supplied) throw new Error("the owner already has a different username");
    return username;
  };
  const assign: AssignUsername = async (owner, claims, supplied) => {
    try {
      if (owner === DEV_OWNER || owner.startsWith(PLATFORM_OWNER_PREFIX)) return undefined;
      assertDerivedOwnerToken(owner);
      if (policy.source === "directory" && supplied === undefined) return undefined;
      if (policy.source === "claims" && supplied !== undefined) throw new Error('a supplied username requires the space username source "directory"');
      if (supplied !== undefined) assertValidUsername(supplied);
      const current = await assigned(owner, supplied);
      if (current !== undefined) return current;
      const base = supplied ?? derivedUsername(owner, claims, policy.source === "claims" && policy.emailLocalPart === true);
      for (let attempt = 0; attempt < (supplied === undefined ? 16 : 1); attempt++) {
        const suffix = `_${createHash("sha256").update(`${owner}:${attempt}`).digest("hex").slice(0, 6)}`;
        const username = attempt === 0 ? base : base.slice(0, USERNAME_MAX_LENGTH - suffix.length) + suffix;
        const key = `username.${username}`;
        if (!await create(key, owner) && await read(key) !== owner) continue;
        if (await create(`owner.${owner}`, username)) return username;
        const winner = await assigned(owner, supplied);
        if (winner !== undefined) return winner;
        throw new Error("the elected owner binding could not be read");
      }
      throw new Error(supplied === undefined ? "no username candidate could be reserved" : "the directory username is already reserved for another owner");
    } catch (error) {
      throw new Error(`username assignment failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  return (owner, claims, supplied) => serializedFor(owners, owner, () => assign(owner, claims, supplied));
}
