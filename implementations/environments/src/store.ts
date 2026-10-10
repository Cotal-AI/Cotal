import type { KV, KvEntry } from "@nats-io/kv";
import { compileContract } from "@cotal-ai/core";
import type { EnvironmentRecord, EnvironmentStore } from "./service.js";

const TEXT = { type: "string", minLength: 1, maxLength: 256 } as const;
const TIME = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
export const ENVIRONMENT_REFERENCE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: TEXT, id: TEXT },
} as const;
export const ENVIRONMENT_RECORD_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["v", "id", "caller", "profile", "profileDigest", "provider", "createdAt", "expiresAt", "destroyRequested"],
  properties: {
    v: { const: 1 }, id: { type: "string", pattern: "^[a-f0-9]{64}$" },
    caller: { type: "object", additionalProperties: false, required: ["owner", "actor", "uid"], properties: { owner: TEXT, actor: TEXT, uid: TEXT } },
    profile: TEXT, profileDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, provider: TEXT,
    createdAt: TIME, expiresAt: TIME, environment: ENVIRONMENT_REFERENCE_SCHEMA,
    destroyRequested: { type: "boolean" }, retirementReceipt: TEXT, terminatedAt: TIME,
  },
} as const;
const contract = compileContract({ root: ENVIRONMENT_RECORD_SCHEMA });
function validate(value: unknown, id: string): EnvironmentRecord {
  if (!contract.validate(value)) throw new Error("invalid environment record");
  const row = value as EnvironmentRecord;
  if (row.id !== id || row.expiresAt <= row.createdAt || (row.environment && row.environment.kind !== row.provider) ||
    (row.terminatedAt !== undefined && (!row.environment || !row.destroyRequested || !row.retirementReceipt)))
    throw new Error("inconsistent environment record");
  return row;
}
function key(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid environment id");
  return `environment.${id}`;
}
function decode(entry: KvEntry): EnvironmentRecord {
  if (entry.operation !== "PUT") throw new Error("environment record deletion is corruption");
  return validate(JSON.parse(entry.string()), entry.key.slice("environment.".length));
}

/** Dedicated host-private KV, never the Cotal authority records bucket or a caller-accessible one.
 * Keep rows and tombstones indefinitely in this slice: expiry must never permit another create. */
export async function environmentKvStore(kv: KV): Promise<EnvironmentStore> {
  const status = await kv.status();
  const config = status.streamInfo.config;
  if (status.storage !== "file" || status.history !== 1 || status.ttl !== 0 || config.allow_msg_ttl ||
    config.retention !== "limits" || config.discard !== "new" || config.mirror || config.sources?.length || config.allow_rollup_hdrs)
    throw new Error("environment store needs file-backed, history-1, non-expiring limits retention with discard-new and no rollups, mirrors or sources");
  return {
    async get(id) {
      const entry = await kv.get(key(id));
      return entry ? { record: decode(entry), revision: entry.revision } : undefined;
    },
    async put(record, expectedRevision) {
      validate(record, record.id);
      try {
        // Unlike KV.create, expected-sequence zero cannot resurrect a DEL/PURGE marker.
        await kv.put(key(record.id), JSON.stringify(record), { previousSeq: expectedRevision });
        return true;
      } catch (error) {
        const code = (error as { api_error?: { err_code?: number } }).api_error?.err_code;
        if (code === 10071) return false;
        throw error;
      }
    },
    async *records() {
      // keys() hides deletion markers. history-1 gives a marker-preserving current-row scan.
      const entries = await kv.history({ key: "environment.*" });
      try { for await (const entry of entries) yield decode(entry); }
      finally { entries.stop(); }
    },
  };
}
