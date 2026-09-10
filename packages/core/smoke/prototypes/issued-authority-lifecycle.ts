import type { KV } from "@nats-io/kv";
import { canonicalJson, rawDigest } from "../../src/canonical.js";
import { isCasLoss } from "../../src/endpoint-records.js";
import { callerTokens, endpointToken, type EpCaller } from "../../src/endpoint-subjects.js";
import { readSubjectPermission, type IssuedSubjectPermissions } from "./issued-subject-permissions.js";

// Test-only persistence/ordering prototype. Source authorization remains the adapter's job.
export interface IssuedRef extends EpCaller { space: string; generation: string }
export interface SourceRef { space: string; bucket: string; key: string }
interface Evidence { version: 1; ref: IssuedRef; sources: SourceRef[]; permissions: IssuedSubjectPermissions }
type State = "prepared" | "active" | "aborted" | "revoked";
export interface PreparedIssuance { readonly key: string }
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const bytes = (value: unknown) => enc.encode(canonicalJson(value));

function closed(value: unknown, fields: string[]): Record<string, unknown> {
  canonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...fields].sort().join(","))
    throw new Error("invalid prototype record fields");
  return value as Record<string, unknown>;
}
function refSnapshot(value: IssuedRef): IssuedRef {
  closed(value, ["space", "owner", "actor", "uid", "generation"]);
  endpointToken(value.space);
  callerTokens(value);
  if (typeof value.generation !== "string" || !/^[a-f0-9]{32}$/.test(value.generation))
    throw new Error("invalid issued generation");
  return Object.freeze({ ...value });
}
function sourceSnapshot(value: SourceRef): SourceRef {
  closed(value, ["space", "bucket", "key"]);
  endpointToken(value.space);
  if (typeof value.bucket !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.bucket)
    || typeof value.key !== "string" || value.key.length > 1024
    || !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(value.key))
    throw new Error("invalid source coordinate");
  return Object.freeze({ ...value });
}
export function evidenceKey(ref: IssuedRef): string {
  const snap = refSnapshot(ref);
  return `v1.${callerTokens(snap).join(".")}.${snap.generation}`;
}
export function sourcePrefix(source: SourceRef): string {
  const s = sourceSnapshot(source);
  return `bysource.v1.${rawDigest(JSON.stringify([1, s.space, s.bucket, s.key])).slice(7)}.`;
}
export function sourceIndexKey(source: SourceRef, ref: IssuedRef): string {
  if (source.space !== ref.space) throw new Error("foreign source space");
  return sourcePrefix(source) + evidenceKey(ref).slice(3);
}
function evidenceSnapshot(value: Evidence): Evidence {
  closed(value, ["version", "ref", "sources", "permissions"]);
  if (value.version !== 1 || !Array.isArray(value.sources) || value.sources.length === 0)
    throw new Error("unsupported evidence or empty sources");
  const ref = refSnapshot(value.ref);
  const sources = value.sources.map(sourceSnapshot);
  for (const source of sources) if (source.space !== ref.space) throw new Error("foreign source space");
  if (new Set(sources.map(sourcePrefix)).size !== sources.length) throw new Error("duplicate source");
  closed(value.permissions, ["publish", "subscribe"]);
  const permissions = Object.freeze({
    publish: readSubjectPermission(value.permissions.publish),
    subscribe: readSubjectPermission(value.permissions.subscribe),
  });
  Object.freeze(sources);
  return Object.freeze({ version: 1, ref, sources, permissions });
}

