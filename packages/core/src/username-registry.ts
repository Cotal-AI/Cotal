import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { isPermissionDenied } from "./permission-denied.js";
import { assertPlatformOwnerToken, assertValidOwnerToken, DEV_OWNER, PLATFORM_OWNER_PREFIX, usernameBucket } from "./subjects.js";

export const USERNAME_MAX_LENGTH = 40;

export function assertValidUsername(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > USERNAME_MAX_LENGTH || /[^a-z0-9_]/.test(value))
    throw new Error(`a username must have 1 to ${USERNAME_MAX_LENGTH} lowercase letters, digits or underscores`);
  return value;
}

/** A lookup whose answer could not be established. An absent binding is returned separately. */
export class UsernameRegistryReadError extends Error {
  constructor(readonly code: "denied" | "unavailable", readonly subject: string, cause: unknown) {
    super(`username registry read ${code} for ${subject}`, { cause });
    this.name = "UsernameRegistryReadError";
  }
}

async function readKey(jsm: JetStreamManager, bucket: string, key: string): Promise<string | undefined> {
  const subject = `$KV.${bucket}.${key}`;
  try {
    const message = await jsm.direct.getMessage(`KV_${bucket}`, { last_by_subj: subject });
    if (!message) return undefined;
    if (message.subject !== subject) throw new Error("unexpected username registry reply subject");
    return new TextDecoder("utf-8", { fatal: true }).decode(message.data);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 404 || code === 10037) return undefined;
    throw new UsernameRegistryReadError(isPermissionDenied(error) ? "denied" : "unavailable", subject, error);
  }
}

/** Read an assigned username. An owner candidate is visible only once its reverse key agrees. */
export async function readUsername(nc: NatsConnection, space: string, owner: string): Promise<string | undefined> {
  assertValidOwnerToken(owner);
  if (owner === DEV_OWNER) return undefined;
  if (owner.startsWith(PLATFORM_OWNER_PREFIX)) {
    assertPlatformOwnerToken(owner);
    return undefined;
  }
  const bucket = usernameBucket(space);
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const value = await readKey(jsm, bucket, `owner.${owner}`);
  if (value === undefined) return undefined;
  const username = assertValidUsername(value);
  const reverse = await readKey(jsm, bucket, `username.${username}`);
  if (reverse === undefined || assertValidOwnerToken(reverse) !== owner)
    throw new UsernameRegistryReadError("unavailable", `$KV.${bucket}.owner.${owner}`, new Error("owner binding is missing a matching reservation"));
  return username;
}

/** Read the owner of an assigned username. A reservation without an owner binding is not an assignment. */
export async function readUsernameOwner(nc: NatsConnection, space: string, username: string): Promise<string | undefined> {
  assertValidUsername(username);
  const bucket = usernameBucket(space);
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const value = await readKey(jsm, bucket, `username.${username}`);
  if (value === undefined) return undefined;
  const owner = assertValidOwnerToken(value);
  if (owner === DEV_OWNER || owner.startsWith(PLATFORM_OWNER_PREFIX)) throw new Error("the username registry cannot bind a local or platform owner");
  const forward = await readKey(jsm, bucket, `owner.${owner}`);
  if (forward === undefined) return undefined;
  if (assertValidUsername(forward) !== username)
    throw new UsernameRegistryReadError("unavailable", `$KV.${bucket}.username.${username}`, new Error("reservation disagrees with the owner binding"));
  return owner;
}
