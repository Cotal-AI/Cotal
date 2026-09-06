import type { KV, KvEntry } from "@nats-io/kv";
import { assertIdToken, endpointToken, recordsBucket, recordsKvStreamName, walkKvEntries, type RunHostPlanes } from "@cotal-ai/core";
import { RunScopeDenied } from "./run-scope-authority.js";

export interface RunRecordValue {
  readonly key: string;
  readonly value: Uint8Array;
  readonly revision: number;
  readonly createdAt: number;
  readonly operation: KvEntry["operation"];
}

/** A run-bound leader reader. Neither the backing bucket nor its stream API is exposed. */
export interface RunRecordHost {
  read(key: string): Promise<RunRecordValue | undefined>;
  list(filter: string): Promise<readonly RunRecordValue[]>;
}

export function createRunRecordHost(broker: Pick<RunHostPlanes, "kv" | "jsm" | "space">, endpoint: string, runId: string): RunRecordHost {
  const { kv, jsm, space } = broker;
  const e = endpointToken(endpoint);
  const run = assertIdToken(runId, "runId");
  const exact = new Set([`run.${e}.${run}.spec`, `run.${e}.${run}.status`, `program.${e}.${run}`]);
  const families = [`notice.${e}.${run}.`, `migration.${e}.${run}.`];
  const own = (key: string) => typeof key === "string"
    && (exact.has(key) || families.some((prefix) => key.startsWith(prefix) && key.length > prefix.length));
  const copy = (entry: KvEntry): RunRecordValue => Object.freeze({
    key: entry.key, value: entry.value.slice(), revision: entry.revision, createdAt: entry.created.getTime(), operation: entry.operation,
  });
  return Object.freeze({
    async read(key: string): Promise<RunRecordValue | undefined> {
      if (!own(key) || /[*>]/.test(key)) throw new RunScopeDenied(run, key, "read record");
      const message = await jsm.streams.getMessage(recordsKvStreamName(space), {
        last_by_subj: `$KV.${recordsBucket(space)}.${key}`,
      }).catch((error: unknown) => {
        if ((error as { code?: unknown })?.code === 10037) return null;
        throw error;
      });
      if (message === null || message === undefined) return undefined;
      const operation = message.header?.get("KV-Operation") || "PUT";
      if (operation !== "PUT" && operation !== "DEL" && operation !== "PURGE")
        throw new Error(`record ${key} carries an unknown operation ${operation}`);
      return Object.freeze({ key, value: message.data.slice(), revision: message.seq, createdAt: message.time.getTime(), operation });
    },
    async list(filter: string): Promise<readonly RunRecordValue[]> {
      if (!own(filter)) throw new RunScopeDenied(run, filter, "list records");
      const entries = await walkKvEntries(kv, filter);
      if (entries.some((entry) => !own(entry.key))) throw new RunScopeDenied(run, filter, "read outside record filter");
      return entries.map(copy);
    },
  });
}

/** Adapt the driver's own write-capable bucket for core's record helpers. Only get crosses
 *  the host boundary. Every other method and internal client still belongs to the driver,
 *  so reaching through this view cannot recover the host's broker connection. */
export function runRecordView(driver: KV, host: RunRecordHost, space: string): KV {
  const get: KV["get"] = async (key, options) => {
    if (options?.revision !== undefined)
      throw new Error("a run record view does not support revision-addressed reads");
    const value = await host.read(key);
    if (value === undefined) return null;
    const entry: KvEntry = {
      bucket: recordsBucket(space),
      key: value.key,
      rawKey: value.key,
      value: value.value,
      created: new Date(value.createdAt),
      revision: value.revision,
      operation: value.operation,
      delta: 0,
      length: value.value.length,
      string: () => new TextDecoder().decode(value.value),
      json: <T>() => JSON.parse(new TextDecoder().decode(value.value)) as T,
    };
    return entry;
  };
  return new Proxy(driver, {
    get(target, property) {
      if (property === "get") return get;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
