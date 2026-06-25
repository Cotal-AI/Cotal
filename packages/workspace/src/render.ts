import type { MeshTarget, MeshTargetError } from "./mesh-target.js";
import type { PreflightFailure } from "./preflight.js";

/**
 * The single home for the toolchain's `cotal …` wording — optional and presentation-only.
 *
 * This is NOT part of the typed contract. Workspace internals never call it to decide behavior, no
 * control flow parses its output, and the rendered string is never baked back into a thrown error or
 * a result. A consumer that wants its own affordance — a web UI with a button, an SDK embed with no
 * command at all — reads the structured `{code, details}` / `{kind, …}` and ignores this entirely,
 * losing nothing. It exists so the CLI, the manager, and the delivery daemon speak the canonical
 * command copy with ONE voice instead of each hand-rolling it (the drift that motivated the split).
 * No colour, no `process`, no exit — the caller owns those.
 */
export type WorkspaceError =
  | { kind: "target"; error: MeshTargetError }
  | { kind: "preflight"; failure: PreflightFailure; target: MeshTarget; pruned: boolean }
  | { kind: "reachable"; reason: "auth-required" | "unreachable"; server: string };

/** Render a workspace failure as the canonical one-line `cotal …` sentence. */
export function renderWorkspaceError(e: WorkspaceError): string {
  switch (e.kind) {
    case "target":
      return renderTargetError(e.error);
    case "preflight":
      return renderPreflightFailure(e.failure, e.target, e.pruned);
    case "reachable":
      return renderReachable(e.reason, e.server);
  }
}

/** "Which mesh" resolution failures — maps a {@link MeshTargetError}'s `{code, details}` to copy. */
function renderTargetError(err: MeshTargetError): string {
  const d = err.details;
  switch (err.code) {
    case "no-meshes":
      return "✗ no mesh running — run `cotal up` in a project, or pass `--server`";
    case "unknown-space":
      return `✗ no mesh named "${d.requested}" is running — see \`cotal meshes\``;
    case "ambiguous-target":
      return `✗ multiple meshes running — ${(d.available ?? []).join(", ")}. Pick one with \`--space <name>\` or set a default with \`cotal use <name>\`.`;
    case "default-occupied":
      return `✗ another mesh ("${d.space}") is running at ${d.server} — run \`cotal up\` here to start yours, or \`--space ${d.space}\` to join it`;
    case "stale-auth-root":
      return `✗ registry entry "${d.space}" points at ${d.root}, whose auth is now for "${d.found}" — stale entry removed; re-run \`cotal up\` or check \`cotal meshes\``;
  }
}

/** "Is it live" failures on a registry-resolved target — the classified preflight sentence. */
function renderPreflightFailure(kind: PreflightFailure, t: MeshTarget, pruned: boolean): string {
  switch (kind) {
    case "unreachable":
      return `✗ no mesh running at ${t.server}${pruned ? " (stale registry entry — removed)" : ""} — run \`cotal up\``;
    case "registry-creds-rejected":
      return `✗ mesh "${t.space}" at ${t.server} no longer matches its registry entry (credentials rejected — port reused?) — re-run \`cotal up\` from ${t.root}, or \`cotal meshes\` to see what's live`;
    case "registry-open-now-auth":
      return `✗ open mesh "${t.space}" at ${t.server} no longer matches its registry entry (broker now requires auth — port reused?) — re-run \`cotal up\` from ${t.root}, or \`cotal meshes\` to see what's live`;
    case "creds-rejected":
      return `✗ credentials for "${t.space}" were rejected at ${t.server} — a different mesh may be running there. Run \`cotal meshes\` to check, or \`cotal up\` here to start yours`;
    case "open-wants-auth":
      return `✗ broker at ${t.server} requires auth, but this mesh is open (no trust material) — use \`--space <name>\` for an auth mesh, or run \`cotal up\` here without \`--open\``;
  }
}

/** Plain reachability for a RAW (off-registry) probe — the `--creds` / `--server`+unregistered-`--space`
 *  escape hatch, which never touches the registry (no prune, no stale-entry wording). */
function renderReachable(reason: "auth-required" | "unreachable", server: string): string {
  return reason === "auth-required"
    ? `✗ credentials rejected at ${server} — check your creds, or the broker wants different auth`
    : `✗ can't reach a broker at ${server} — is it running? (\`cotal up\`)`;
}
