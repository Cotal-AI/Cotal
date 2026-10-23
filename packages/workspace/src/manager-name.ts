import { assertLifecycleToken, assertValidName, writeSecretFileAtomic } from "@cotal-ai/core";
import { canonicalLocalProcessPath, type LocalProcessContext } from "./local-process.js";
import { CommandFailure } from "./output.js";
import { localRecordObject, localRecordText, readLocalRecordSource } from "./protected-records.js";

/** The name a manager started without one puts on its presence card. */
export const DEFAULT_MANAGER_NAME = "manager";

/** Where a root keeps the name of its manager for one space. The name belongs to the logical
 *  instance, which persists in the root across restarts, so a restart or a repair keeps it. */
export const MANAGER_NAME_RECORD = "manager.{space}.name.json";

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
