import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, isWellFormedUnicode } from "./canonical.js";
import { assertCommandToken, assertLifecycleToken, assertBoundedOwner, type EpCaller } from "./endpoint-subjects.js";
import type { EpBindBlock } from "./endpoint-envelope.js";
import { assertValidChannel, spacePrefix } from "./subjects.js";

export const MANAGED_ROW_REQUEST_VERSION = 1 as const;
export const MANAGED_ROW_ATTEMPT_DOMAIN = "cotal.managed-row-attempt.v1";
export const MANAGED_ROW_WIRE_DOMAIN = "cotal.managed-row-wire.v1";
export type ManagedRowCommand = "create-managed-row" | "revoke-managed-row";

interface StableBase {
  ver: 1;
  requestId: string;
  operationId: string;
  space: string;
  target: { owner: string; actor: string; lifecycleUid: string };
}
export interface CreateManagedRowIntent extends StableBase {
  command: "create-managed-row";
  tokenHash: string;
  scope: string[];
  allowSubscribe: string[];
  allowPublish: string[];
  role?: string;
  parent?: string;
  label?: string;
}
export interface RevokeManagedRowIntent extends StableBase {
  command: "revoke-managed-row";
}
export type ManagedRowIntent = CreateManagedRowIntent | RevokeManagedRowIntent;
export interface ManagedRowAttemptAuthority { kind: "local-manager"; instanceId: string; processEpoch: number }
export interface ManagedRowAttempt {
  ver: 1;
  command: ManagedRowCommand;
  caller: EpCaller;
  intent: ManagedRowIntent;
  nonce: string;
  authority?: ManagedRowAttemptAuthority;
  /** Optional §13.3 responder-incarnation attenuation. It is attempt-local, never durable intent. */
  bind?: EpBindBlock;
  /** Optional authoritative lifecycle-head revision pin for a revoke target. */
  mappingRevision?: number;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const OPERATION_ID = /^[A-Za-z0-9_:-]{16,192}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CLOSED_CREATE = ["ver", "command", "requestId", "operationId", "space", "target", "tokenHash", "scope", "allowSubscribe", "allowPublish", "role", "parent", "label"];
const CLOSED_REVOKE = ["ver", "command", "requestId", "operationId", "space", "target"];
const CLOSED_TARGET = ["owner", "actor", "lifecycleUid"];

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error(`${what} must be a plain object`);
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${what} has unknown fields: ${extra.join(", ")}`);
}
function requestToken(value: unknown, what: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value) || !isWellFormedUnicode(value)) throw new Error(`${what} must be a 16-128 character opaque token`);
  return value;
}
function operationToken(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID.test(value) || !isWellFormedUnicode(value))
    throw new Error("operationId must be a 16-192 character durable operation token ([A-Za-z0-9_:-])");
  return value;
}
function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) throw new Error(`${what} must be a well-formed string`);
  return value;
}
function canonicalSet(value: unknown, what: string, check: (item: string) => void): string[] {
  if (!Array.isArray(value) || value.length > 128 || !value.every((item) => typeof item === "string" && item.length <= 256 && isWellFormedUnicode(item)))
    throw new Error(`${what} must be an array of at most 128 well-formed strings, each at most 256 characters`);
  for (const item of value) check(item);
  const normalized = [...new Set(value as string[])].sort();
  if (normalized.length !== value.length || normalized.some((item, i) => item !== value[i]))
    throw new Error(`${what} uses canonical set semantics: unique strings in ascending code-unit order`);
  return normalized;
}
function target(value: unknown): ManagedRowIntent["target"] {
  const obj = plainObject(value, "managed-row target"); closed(obj, CLOSED_TARGET, "managed-row target");
  return { owner: assertBoundedOwner(text(obj.owner, "target.owner"), "target owner"), actor: assertBoundedOwner(text(obj.actor, "target.actor"), "target actor"), lifecycleUid: assertLifecycleToken(text(obj.lifecycleUid, "target.lifecycleUid"), "target lifecycleUid") };
}

export function validateManagedRowIntent(raw: unknown): ManagedRowIntent {
  const obj = plainObject(raw, "managed-row intent");
  if (obj.ver !== 1) throw new Error("managed-row intent ver must be 1");
  const command = assertCommandToken(text(obj.command, "command")) as ManagedRowCommand;
  if (command !== "create-managed-row" && command !== "revoke-managed-row") throw new Error(`unsupported managed-row command ${command}`);
  closed(obj, command === "create-managed-row" ? CLOSED_CREATE : CLOSED_REVOKE, "managed-row intent");
  const rawSpace = text(obj.space, "space");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(rawSpace) || spacePrefix(rawSpace) !== `cotal.${rawSpace}`) throw new Error("space must already be one unchanged 1-64 character NATS-safe token");
  const base: StableBase = { ver: 1, command, requestId: requestToken(obj.requestId, "requestId"), operationId: operationToken(obj.operationId), space: rawSpace, target: target(obj.target) } as StableBase;
  if (command === "revoke-managed-row") return base as RevokeManagedRowIntent;
  if (typeof obj.tokenHash !== "string" || !HEX64.test(obj.tokenHash)) throw new Error("tokenHash must be a lowercase sha256 hex digest");
  const optional = (key: "role" | "parent" | "label") => obj[key] === undefined ? undefined : text(obj[key], key);
  const role = optional("role");
  if (role !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(role)) throw new Error("role must be one 1-64 character NATS-safe token");
  const parent = optional("parent");
  if (parent !== undefined) {
    const parts = parent.split(".");
    if (parts.length !== 2) throw new Error("parent must be an exact owner.actor principal");
    assertBoundedOwner(parts[0], "parent owner"); assertBoundedOwner(parts[1], "parent actor");
  }
  const label = optional("label");
  if (label !== undefined && (label.length === 0 || label.length > 256 || label !== label.trim() || /[\r\n]/.test(label))) throw new Error("label must be a trimmed single-line string of 1-256 characters");
  const scope = canonicalSet(obj.scope, "scope", (item) => { if (!/^(?:spawn|run|admin|role:[A-Za-z0-9_-]+)$/.test(item)) throw new Error(`invalid managed scope ${item}`); });
  const allowSubscribe = canonicalSet(obj.allowSubscribe, "allowSubscribe", (item) => { assertValidChannel(item); });
  const allowPublish = canonicalSet(obj.allowPublish, "allowPublish", (item) => { assertValidChannel(item); if (item.includes("*") || item.includes(">")) throw new Error(`allowPublish channel ${item} must be concrete`); });
  return { ...base, command, tokenHash: obj.tokenHash, scope, allowSubscribe, allowPublish, ...(role !== undefined ? { role } : {}), ...(parent !== undefined ? { parent } : {}), ...(label !== undefined ? { label } : {}) };
}

export function managedRowStableBytes(intent: ManagedRowIntent): Uint8Array {
  return Buffer.from(canonicalJson(validateManagedRowIntent(intent)), "utf8");
}
/** Stable executor operation identity. Attempts keep fresh nonce/caller/epoch coordinates while
 * exact retries of one immutable intent retain this wire echo. */
export function managedRowWireId(intent: ManagedRowIntent): string {
  return createHash("sha256").update(`${MANAGED_ROW_WIRE_DOMAIN}\0`).update(managedRowStableBytes(intent)).digest("base64url").slice(0, 43);
}
export function managedRowCliForegroundDigest(intent: Extract<ManagedRowIntent, { command: "create-managed-row" }>): string {
  const value = validateManagedRowIntent(intent);
  if (value.command !== "create-managed-row") throw new Error("CLI foreground custody requires create-managed-row intent");
  return `sha256:${createHash("sha256").update(canonicalJson({ domain: "cotal.cli-foreground-managed-row.v1", intent: value })).digest("hex")}`;
}
export function validateManagedRowAttemptAuthority(raw: ManagedRowAttemptAuthority | undefined): ManagedRowAttemptAuthority | undefined {
  if (raw === undefined) return undefined;
  const obj = plainObject(raw, "managed-row attempt authority"); closed(obj, ["kind", "instanceId", "processEpoch"], "managed-row attempt authority");
  if (obj.kind !== "local-manager" || typeof obj.processEpoch !== "number" || !Number.isSafeInteger(obj.processEpoch) || obj.processEpoch < 0)
    throw new Error("managed-row local-manager authority requires a non-negative processEpoch");
  return { kind: "local-manager", instanceId: assertLifecycleToken(text(obj.instanceId, "manager instanceId"), "manager instanceId"), processEpoch: obj.processEpoch };
}
function validateBind(raw: EpBindBlock | undefined): EpBindBlock | undefined {
  if (raw === undefined) return undefined;
  const obj = plainObject(raw, "managed-row responder bind"); closed(obj, ["instanceId", "epoch"], "managed-row responder bind");
  if (typeof obj.epoch !== "number" || !Number.isSafeInteger(obj.epoch) || obj.epoch < 0)
    throw new Error("managed-row responder bind requires a non-negative epoch");
  return { instanceId: assertLifecycleToken(text(obj.instanceId, "responder instanceId"), "responder instanceId"), epoch: obj.epoch };
}
function validateMappingRevision(raw: number | undefined, intent: ManagedRowIntent): number | undefined {
  if (raw === undefined) return undefined;
  if (intent.command !== "revoke-managed-row") throw new Error("mappingRevision is supported only for revoke-managed-row attempts");
  if (!Number.isSafeInteger(raw) || raw < 0) throw new Error("managed-row mappingRevision must be a non-negative safe integer");
  return raw;
}
function attemptDigest(caller: EpCaller, intent: ManagedRowIntent, authority?: ManagedRowAttemptAuthority, bind?: EpBindBlock, mappingRevision?: number): Buffer {
  const value = validateManagedRowIntent(intent);
  const committed = { domain: MANAGED_ROW_ATTEMPT_DOMAIN, command: value.command, caller: { owner: assertBoundedOwner(caller.owner, "caller owner"), actor: assertBoundedOwner(caller.actor, "caller actor"), uid: assertLifecycleToken(caller.uid, "caller lifecycleUid") }, intent: value, ...(authority !== undefined ? { authority: validateManagedRowAttemptAuthority(authority) } : {}), ...(bind !== undefined ? { bind: validateBind(bind) } : {}), ...(mappingRevision !== undefined ? { mappingRevision: validateMappingRevision(mappingRevision, value) } : {}) };
  return createHash("sha256").update(canonicalJson(committed), "utf8").digest();
}
export function createManagedRowAttempt(caller: EpCaller, intent: ManagedRowIntent, random: Uint8Array = randomBytes(16), authority?: ManagedRowAttemptAuthority, envelope: { bind?: EpBindBlock; mappingRevision?: number } = {}): ManagedRowAttempt {
  if (random.byteLength !== 16) throw new Error("managed-row attempt random prefix must be exactly 16 bytes");
  const value = validateManagedRowIntent(intent);
  const boundAuthority = validateManagedRowAttemptAuthority(authority);
  const bind = validateBind(envelope.bind);
  const mappingRevision = validateMappingRevision(envelope.mappingRevision, value);
  const digest = attemptDigest(caller, value, boundAuthority, bind, mappingRevision);
  const nonce = Buffer.concat([Buffer.from(random), digest]).toString("base64url");
  if (nonce.length !== 64) throw new Error("managed-row attempt nonce must encode to exactly 64 base64url characters");
  return { ver: 1, command: value.command, caller, intent: value, nonce, ...(boundAuthority !== undefined ? { authority: boundAuthority } : {}), ...(bind !== undefined ? { bind } : {}), ...(mappingRevision !== undefined ? { mappingRevision } : {}) };
}
export function verifyManagedRowAttemptNonce(nonce: string, caller: EpCaller, intent: ManagedRowIntent, authority?: ManagedRowAttemptAuthority, bind?: EpBindBlock, mappingRevision?: number): void {
  if (!/^[A-Za-z0-9_-]{64}$/.test(nonce)) throw new Error("managed-row attempt nonce must be exactly 64 base64url characters");
  const bytes = Buffer.from(nonce, "base64url");
  if (bytes.byteLength !== 48) throw new Error("managed-row attempt nonce must decode to exactly 48 bytes");
  const expected = attemptDigest(caller, intent, validateManagedRowAttemptAuthority(authority), validateBind(bind), validateMappingRevision(mappingRevision, validateManagedRowIntent(intent)));
  if (!timingSafeEqual(bytes.subarray(16), expected)) throw new Error("managed-row attempt commitment does not match authenticated caller and stable intent");
}
