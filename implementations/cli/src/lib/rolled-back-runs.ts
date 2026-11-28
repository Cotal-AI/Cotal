import { join } from "node:path";
import { jetstreamManager, type MsgRequest } from "@nats-io/jetstream";
import {
  CHANNEL_DEFAULTS_KEY, GOVERN_HEAD, RECORD_KINDS, channelBucket, historyLimitOf, historyLimitStreamOf, isStreamNotFound, parseRecordKey, parseRunJournalRecord,
  recordsBucket, recordsKvStreamName, spacePrefix, validateBackupStreamState,
  validateCanonicalBackupStreamConfig, validateSpaceBackupInventory, wfjStreamName, type SpaceAuth,
} from "@cotal-ai/core";
import type { AttemptOwnedPath, MaintenanceAuthMode, ProcessOwner, RolledBackRun } from "@cotal-ai/workspace";
import type { BackupStreamRecord } from "./backup-artifact.js";
import { connectIsolatedBroker, createAttemptClone, ensurePrivateAttemptsDir, startIsolatedBroker, type IsolatedBroker } from "./isolated-broker.js";
import { restoredPluginState } from "./restore-streams.js";

/** The most runs a restore's launch lists; it counts the rest. */
const MAX_LISTED_RUNS = 50;
/** The most reopened steps it lists for one run. */
const MAX_LISTED_STEPS = 20;

/** One run's step journal as a store holds it: its row count and the last state of each step. */
export interface RunJournalView {
  readonly rows: number;
  readonly steps: ReadonlyMap<string, string>;
}

/** Every run's step journal on an isolated broker, read through the read-only WFJ journal login. A
 *  store with no WFJ stream holds no run. */
export async function readRunJournals(broker: IsolatedBroker, space: string): Promise<Map<string, RunJournalView>> {
  const login = await broker.addLogin({ profile: "restore", scope: { operation: "journal" } });
  const nc = await connectIsolatedBroker(broker, login);
  const runs = new Map<string, RunJournalView>();
  try {
    const jsm = await jetstreamManager(nc, { checkAPI: false });
    const stream = wfjStreamName(space), prefix = `${spacePrefix(space)}.wfj.`;
    let subjects: Record<string, number>;
    try { subjects = (await jsm.streams.info(stream, { subjects_filter: `${prefix}*` })).state.subjects ?? {}; }
    catch (error) { if (isStreamNotFound(error)) return runs; throw error; }
    for (const subject of Object.keys(subjects)) {
      const steps = new Map<string, string>();
      let rows = 0;
      // Leader reads in sequence order: WFJ serves no direct get, and this broker is a private one.
      for (let seq = 1; ;) {
        const message = await jsm.streams.getMessage(stream, { seq, next_by_subj: subject } as unknown as MsgRequest);
        if (!message) break;
        const record = parseRunJournalRecord(message.json(), subject);
        rows += 1;
        if (record.kind === "step") {
          const entry = record.entry as { scope?: unknown; kind?: unknown; name?: unknown; occurrence?: unknown; state?: unknown };
          if (typeof entry.scope === "string" && typeof entry.kind === "string" && typeof entry.name === "string" && typeof entry.occurrence === "number" && typeof entry.state === "string")
            steps.set(`${entry.scope}/${entry.name === "" ? entry.kind : `${entry.kind}:${entry.name}`}#${entry.occurrence}`, entry.state);
        }
        seq = message.seq + 1;
      }
      runs.set(subject.slice(prefix.length), { rows, steps });
    }
  } finally {
    await nc.close();
  }
  return runs;
}

/** The runs a restore rolled back: each one the previous store's journal holds further than the
 *  restored one, with the steps settled there that are open again. A run the restored store does not
 *  hold started after the artifact. */
export function rolledBackRuns(previous: ReadonlyMap<string, RunJournalView>, restored: ReadonlyMap<string, RunJournalView>): { runs: RolledBackRun[]; more: number } {
  const all: RolledBackRun[] = [];
  for (const [run, before] of previous) {
    const after = restored.get(run);
    if (after && after.rows >= before.rows) continue;
    const reopened = after ? [...before.steps].filter(([key, state]) => state === "settled" && after.steps.get(key) === "pending").map(([key]) => key) : [];
    all.push({ run, reopened: reopened.slice(0, MAX_LISTED_STEPS), ...(after ? {} : { missing: true as const }) });
  }
  return { runs: all.slice(0, MAX_LISTED_RUNS), more: Math.max(0, all.length - MAX_LISTED_RUNS) };
}

/** Read the stored value and headers of the one channel default key. */
export async function readRegistryDefault(broker: IsolatedBroker, space: string): Promise<string | undefined> {
  try {
    const login = await broker.addLogin({ profile: "registry-read" });
    const nc = await connectIsolatedBroker(broker, login);
    try {
      const bucket = channelBucket(space);
      const subject = `$KV.${bucket}.${CHANNEL_DEFAULTS_KEY}`;
      const reply = await nc.request(`$JS.API.DIRECT.GET.KV_${bucket}.${subject}`, new Uint8Array(0), { timeout: 2_000 });
      const headers = reply.headers;
      if (!headers || headers.code || headers.get("Nats-Stream") !== `KV_${bucket}` || headers.get("Nats-Subject") !== subject) return undefined;
      // Direct get appends these four headers. A duplicate could be a stored header, so keep consent.
      const entries = [...headers];
      const metadata = /^Nats-(Stream|Subject|Sequence|Time-Stamp)$/i;
      const added = entries.filter(([key]) => metadata.test(key));
      if (new Set(added.map(([key]) => key.toLowerCase())).size !== 4 || added.length !== 4 ||
          added.some(([, values]) => values.length !== 1)) return undefined;
      return JSON.stringify([Buffer.from(reply.data).toString("base64"), entries.filter(([key]) => !metadata.test(key))]);
    } finally {
      await nc.close();
    }
  } catch {
    return undefined;
  }
}

