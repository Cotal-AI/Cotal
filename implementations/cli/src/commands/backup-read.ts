import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, presentationOf, writeResult, type Report } from "@cotal-ai/workspace";
import { ArtifactFileFault, inspectBackupArtifact } from "../lib/backup-artifact.js";

/** Integrity is a file observation, never evidence of a successful restore or authority continuity. */
export function backupRead(args: ParsedArgs): void {
  const [mode, directory] = args.positionals;
  let result: ReturnType<typeof inspectBackupArtifact>;
  try { result = inspectBackupArtifact(directory!, mode === "verify"); }
  catch (error) {
    if (isCommandFailure(error)) throw error;
    if (manifestMissing(resolve(directory!))) throw new CommandFailure("refused", "SCHEMA_INVALID", `${resolve(directory!)} has no manifest.json, so it is an incomplete artifact, as an interrupted backup create leaves one; nothing in it was checked`, { target: { directory: resolve(directory!), fault: "manifest-missing" }, remedy: "it cannot be verified or restored. In the folder it was created from, cotal status names the interrupted backup attempt, and cotal backup recover <attempt> --yes removes this directory; then create a new backup" });
    if (error instanceof ArtifactFileFault) throw new CommandFailure("refused", "SCHEMA_INVALID", `${error.message}; no file content or other manifest value was printed`, { target: { directory: resolve(directory!), file: error.file, fault: error.fault }, remedy: "this copy cannot be restored as it is: verify another copy of the same artifact, or create a new backup from a stopped preserved cut; this command did not restore, start a broker or write a staging directory" });
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the artifact is missing, unreadable, changed, or does not match its declared format/inventory/integrity; raw manifest values were not printed", { remedy: "inspect the original private artifact without editing it; this command did not restore, start a broker or write a staging directory" });
  }
  writeResult(presentationOf(args.values), { command: `backup ${mode}`, target: { space: result.space, directory: result.directory }, result }, (data): Report => ({ sections: [
    { title: mode === "verify" ? "Backup file integrity matched" : "Backup manifest inspected", blocks: [
      { kind: "fields", rows: [["Artifact", data.directory], ["Space", data.space], ["Selection", data.selection], ["Auth mode", data.mode], ["Created", data.createdAt], ["Source store", data.sourcePath], ["Source generation", data.sourceGeneration], ["Files", String(data.fileCount)], ["Declared bytes", String(data.bytesDeclared)], ["Manifest SHA-256", data.manifestSha256], ["File integrity", data.integrity], ["Authority continuity", { text: "not checked", tone: "waiting" }], ["Restoration", { text: "not attempted or proved", tone: "waiting" }]] },
      { kind: "lines", lines: [{ text: mode === "verify" ? "Each named regular file matched its declared size and SHA-256 during this bounded file observation. Hashes are not a signature: matching a manifest does not authenticate who created it, prove snapshot semantics or establish that a restore will succeed." : "Manifest structure and exact file-name inventory only. Snapshot/checkpoint contents were not read for integrity. A readable manifest is not a verified or restorable backup.", tone: "hint" }] },
    ] },
    { title: "Declared files", blocks: [
      { kind: "table", columns: [{ key: "path", label: "File" }, { key: "kind", label: "Kind" }, { key: "stream", label: "Declared stream" }, { key: "size", label: "Bytes" }], rows: data.files.slice(0, 100).map((file) => ({ path: file.path, kind: file.kind, stream: file.stream ?? "not a stream snapshot", size: String(file.size) })) },
      ...(data.files.length > 100 ? [{ kind: "lines" as const, lines: [`${data.files.length - 100} file rows are not shown; JSON retains the full declared inventory.`] }] : []),
      { kind: "lines", lines: ["No broker was contacted or started, no snapshot was restored, and no staging directory was written. The artifact is not modified. Private snapshot bytes, stream configuration bodies and trust material are not printed or uploaded."] },
    ] },
  ] }));
}

/** A real directory with no `manifest.json`: create writes the manifest last, so this is a backup that
 *  never published. */
function manifestMissing(directory: string): boolean {
  try { return lstatSync(directory).isDirectory() && !lstatSync(join(directory, "manifest.json"), { throwIfNoEntry: false }); }
  catch { return false; }
}
