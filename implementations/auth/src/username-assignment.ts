import { createHash } from "node:crypto";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager, JetStreamApiCodes, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { assertDerivedOwnerToken, assertValidUsername, canonicalBackupStreamConfig, DEV_OWNER, EpEnvelopeError, isCasLoss, isJetStreamMissing, PLATFORM_OWNER_PREFIX, usernameBucket, USERNAME_MAX_LENGTH, validateCanonicalBackupStreamConfig, walkKvLatest } from "@cotal-ai/core";
import { serializedFor } from "./serialized.js";
import type { ScanGuard } from "./plane-claim.js";
import { parseUsernamePolicy, type UsernamePolicy } from "./username-policy.js";

export interface UsernameClaims {
  preferred_username?: string;
  email?: string;
  name?: string;
}

export type UsernameChoice = { username: string } | { suggestion: string };
export type AssignUsername = (owner: string, claims: UsernameClaims, supplied?: string) => Promise<void>;
export interface UsernameAssignment {
  exchange: AssignUsername;
  choose(owner: string, claims: UsernameClaims, username?: string): Promise<UsernameChoice | undefined>;
  reserveDirectory(owner: string, username: string): Promise<{ username: string }>;
  backfill(owner: string): Promise<{ username: string }>;
}

export function fenceUsernameAssignment(assignment: UsernameAssignment, assertOpen: () => void): UsernameAssignment {
  return {
    exchange: (...args) => { assertOpen(); return assignment.exchange(...args); },
    choose: (...args) => { assertOpen(); return assignment.choose(...args); },
    reserveDirectory: (...args) => { assertOpen(); return assignment.reserveDirectory(...args); },
    backfill: (...args) => { assertOpen(); return assignment.backfill(...args); },
  };
}

const RESERVED_USERNAMES: ReadonlySet<string> = new Set(["admin", "cotal", "support", "root", "system"]);

export function validateUsernameChoice(value: unknown): string {
  let username: string;
  try { username = assertValidUsername(value); }
  catch (error) { throw new EpEnvelopeError("bad-request", (error as Error).message); }
  if (RESERVED_USERNAMES.has(username)) throw new EpEnvelopeError("bad-request", `username ${username} is reserved`);
  return username;
}

export function usernameWriterGrants(space: string): string[] {
  const bucket = usernameBucket(space);
  const stream = `KV_${bucket}`;
  return [`$JS.API.STREAM.CREATE.${stream}`, `$JS.API.STREAM.INFO.${stream}`, `$JS.API.STREAM.MSG.GET.${stream}`,
    `$KV.${bucket}.owner.*`, `$KV.${bucket}.username.*`];
}

