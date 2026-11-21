import { resolve } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace";
import { formatIssue, loadManifestWithSource, ManifestError } from "./manifest/index.js";
import { UnusableFile } from "./unusable-file.js";

/** Read a team manifest before contacting a broker, with the same refusals on every route. */
export function readTeamManifest(file: string): { path: string } & ReturnType<typeof loadManifestWithSource> {
  const path = resolve(file);
  try { return { path, ...loadManifestWithSource(path) }; }
  catch (error) {
    if (error instanceof ManifestError) throw manifestRefusal(error, path);
    if (error instanceof UnusableFile) throw error;
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT" && errno.path === path)
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the team manifest ${path} was not found; no broker was contacted`, { target: { path }, remedy: "check the file path and run the command again" });
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the team manifest or referenced persona could not be read and resolved; no broker was contacted", { target: { path }, remedy: "check the manifest schema, persona paths and permission declarations" });
  }
}

/** Name each located problem: its file, line, key and reason. Only a reason's first line is kept,
 *  because a persona file's YAML diagnostic goes on to quote that file's own lines. */
function manifestRefusal(e: ManifestError, path: string): CommandFailure {
  const issues = e.issues.map((issue) => ({ ...issue, message: issue.message.split("\n")[0]!.replace(/(at line \d+, column \d+):$/, "$1") }));
  const shown = issues.slice(0, 5).map((issue) => formatIssue(e.file, issue));
  if (issues.length > 5) shown.push(`${issues.length - 5} more with --json`);
  return new CommandFailure("refused", "SCHEMA_INVALID", `${issues.length === 1 ? "the team manifest has a problem" : `the team manifest has ${issues.length} problems`}, so no broker was contacted: ${shown.join("; ")}`,
    { target: { path, issues }, remedy: "fix each named problem and run team check again" });
}
