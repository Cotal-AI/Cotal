import { join } from "node:path";
import { JetStreamApiError } from "@nats-io/jetstream";
import { CotalEndpoint, mintCreds, newIdentity } from "@cotal-ai/core";
import { CommandFailure, boundedValue, loadMeshes, localProcessPath, oneLine, type MeshTarget } from "@cotal-ai/workspace";
import { pidfileState } from "../commands/down.js";
import { shellWord } from "./endpoint-errors.js";
import { readOwnedLogTail, readServiceLog } from "./service-process.js";
import { serviceInstances, instanceProjection } from "./service-instances.js";
import { readStackJournal, STACK_DEFINITION } from "./stack-journal.js";

/** What the running local broker's own log says about its JetStream store: a write it could not
 *  make, or damage it found in a stored file. nats-server reports a stream's write error natively
 *  only through `healthz`, which needs a system-account user, so this reads the log the broker writes
 *  on this machine: a bounded tail, and only lines tagged with the running broker's process id since
 *  its last start. A broker whose log is not on this machine is not checked. `full` is
 *  {@link storeFull}'s reading instead. */
export type StoreWriteObservation =
  | { state: "write-failed"; pid: number; log: string; at: string; cause: string; path: string | null; jetStreamDisabled: boolean }
  | { state: "damaged"; pid: number; log: string; at: string; warning: string }
  | { state: "full"; used: number; cap: number; path: string }
  | { state: "none-recorded"; pid: number; log: string }
  | { state: "not-checked"; reason: string };

/** The store a space's broker started from `root` runs on, and its `--max-file-store` cap, as this
 *  machine records them: the stack journal's broker inputs, else the space's registration, else the
 *  default `.cotal/nats` with no cap. */
export function recordedStore(root: string, space: string): { path: string; cap?: number } {
  const stack = readStackJournal(root)?.journal;
  const recorded = stack?.space === space && stack.broker ? stack.broker : loadMeshes().find((mesh) => mesh.space === space && mesh.root === root);
  return { path: recorded?.storeDir ?? join(root, ".cotal", "nats"), ...(recorded?.maxFileStore !== undefined ? { cap: recorded.maxFileStore } : {}) };
}

/** Whether `error`, or an error that caused it, is JetStream's 10023, insufficient resources, which
 *  the broker answers to every file-store write while its store holds more than its cap. */
export function storeRefusedWrite(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) if (e instanceof JetStreamApiError && e.code === 10023) return true;
  return false;
}

/** The refusal of a manager stop on a full store. Its native stop rides a control credential whose
 *  issuance record must be stored before the credential is released (SPEC 13.15), and a store over
 *  its cap refuses that write as every other, so the stop refuses before any signal. */
export function fullStoreStopRefusal(stopping: string, store: { path: string; cap?: number } | undefined, outcome: string, target: Record<string, unknown>, remedy: string): CommandFailure {
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the broker's JetStream store${store ? ` ${store.path}` : ""} is full${store?.cap !== undefined ? ` at its --max-file-store cap of ${store.cap} bytes` : ""}, and stopping ${stopping} needs a credential whose issuance record the full store cannot take; ${outcome}`, {
    target: { ...target, ...(store ? { store: store.path, ...(store.cap !== undefined ? { cap: store.cap } : {}) } : {}) },
    native: { code: "10023" },
    remedy,
  });
}

/** One read of the bytes `target`'s space holds in its broker's file store, over an observer
 *  credential, which writes nothing. Undefined for a user-auth space, for which this machine mints
 *  no observer, and when the read fails. */
export async function readStoredBytes(target: MeshTarget, name: string): Promise<number | undefined> {
  if (target.mode === "user") return undefined;
  const id = newIdentity();
  let ep: CotalEndpoint | undefined;
  try {
    ep = new CotalEndpoint({ space: target.space, servers: target.server, tls: target.tlsRequired, creds: target.auth ? await mintCreds(target.auth, id, "observer") : undefined, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { id: id.id, name, kind: "endpoint" } });
    ep.on("error", () => {});
    ep.on("warning", () => {});
    await ep.start();
    return await ep.storedBytes();
  } catch {
    return undefined;
  } finally {
    await ep?.stop().catch(() => {});
  }
}

/** A space holding more JetStream file storage than its broker's recorded cap. nats-server refuses
 *  every write once its stored bytes exceed `max_file_store`, so nothing more is stored until room is
 *  made. Undefined when no cap is recorded, as nats-server then sizes the store from the free disk at
 *  start, or while the space is under its cap. */
export function storeFull(root: string, space: string, used: number): Extract<StoreWriteObservation, { state: "full" }> | undefined {
  let store: ReturnType<typeof recordedStore>;
  try { store = recordedStore(root, space); } catch { return undefined; }
  return store.cap !== undefined && used > store.cap ? { state: "full", used, cap: store.cap, path: store.path } : undefined;
}

/** The step that repairs the store write `failed` names, by its cause: a permission this account
 *  lost, a read-only file system, a full disk, or else the cause as the broker logged it. It names the
 *  store this machine records for `space` at `root`, else the file the write failed on. */
