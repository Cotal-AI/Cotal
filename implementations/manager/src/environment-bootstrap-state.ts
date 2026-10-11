import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  artifactSignerFromSeed, canonicalJson, isUserNkey, parseEnvironmentManagerBootstrapDocument,
  REMOTE_MANAGER_IDENTITY_NAMES,
} from "@cotal-ai/core";
import { claimIdentityRecord } from "@cotal-ai/workspace";
import { createReservedRemoteManagerIdentity, type RemoteManagerIdentityState } from "./remote-authority.js";

interface InitialBootstrapState {
  v: 1;
  bootstrapText: string;
  identityState: RemoteManagerIdentityState;
}

const MAX_STATE_BYTES = 256 * 1024;
const INVALID = "environment manager initial bootstrap state is unavailable";
const closed = (value: unknown, fields: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));

function privateStateFile(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.geteuid!() || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > MAX_STATE_BYTES)
    throw new Error(INVALID);
}

function stateBytes(fd: number): string {
  const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, null);
    if (count === 0) break;
    length += count;
  }
  if (length < 1 || length > MAX_STATE_BYTES) throw new Error(INVALID);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
}

/** Claim one still-current initial bootstrap state in an existing private Linux directory.
 *  The original carrier and five local nkeys publish together through the stock exclusive claim.
 *  A held directory pins access; file and directory sync precede returning the actual winner.
 *  Changed carriers, unsafe entries and malformed records refuse without replacing them. Same-UID
 *  processes remain trusted. This does not take a file, authenticate admission, make a request,
 *  store prepared results or recover an activated manager; expired bootstrap input refuses. */
export function claimEnvironmentManagerBootstrapState(directory: string, bootstrapText: string): RemoteManagerIdentityState {
  if (process.platform !== "linux" || process.geteuid === undefined)
    throw new Error("environment manager initial bootstrap state requires Linux");
  let directoryFd: number | undefined;
  try {
    if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory)
      throw new Error(INVALID);
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(directoryFd);
    if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o7777) !== 0o700) throw new Error(INVALID);
    const path = `/proc/self/fd/${directoryFd}/environment-manager-bootstrap.json`;
    // Metadata is checked before the stock reader sees an existing record. NONBLOCK keeps a
    // planted FIFO from turning refusal into a stuck privileged process.
    let existing: number | undefined;
    try { existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing !== undefined) {
      try { privateStateFile(existing); } finally { closeSync(existing); }
    }
    const document = parseEnvironmentManagerBootstrapDocument(bootstrapText);
    const parse = (raw: unknown): InitialBootstrapState | undefined => {
      if (!closed(raw, ["v", "bootstrapText", "identityState"]) || raw.v !== 1 || raw.bootstrapText !== bootstrapText ||
          !closed(raw.identityState, ["v", "space", "instanceId", "lifecycleUid", "identities"])) return undefined;
      const state = raw.identityState;
      if (state.v !== 1 || state.space !== document.space || state.instanceId !== document.instanceId || state.lifecycleUid !== document.lifecycleUid ||
          !closed(state.identities, REMOTE_MANAGER_IDENTITY_NAMES)) return undefined;
      for (const name of REMOTE_MANAGER_IDENTITY_NAMES) {
        const identity = state.identities[name];
        if (!closed(identity, ["id", "seed"]) || !isUserNkey(identity.id) || typeof identity.seed !== "string" || !identity.seed.startsWith("SU")) return undefined;
        try { if (artifactSignerFromSeed(identity.seed).publicKey !== identity.id) return undefined; }
        catch { return undefined; }
      }
      const identityState = state as unknown as RemoteManagerIdentityState;
      if (new Set(REMOTE_MANAGER_IDENTITY_NAMES.map(name => identityState.identities[name].id)).size !== 5) return undefined;
      return { v: 1, bootstrapText, identityState };
    };
    const winner = claimIdentityRecord(path, "the environment manager initial bootstrap state", parse, () => ({
      v: 1, bootstrapText,
      identityState: createReservedRemoteManagerIdentity({ space: document.space, instanceId: document.instanceId, lifecycleUid: document.lifecycleUid }),
    }));
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      privateStateFile(fd);
      const text = stateBytes(fd);
      const stored = parse(JSON.parse(text));
      if (!stored || text !== JSON.stringify(stored, null, 2) || canonicalJson(stored) !== canonicalJson(winner)) throw new Error(INVALID);
      fsyncSync(fd);
      fsyncSync(directoryFd);
      parseEnvironmentManagerBootstrapDocument(bootstrapText);
      return stored.identityState;
    } finally { closeSync(fd); }
  } catch { throw new Error(INVALID); }
  finally { if (directoryFd !== undefined) closeSync(directoryFd); }
}
