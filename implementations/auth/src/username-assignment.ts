import { createHash } from "node:crypto";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager, StorageType, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { assertDerivedOwnerToken, assertValidUsername, isCasLoss, usernameBucket, USERNAME_MAX_LENGTH } from "@cotal-ai/core";
import { serializedFor } from "./serialized.js";

export interface UsernameClaims {
  preferred_username?: string;
  email?: string;
  name?: string;
}

export type AssignUsername = (owner: string, claims: UsernameClaims, supplied?: string) => Promise<string>;

export function usernameWriterGrants(space: string): string[] {
  const bucket = usernameBucket(space);
  const stream = `KV_${bucket}`;
  return [`$JS.API.STREAM.CREATE.${stream}`, `$JS.API.STREAM.INFO.${stream}`, `$JS.API.STREAM.MSG.GET.${stream}`,
    `$KV.${bucket}.owner.*`, `$KV.${bucket}.username.*`];
}

function slug(claims: UsernameClaims): string | undefined {
  const local = claims.email?.match(/^([^@]+)@[^@]+$/)?.[1];
  for (const claim of [claims.preferred_username, local, claims.name]) {
    const name = claim?.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, USERNAME_MAX_LENGTH);
    if (name) return name;
  }
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

/** Both writes are create-only. A reader accepts only the reciprocal pair elected by the forward key. */
export async function openUsernameAssignment(nc: NatsConnection, space: string): Promise<AssignUsername> {
  const bucket = usernameBucket(space);
  const jsm = await jetstreamManager(nc);
  await new Kvm(nc).create(bucket, { storage: StorageType.File, history: 1 });
  const info = await jsm.streams.info(`KV_${bucket}`);
  const cfg = info.config;
  if (!cfg.allow_direct || cfg.storage !== StorageType.File || cfg.max_age !== 0 || cfg.max_msgs_per_subject !== 1 ||
      cfg.max_bytes !== -1 || cfg.max_msgs !== -1 || cfg.subjects.length !== 1 || cfg.subjects[0] !== `$KV.${bucket}.>`)
    throw new Error(`username registry ${bucket} has an incompatible stream configuration`);
  const read = (key: string) => readKey(jsm, bucket, key);
  const create = (key: string, value: string) => createKey(jsm.jetstream(), `$KV.${bucket}.${key}`, value);
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
      assertDerivedOwnerToken(owner);
      if (supplied !== undefined) assertValidUsername(supplied);
      const current = await assigned(owner, supplied);
      if (current !== undefined) return current;
      const base = supplied ?? slug(claims);
      if (!base) throw new Error("the verified identity proof has no usable preferred_username, email local part, or name");
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
