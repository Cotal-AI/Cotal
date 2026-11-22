import { assertLifecycleToken, assertValidName, writeSecretFileAtomic } from "@cotal-ai/core";
import { canonicalLocalProcessPath, type LocalProcessContext } from "./local-process.js";
import { CommandFailure } from "./output.js";
import { identityRecord, type ProcessIdentityRecord } from "./pid.js";
import { decodeLocalJson, localRecordObject, localRecordText, readLocalRecordSource } from "./protected-records.js";

/** The name a manager started without one puts on its presence card. */
export const DEFAULT_MANAGER_NAME = "manager";

/** Where a root keeps the name of its manager for one space. The name belongs to the logical
 *  instance, which persists in the root across restarts, so a restart or a repair keeps it. */
export const MANAGER_NAME_RECORD = "manager.{space}.name.json";

/** Per-space runtime evidence. Any record left by an exited manager is ignored by its successor. */
export const LIVE_MANAGER_NAME_RECORD = "manager.{space}.live-name.json";

/** Whether `value` has the shape of a manager instance id, which `--on` reads as an id. */
export function instanceIdShaped(value: string): boolean {
  try { assertLifecycleToken(value); return true; } catch { return false; }
}

/** Check a manager name: the shared display-name rules, and not the shape of an instance id. */
export function assertManagerName(name: string): string {
  try { assertValidName(name); }
  catch (error) { throw new CommandFailure("refused", "USAGE_INVALID", (error as Error).message.replace(/^invalid name/, "invalid manager name")); }
  if (instanceIdShaped(name))
    throw new CommandFailure("refused", "USAGE_INVALID", `manager name "${name}" has the shape of an instance id, so --on would read it as one; choose a name that is not 26 to 32 lowercase letters and digits`);
  return name;
}

/** The name recorded for this root's manager, or undefined when none was given. */
export function readManagerName(context: LocalProcessContext): string | undefined {
  const path = canonicalLocalProcessPath(MANAGER_NAME_RECORD, context);
  const bytes = readLocalRecordSource(path, 4096, true);
  if (bytes === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the manager name record is not valid JSON", { target: { path } }); }
  const record = localRecordObject(value, ["version", "name"]);
  if (record.version !== 1) throw new CommandFailure("refused", "SCHEMA_INVALID", "the manager name record has an unsupported version", { target: { path } });
  return assertManagerName(localRecordText(record.name, 128));
}

/** Record `name` as this root's manager name for the space. */
export function recordManagerName(context: LocalProcessContext, name: string): void {
  writeSecretFileAtomic(canonicalLocalProcessPath(MANAGER_NAME_RECORD, context), JSON.stringify({ version: 1, name: assertManagerName(name) }));
}

/** The serving manager publishes its name independently of the setting for the next start. */
export function publishLiveManagerName(context: LocalProcessContext, name: string): void {
  const self = identityRecord(process.pid);
  if (!("token" in self)) throw new Error("cannot establish the manager's process creation identity");
  writeSecretFileAtomic(canonicalLocalProcessPath(LIVE_MANAGER_NAME_RECORD, context), JSON.stringify({ version: 1, ...self, name: assertManagerName(name) }));
}

/** Read the name only for the exact manager process the caller observed running. */
export function readLiveManagerName(context: LocalProcessContext, process: ProcessIdentityRecord): string | undefined {
  const bytes = readLocalRecordSource(canonicalLocalProcessPath(LIVE_MANAGER_NAME_RECORD, context), 4096, true);
  if (bytes === undefined) return undefined;
  const record = localRecordObject(decodeLocalJson(bytes), ["version", "pid", "token", "name"]);
  if (record.version !== 1 || record.pid !== process.pid || record.token !== process.token) return undefined;
  return assertManagerName(localRecordText(record.name, 128));
}