function derivedUsername(owner: string, claims: UsernameClaims, emailLocalPart: boolean): string {
  const local = emailLocalPart ? claims.email?.match(/^([^@]+)@[^@]+$/)?.[1] : undefined;
  for (const claim of [claims.preferred_username, claims.name, local]) {
    if (claim?.includes("@")) continue;
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

async function reconcileReservations(kv: Awaited<ReturnType<typeof openRegistry>>, create: CreateKey, guard: ScanGuard, log: (line: string) => void) {
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
  let inconsistent = false;
  for (const [owner, username] of owners) {
    if (reservations.get(username) === owner) continue;
    inconsistent = true;
    log(`orphan key owner.${owner}: username.${username} does not reserve it for this owner`);
  }
  for (const [username, owner] of reservations) {
    if (owners.get(owner) !== username)
      log(`orphan key username.${username}: owner.${owner} does not point back to it`);
  }
  if (inconsistent) throw new Error("the username registry contains an inconsistent owner binding");
  for (const [username, owner] of reservations) {
    if (owners.has(owner)) continue;
    await guard.assertHeld("before");
    if (!await create(`owner.${owner}`, username)) throw new Error("the username registry moved during startup reconciliation");
    owners.set(owner, username);
  }
  await guard.assertHeld("after");
}

/** Both writes are create-only. A reader accepts only the reciprocal pair elected by the forward key. */
export async function openUsernameAssignment(nc: NatsConnection, space: string, guard: ScanGuard, log: (line: string) => void, config?: UsernamePolicy): Promise<UsernameAssignment> {
  const policy = parseUsernamePolicy(config);
  const bucket = usernameBucket(space);
  const jsm = await jetstreamManager(nc);
  const kv = await openRegistry(nc, jsm, space, bucket);
  const read = (key: string) => readKey(jsm, bucket, key);
  const create = (key: string, value: string) => createKey(jsm.jetstream(), `$KV.${bucket}.${key}`, value);
  await reconcileReservations(kv, create, guard, (line) => log(`username registry ${bucket}: ${line}`));
  const owners = new Map<string, Promise<unknown>>();
  const assigned = async (owner: string) => {
    const value = await read(`owner.${owner}`);
    if (value === undefined) return undefined;
    const username = assertValidUsername(value);
    if (await read(`username.${username}`) !== owner) throw new Error("the username registry contains an inconsistent owner binding");
    return username;
  };
  const suggest = async (owner: string, claims: UsernameClaims) => {
    const base = derivedUsername(owner, claims, policy.source === "claims" && policy.emailLocalPart === true);
    for (let attempt = 0; attempt < 16; attempt++) {
      const suffix = `_${createHash("sha256").update(`${owner}:${attempt}`).digest("hex").slice(0, 6)}`;
      const username = attempt === 0 ? base : base.slice(0, USERNAME_MAX_LENGTH - suffix.length) + suffix;
      if (RESERVED_USERNAMES.has(username)) continue;
      const reservedFor = await read(`username.${username}`);
      if (reservedFor === undefined || reservedFor === owner) return username;
    }
    throw new Error("no available username suggestion");
  };
  const reserve = async (owner: string, value: string) => {
    const username = validateUsernameChoice(value);
    const current = await assigned(owner);
    if (current === username) return { username };
    if (current !== undefined) throw new EpEnvelopeError("conflict", "the owner already has a different username");
    const key = `username.${username}`;
    if (!await create(key, owner) && await read(key) !== owner)
      throw new EpEnvelopeError("conflict", "the username is already reserved for another owner");
    if (await create(`owner.${owner}`, username) || await assigned(owner) === username) return { username };
    throw new EpEnvelopeError("conflict", "the owner already has a different username");
  };
  const forOwner = <T>(owner: string, fn: () => Promise<T>) => serializedFor(owners, assertDerivedOwnerToken(owner), fn);
  const requireSource = (source: UsernamePolicy["source"]) => {
    if (policy.source !== source) throw new EpEnvelopeError("failed-precondition", `this space does not use the ${source} username source`);
  };
  const choose = (owner: string, claims: UsernameClaims, username?: string) => forOwner(owner, async () => {
    if (policy.source !== "claims" && username === undefined) return undefined;
    requireSource("claims");
    if (username !== undefined) return reserve(owner, username);
    const current = await assigned(owner);
    return current === undefined ? { suggestion: await suggest(owner, claims) } : { username: current };
  });
  return {
    choose,
    exchange: async (owner, _claims, supplied) => {
      if (owner === DEV_OWNER || owner.startsWith(PLATFORM_OWNER_PREFIX)) return undefined;
      if (policy.source === "claims") {
        if (supplied !== undefined) throw new Error('a supplied username requires the space username source "directory"');
        return;
      }
      if (supplied !== undefined) await forOwner(owner, () => reserve(owner, supplied));
    },
    reserveDirectory: (owner, username) => forOwner(owner, () => { requireSource("directory"); return reserve(owner, username); }),
    backfill: (owner) => forOwner(owner, async () => {
      requireSource("claims");
      const current = await assigned(owner);
      return current === undefined ? reserve(owner, await suggest(owner, {})) : { username: current };
    }),
  };
}
