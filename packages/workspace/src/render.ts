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
  | { kind: "reachable"; reason: "auth-required" | "stale-auth" | "unreachable"; server: string };

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
      return "✗ no mesh running - run `cotal up` in a project, or pass `--server`";
    case "unknown-space":
      return `✗ no mesh named "${d.requested}" is running - see \`cotal meshes\``;
    case "ambiguous-target":
      return `✗ multiple meshes running - ${(d.available ?? []).join(", ")}. Pick one with \`--space <name>\` or set a default with \`cotal use <name>\`.`;
    case "default-occupied":
      return `✗ another mesh ("${d.space}") is running at ${d.server} - run \`cotal up\` here to start yours, or \`--space ${d.space}\` to join it`;
    case "stale-auth-root":
      // An operator-registered entry is KEPT (only `cotal meshes rm` drops it), so the recovery
      // there is to point it at the right root — never a claim that it was removed for you.
      return d.removed === false
        ? `✗ registry entry "${d.space}" points at ${d.root}, whose auth is now for "${d.found}" - re-register it with \`cotal meshes add ${d.space} --server <url> --root <dir>\` (\`--force\` replaces), or \`cotal meshes rm ${d.space}\``
        : `✗ registry entry "${d.space}" points at ${d.root}, whose auth is now for "${d.found}" - stale entry removed; re-run \`cotal up\` or check \`cotal meshes\``;
    case "unreadable-auth":
      return `✗ space "${d.space}"'s trust material under ${d.root} will not load (${err.message}) - repair or remove the account record, then re-run \`cotal up\``;
    case "user-auth-unrecorded":
      // U11: without a TRUSTED local record of the space's IdP there is no actionable
      // `cotal login --idp <?>` line to print — the honest recovery is re-registering the mesh
      // where its user-auth state lives, and remote discovery is explicitly not supported yet.
      return `✗ space "${d.space}" requires user auth, but no trusted IdP config for it is registered on this machine - re-run \`cotal up --user-auth\` in ${d.root ?? "its broker root"} to re-register it (user-auth spaces are configured where their broker runs; remote discovery is not supported yet)`;
  }
}

/** "Is it live" failures on a registry-resolved target — the classified preflight sentence. */
function renderPreflightFailure(kind: PreflightFailure, t: MeshTarget, pruned: boolean): string {
  switch (kind) {
    case "unreachable":
      // An operator-registered mesh usually runs on ANOTHER machine, so `cotal up` is the wrong
      // remedy here — this machine can only wait for it or stop pointing at it.
      if (t.origin === "manual")
        return `✗ no broker answered at ${t.server} - "${t.space}" is registered here but its mesh is not up; start it where it runs, or \`cotal meshes rm ${t.space}\` to unregister it`;
      return `✗ no mesh running at ${t.server}${pruned ? " (stale registry entry - removed)" : ""} - run \`cotal up\``;
    // The registry-mismatch pair, like `unreachable`, must not prescribe `cotal up` for a mesh this
    // machine only registered: the repair there is the credentials under `--root`, or re-registering
    // the entry — `cotal up` would start a DIFFERENT, local mesh under that name.
    case "registry-creds-rejected":
      return t.origin === "manual"
        ? `✗ mesh "${t.space}" at ${t.server} rejected the credentials under ${t.root} - re-mint them where that mesh runs, or re-register it with \`cotal meshes add ${t.space} --server <url> --root <dir> --force\``
        : `✗ mesh "${t.space}" at ${t.server} no longer matches its registry entry (credentials rejected - port reused?) - re-run \`cotal up\` from ${t.root}, or \`cotal meshes\` to see what's live`;
    case "registry-open-now-auth":
      return t.origin === "manual"
        ? `✗ "${t.space}" is registered as an open mesh, but the broker at ${t.server} requires auth - copy that mesh's account + creds under ${t.root} and re-register with \`cotal meshes add ${t.space} --server ${t.server} --mode auth --force\``
        : `✗ open mesh "${t.space}" at ${t.server} no longer matches its registry entry (broker now requires auth - port reused?) - re-run \`cotal up\` from ${t.root}, or \`cotal meshes\` to see what's live`;
    case "creds-rejected":
      return `✗ credentials for "${t.space}" were rejected at ${t.server} - a different mesh may be running there. Run \`cotal meshes\` to check, or \`cotal up\` here to start yours`;
    case "open-wants-auth":
      return `✗ broker at ${t.server} requires auth, but this mesh is open (no trust material) - use \`--space <name>\` for an auth mesh, or run \`cotal up\` here without \`--open\``;
    case "stale-auth":
      return `✗ credentials for "${t.space}" have EXPIRED - this mesh enforces bounded credential lifetimes; run \`cotal doctor auth\` in ${t.root} for the diagnosis + exact repair (the mesh itself is up)`;
    case "tls-trust":
      // INFO advertised tls_required (shape evidence only — unauthenticated). Never claims removal
      // or peer identity; conservatively keep the record and point at the trust-store repair.
      return `✗ mesh "${t.space}" at ${t.server} requires TLS but this client could not complete the handshake (untrusted or missing CA?) - set \`NODE_EXTRA_CA_CERTS\` to the issuing CA for a private CA, or fix the trust store; a TLS-required NATS listener still greets there (INFO is unauthenticated — not mesh identity) so the registry entry was conservatively kept`;
  }
}

/** Plain reachability for a RAW (off-registry) probe — the `--creds` / `--server`+unregistered-`--space`
 *  escape hatch, which never touches the registry (no prune, no stale-entry wording). */
function renderReachable(reason: "auth-required" | "stale-auth" | "unreachable", server: string): string {
  if (reason === "stale-auth")
    return `✗ credential EXPIRED at ${server} - bounded lifetime reached (credential death); run \`cotal doctor auth\` where the mesh runs, or re-mint the credential`;
  return reason === "auth-required"
    ? `✗ credentials rejected at ${server} - check your creds, or the broker wants different auth`
    : `✗ can't reach a broker at ${server} - is it running? (\`cotal up\`)`;
}