export function storeWriteRepair(failed: Extract<StoreWriteObservation, { state: "write-failed" }>, root: string | undefined, space: string): string {
  let store: string | undefined;
  try { store = root ? recordedStore(root, space).path : undefined; } catch { store = undefined; }
  const where = store ?? failed.path ?? "the broker's store";
  if (/permission denied|operation not permitted/i.test(failed.cause)) return `make ${where} writable by this account again${store ? `, as chmod -R u+w ${shellWord(store)} does` : ""}`;
  if (/read-only file system/i.test(failed.cause)) return `make the file system that holds ${where} writable again`;
  if (/no space left|quota exceeded/i.test(failed.cause)) return `free space on the disk that holds ${where}`;
  return `fix what failed the write to ${where}: ${failed.cause}`;
}

/** The warnings nats-server logs for damage it finds in a stored file: a message block whose records
 *  do not parse, which it rebuilds without the messages from the damage on; a stream whose recovery
 *  rolled back past what a consumer had delivered; and a stream metafile that fails its checksum,
 *  which it does not load. `STREAM.INFO` reports no lost data for any of them. */
const STORE_DAMAGE = /^\[\d+\] (\S+ \S+) \[WRN\] +((?:Filestore \[[^\]]+\] indexCacheBuf corrupt |JetStream consumer '.+' delivered sequence \d+ past last stream sequence of |Stream metafile ".+": checksums do not match).*)$/;

/** The newest `Critical write error` the running broker logged since it started, else the newest
 *  damage it logged in a stored file. */
export function brokerStoreWrite(root: string, space: string): StoreWriteObservation {
  let broker: { pid: number; read: () => { lines: string[]; path: string | null } } | undefined;
  try {
    if (readStackJournal(root)?.journal.space === space) {
      const row = serviceInstances(space).map(instanceProjection).find((item) => item.definition === STACK_DEFINITION.broker && item.observedProcess === "running");
      if (row?.pid) broker = { pid: row.pid, read: () => readServiceLog(space, row.instanceId, 20_000) };
    } else {
      const record = pidfileState(localProcessPath("nats.pid", { root, space }));
      if (record.liveness === "alive" && record.pid) broker = { pid: record.pid, read: () => readOwnedLogTail(join(root, ".cotal", "nats.log"), 20_000) };
    }
  } catch {
    return { state: "not-checked", reason: "the local broker records could not be read" };
  }
  if (!broker) return { state: "not-checked", reason: "no running broker of this space is recorded on this machine" };
  let tail: { lines: string[]; path: string | null };
  try { tail = broker.read(); }
  catch { return { state: "not-checked", reason: "the broker's log could not be read" }; }
  if (!tail.path) return { state: "not-checked", reason: "the broker's log is not recorded on this machine" };
  const tag = `[${broker.pid}] `;
  const own = tail.lines.filter((line) => line.startsWith(tag));
  const started = own.findLastIndex((line) => line.includes("[INF] Starting nats-server"));
  // nats-server disables JetStream when a write is refused for permission or for space, and only a
  // restart, or a reload that logs JetStream starting again, brings it back.
  const since = own.slice(started + 1);
  const enabled = since.findLastIndex((line) => line.includes("[INF] Starting JetStream"));
  const jetStreamDisabled = since.slice(enabled + 1).some((line) => /disabling JetStream|JetStream out of space, will be DISABLED/.test(line));
  for (const line of [...since].reverse()) {
    const failed = /^\[\d+\] (\S+ \S+) \[ERR\] .*?ritical write error: (.+)$/.exec(line);
    if (!failed) continue;
    // Go reports a failed file operation as `<op> <path>: <cause>`.
    const parts = /^\S+ (\/.+): ([^:]+)$/.exec(failed[2]!);
    return { state: "write-failed", pid: broker.pid, log: tail.path, at: failed[1]!.replace(/\.\d+$/, ""), cause: parts ? parts[2]! : failed[2]!, path: parts ? parts[1]! : null, jetStreamDisabled };
  }
  for (const line of [...since].reverse()) {
    const damage = STORE_DAMAGE.exec(line);
    if (damage) return { state: "damaged", pid: broker.pid, log: tail.path, at: damage[1]!.replace(/\.\d+$/, ""), warning: oneLine(boundedValue(damage[2]!, 400)) };
  }
  return { state: "none-recorded", pid: broker.pid, log: tail.path };
}

/** The running local broker's store write failure when the broker then disabled JetStream. Until it
 *  restarts it answers no stream request, so no credential issuance record, stream check or lease
 *  write reaches it. */
export function jetStreamDisabled(root: string, space: string): Extract<StoreWriteObservation, { state: "write-failed" }> | undefined {
  const write = brokerStoreWrite(root, space);
  return write.state === "write-failed" && write.jetStreamDisabled ? write : undefined;
}

/** The refusal of a step that needs JetStream from a broker that disabled it. Only a restart brings
 *  JetStream back, the broker stops only after the manager, and the manager's own stop needs an
 *  issuance record, so the way out ends the manager's process on this host with a plain SIGTERM. */
export function jetStreamDisabledRefusal(write: Extract<StoreWriteObservation, { state: "write-failed" }>, root: string, space: string, needs: string, outcome: string, target: Record<string, unknown>, managerPid: number | undefined): CommandFailure {
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the broker logged a store write failure at ${write.at}: ${write.cause}, and disabled JetStream until it restarts, so ${needs}; ${outcome}`, {
    target: { ...target, brokerLog: write.log },
    remedy: `${managerPid !== undefined ? `end the manager on this host with kill -TERM ${managerPid}, which stops its agents by its default policy, then run cotal down` : "run cotal down"}; ${storeWriteRepair(write, root, space)}, then run cotal up`,
  });
}
