import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isUserNkey } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { localRecordObject, localRecordText, ProtectedRecordStore } from "./protected-records.js";

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
