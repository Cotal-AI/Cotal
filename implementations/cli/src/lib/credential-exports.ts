import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isUserNkey, spacePrefix, taskStream } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { localRecordObject, localRecordText, ProtectedRecordStore } from "./protected-records.js";

/** The channel ACLs and role an agent credential carries. */
export interface AgentGrants { read: string[]; post: string[]; role: string | null }

/** An agent credential's grants, read back from the rows the agent profile mints: the
 *  `chat.*.*.<channel>` subscribe rows are its read ACL, its own `chat.<owner>.<actor>.<channel>`
 *  publish rows its post ACL, and the `svc_<role>` TASK bind row its role. */
export function agentGrants(nats: { pub?: { allow?: string[] }; sub?: { allow?: string[] } }, space: string): AgentGrants {
  const chat = `${spacePrefix(space)}.chat.`;
  const channels = (rows: readonly string[], own: boolean) => [...new Set(rows.filter((row) => row.startsWith(chat))
    .map((row) => row.slice(chat.length).split("."))
    .filter(([owner, actor]) => own ? owner !== "*" && actor !== "*" : owner === "*" && actor === "*")
    .map((parts) => parts.slice(2).join(".")).filter(Boolean))];
  const task = `$JS.API.CONSUMER.INFO.${taskStream(space)}.svc_`;
  const role = (nats.pub?.allow ?? []).find((row) => row.startsWith(task))?.slice(task.length);
  return { read: channels(nats.sub?.allow ?? [], false), post: channels(nats.pub?.allow ?? [], true), role: role || null };
}

/** What `auth mint --out` records about a file it wrote, so `doctor auth` can find the file again.
 *  Public values only; the credential stays in the file. */
export interface CredentialExport { schemaVersion: 1; label: string; profile: string; path: string; root: string; identity: string; writtenAt: string }

function validate(input: unknown): CredentialExport {
  const value = localRecordObject(input, ["schemaVersion", "label", "profile", "path", "root", "identity", "writtenAt"]);
  const label = localRecordText(value.label, 200), profile = localRecordText(value.profile, 32), path = localRecordText(value.path, 4096), root = localRecordText(value.root, 4096);
  const identity = localRecordText(value.identity, 56), writtenAt = localRecordText(value.writtenAt, 100);
  if (value.schemaVersion !== 1 || !isAbsolute(path) || !isAbsolute(root) || !isUserNkey(identity) || !Number.isFinite(Date.parse(writtenAt)) || /[\u0000-\u001f\u007f]/.test(label + path + root))
    throw new CommandFailure("refused", "SCHEMA_INVALID", "a credential export record is not valid; it was not used");
  return { schemaVersion: 1, label, profile, path, root, identity, writtenAt };
}

/** The space's export records, one per written file, under `<COTAL_HOME>/credentials/<space key>/exports`. */
export const credentialExportStore = (space: string) => new ProtectedRecordStore("credentials", space, validate, "exports");

/** Record that `auth mint --out` wrote `path`, replacing the record an earlier mint to the same file left. */
export function recordCredentialExport(space: string, entry: Omit<CredentialExport, "schemaVersion" | "writtenAt">): void {
  const store = credentialExportStore(space), name = createHash("sha256").update(entry.path).digest("hex");
  store.commit(name, store.read(name), { schemaVersion: 1, ...entry, writtenAt: new Date().toISOString() });
}