async function previousStoreHasNoUniqueState(broker: IsolatedBroker, space: string, restoredDefault: string | undefined, recordedStreams: readonly BackupStreamRecord[]): Promise<boolean> {
  try {
    const login = await broker.addLogin({ profile: "backup", scope: { operation: "inspect", selection: "full" } });
    const nc = await connectIsolatedBroker(broker, login);
    let compareDefault = false;
    try {
      const jsm = await jetstreamManager(nc, { checkAPI: false });
      const names: string[] = [];
      const list = jsm.streams.names();
      for (let page: string[]; (page = await list.next()).length;) names.push(...page);
      const inventory = validateSpaceBackupInventory(space, names, { atRest: true });
      const records = recordsKvStreamName(space);
      for (const { name, class: kind } of inventory.backedUp) {
        const info = await jsm.streams.info(name, name === records ? { subjects_filter: ">" } : undefined);
        const config = info.config as unknown as Record<string, unknown>;
        validateCanonicalBackupStreamConfig(space, name, config);
        if (historyLimitStreamOf(space, name)) {
          const recorded = recordedStreams.find((entry) => entry.stream === name)?.config;
          if (typeof recorded?.max_age !== "number" || typeof recorded.max_msgs_per_subject !== "number" ||
              typeof config.max_age !== "number" || typeof config.max_msgs_per_subject !== "number") return false;
          const before = historyLimitOf(config), restored = historyLimitOf(recorded);
          if (before.maxAgeMs !== restored.maxAgeMs || before.perSubject !== restored.perSubject) return false;
        }
        const state = validateBackupStreamState(info.state as unknown as Record<string, unknown>);
        // Do not waive consent for a checkpoint without comparing its config and ACK floor.
        if (state.lost !== undefined || state.consumer_count !== 0) return false;
        switch (kind) {
          case "registry":
            if (state.last_seq === 0) break;
            // A fresh space writes one default. Prove the target holds it rather than comparing
            // counts, which can match for two unrelated stores with different settings.
            if (state.messages !== 1 || state.last_seq !== 1 || restoredDefault === undefined) return false;
            compareDefault = true;
            break;
          case "authorization":
            if (state.last_seq !== 0) return false;
            break;
          case "messages":
          case "workflow":
            // Zero messages with an advanced sequence does not rule out expiry on the clone.
            if (state.last_seq !== 0 && (name !== records || !hasOnlyManagerRegistration(state, space))) return false;
            break;
          default:
            return false;
        }
      }
    } finally {
      await nc.close();
    }
    return !compareDefault || (await readRegistryDefault(broker, space)) === restoredDefault;
  } catch {
    // An unsuccessful inspection cannot authorize deletion.
    return false;
  }
}

function hasOnlyManagerRegistration(state: ReturnType<typeof validateBackupStreamState>, space: string): boolean {
  const subjects = Object.entries(state.subjects ?? {});
  const prefix = `$KV.${recordsBucket(space)}.`;
  return state.messages > 0 && subjects.reduce((count, [, messages]) => count + messages, 0) === state.messages
    && subjects.every(([subject]) => {
      const key = subject.startsWith(prefix) ? parseRecordKey(subject.slice(prefix.length)) : null;
      return key?.qualifiers[0] === "manager" && (key.def === RECORD_KINDS.svc || key.def === GOVERN_HEAD);
    });
}

/** Read the set-aside state and journals from one private clone. A broker start can expire
 *  messages, so it must never open the preserved store itself. */
export async function inspectPreviousStore(options: {
  root: string;
  previousStore: string;
  attemptId: string;
  space: string;
  mode: MaintenanceAuthMode;
  auth?: SpaceAuth;
  restoredDefault: string | undefined;
  recordedStreams: readonly BackupStreamRecord[];
  deadline: Date;
  record: (input: { owners?: readonly ProcessOwner[]; ownedPaths?: readonly AttemptOwnedPath[] }) => void;
}): Promise<{ noUniqueState: boolean; runs: Map<string, RunJournalView> }> {
  options.record({ ownedPaths: [{ label: "clone", path: join(ensurePrivateAttemptsDir(options.root).path, `${options.attemptId}-clone`) }] });
  const clone = createAttemptClone(options.root, options.previousStore, options.attemptId);
  options.record({ ownedPaths: [{ label: "clone", path: clone.path, dev: clone.identity.dev.toString(), ino: clone.identity.ino.toString() }] });
  let broker: IsolatedBroker | undefined;
  try {
    broker = await startIsolatedBroker({
      root: options.root,
      storeDir: clone.path,
      space: options.space,
      mode: options.mode,
      ...(options.auth ? { auth: options.auth } : {}),
      deadline: options.deadline,
      label: "previous",
      initialScope: { profile: "restore", scope: { operation: "journal" } },
      attemptId: options.attemptId,
    });
    options.record({ owners: [broker.brokerOwner, broker.watchdogOwner], ownedPaths: broker.runFiles.map((file) => ({ label: "config" as const, ...file })) });
    if (options.mode !== "open") await restoredPluginState(broker, options.space);
    const runs = await readRunJournals(broker, options.space);
    return { noUniqueState: runs.size === 0 && await previousStoreHasNoUniqueState(broker, options.space, options.restoredDefault, options.recordedStreams), runs };
  } finally {
    if (broker) await broker.stop();
    clone.cleanup();
  }
}