export async function openIssuedLifecycle(kv: KV, space: string) {
  endpointToken(space);
  const status = await kv.status();
  const config = status.streamInfo.config;
  if (status.bucket !== `cotal_issued_${space}` || config.allow_direct !== false
    || config.storage !== "file" || config.mirror || config.sources?.length
    || (config.max_age ?? 0) !== 0 || (config.max_msgs ?? -1) > 0 || (config.max_bytes ?? -1) > 0)
    throw new Error("issued store requires a primary, leader-read, file-backed bucket without eviction limits");
  const staged = new WeakMap<PreparedIssuance, {
    evidence: Evidence; revision: number; digest: string; material: string; consumed: boolean;
  }>();
  function own(ref: IssuedRef): string {
    if (ref.space !== space) throw new Error("foreign evidence space");
    return evidenceKey(ref);
  }
  async function read(key: string) {
    const entry = await kv.get(key);
    if (!entry || entry.operation !== "PUT") throw new Error(`missing or deleted prototype row: ${key}`);
    return { value: JSON.parse(dec.decode(entry.value)), revision: entry.revision };
  }
  async function readEvidence(ref: IssuedRef) {
    const key = own(ref);
    const entry = await read(key);
    const evidence = evidenceSnapshot(entry.value);
    if (canonicalJson(evidence.ref) !== canonicalJson(ref)) throw new Error("evidence identity mismatch");
    return { evidence, digest: rawDigest(canonicalJson(evidence)) };
  }
  async function readAttempt(ref: IssuedRef, digest: string) {
    const entry = await read(`attempt.${own(ref)}`);
    const row = closed(entry.value, ["version", "state", "digest"]);
    if (row.version !== 1 || row.digest !== digest
      || !["prepared", "active", "aborted", "revoked"].includes(row.state as string))
      throw new Error("invalid attempt state or evidence digest");
    return { state: row.state as State, revision: entry.revision };
  }
  async function retire(ref: IssuedRef): Promise<State> {
    const { digest } = await readEvidence(ref);
    for (let i = 0; i < 4; i++) {
      const row = await readAttempt(ref, digest);
      if (row.state === "aborted" || row.state === "revoked") return row.state;
      const state = row.state === "prepared" ? "aborted" : "revoked";
      try {
        await kv.update(`attempt.${own(ref)}`, bytes({ version: 1, state, digest }), row.revision);
        return state;
      } catch (error) { if (!isCasLoss(error)) throw error; }
    }
    throw new Error("retirement lost repeated CAS attempts");
  }
  return {
    async stage(ref: IssuedRef, permissions: IssuedSubjectPermissions, sources: SourceRef[], material: string): Promise<PreparedIssuance> {
      const evidence = evidenceSnapshot({ version: 1, ref, sources, permissions });
      const key = own(evidence.ref);
      // A fresh generation only. This prototype has no reconnect/retry redemption path.
      if (await kv.get(key)) throw new Error("issued generation already exists");
      const digest = rawDigest(canonicalJson(evidence));
      await kv.create(key, bytes(evidence));
      const revision = await kv.create(`attempt.${key}`, bytes({ version: 1, state: "prepared", digest }));
      for (const source of evidence.sources) {
        await kv.create(sourceIndexKey(source, evidence.ref), bytes({ source, ref: evidence.ref }));
      }
      const handle = Object.freeze({ key });
      staged.set(handle, { evidence, revision, digest, material, consumed: false });
      return handle;
    },
    async release(handle: PreparedIssuance, finalizeExisting: () => Promise<void>): Promise<string> {
      const snap = staged.get(handle);
      if (!snap || snap.consumed) throw new Error("unknown or consumed staged issuance");
      snap.consumed = true;
      try {
        await finalizeExisting();
        await kv.update(`attempt.${handle.key}`, bytes({ version: 1, state: "active", digest: snap.digest }), snap.revision);
      } catch (error) {
        try { await retire(snap.evidence.ref); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "issuance failed; retirement remains unconfirmed; no material released"); }
        throw error;
      }
      return snap.material;
    },
    retire,
    async resolve(ref: IssuedRef, sourceIsLive: (source: SourceRef) => Promise<boolean>): Promise<IssuedSubjectPermissions> {
      const { evidence, digest } = await readEvidence(ref);
      const before = await readAttempt(ref, digest);
      if (before.state !== "active") throw new Error("issued authority is not active");
      for (const source of evidence.sources) {
        if (!await sourceIsLive(source)) throw new Error("issued source is not live");
      }
      const after = await readAttempt(ref, digest);
      if (after.state !== "active" || after.revision !== before.revision)
        throw new Error("issued authority changed during resolution");
      return evidence.permissions;
    },
    // The caller must freeze the EXISTING source gate before this walk. Test-only KV.keys
    // uses an operator connection; production needs the existing sealed scanner discipline.
    async retireSource(source: SourceRef): Promise<number> {
      source = sourceSnapshot(source);
      if (source.space !== space) throw new Error("foreign source space");
      let count = 0;
      const keys = await kv.keys(`${sourcePrefix(source)}>`);
      for await (const key of keys) {
        const entry = await read(key);
        const index = closed(entry.value, ["source", "ref"]);
        const ref = refSnapshot(index.ref as IssuedRef);
        if (canonicalJson(index.source) !== canonicalJson(source) || key !== sourceIndexKey(source, ref))
          throw new Error("source index coordinate mismatch");
        const { evidence } = await readEvidence(ref);
        if (!evidence.sources.some((s) => canonicalJson(s) === canonicalJson(source)))
          throw new Error("source index is absent from evidence");
        await retire(ref);
        count++;
      }
      return count;
    },
  };
}
