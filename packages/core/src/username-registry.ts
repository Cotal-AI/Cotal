import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { assertValidOwnerToken, DEV_OWNER, usernameBucket } from "./subjects.js";

export const USERNAME_MAX_LENGTH = 40;

export function assertValidUsername(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > USERNAME_MAX_LENGTH || /[^a-z0-9_]/.test(value))
    throw new Error(`a username must have 1 to ${USERNAME_MAX_LENGTH} lowercase letters, digits or underscores`);
  return value;
}

async function readKey(jsm: JetStreamManager, bucket: string, key: string): Promise<string | undefined> {
  const subject = `$KV.${bucket}.${key}`;
  try {
    const message = await jsm.direct.getMessage(`KV_${bucket}`, { last_by_subj: subject });
    if (!message) return undefined;
    if (message.subject !== subject) throw new Error("unexpected username registry reply subject");
    return new TextDecoder("utf-8", { fatal: true }).decode(message.data);
  } catch (error) {
    if ((error as { code?: unknown })?.code === 10037) return undefined;
    throw error;
  }
}

/** Read an assigned username. An owner candidate is visible only once its reverse key agrees. */
export async function readUsername(nc: NatsConnection, space: string, owner: string): Promise<string | undefined> {
  assertValidOwnerToken(owner);
  if (owner === DEV_OWNER) return undefined;
  const bucket = usernameBucket(space);
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const value = await readKey(jsm, bucket, `owner.${owner}`);
  if (value === undefined) return undefined;
  const username = assertValidUsername(value);
  const reverse = await readKey(jsm, bucket, `username.${username}`);
  return reverse !== undefined && assertValidOwnerToken(reverse) === owner ? username : undefined;
}

/** Read the owner of an assigned username. An unmatched key is not an assignment. */
export async function readUsernameOwner(nc: NatsConnection, space: string, username: string): Promise<string | undefined> {
  assertValidUsername(username);
  const bucket = usernameBucket(space);
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const value = await readKey(jsm, bucket, `username.${username}`);
  if (value === undefined) return undefined;
  const owner = assertValidOwnerToken(value);
  if (owner === DEV_OWNER) throw new Error("the username registry cannot bind the local owner");
  const forward = await readKey(jsm, bucket, `owner.${owner}`);
  return forward !== undefined && assertValidUsername(forward) === username ? owner : undefined;
}
