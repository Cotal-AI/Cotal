import {
  CommandFailure, authDir, canonicalRoot, findCotalRoot, getSoleSpaceAuth, getSpaceAuth,
  hasUserAuthState, isWorkspaceTargetError, resolveMeshTarget, targetErrorCode,
  workspaceErrorParts, workspaceSecretStore, type MeshTarget,
} from "@cotal-ai/workspace";

/**
 * Offline resolution retains stale registrations instead of repairing the selected target.
 * `offlineRemedy` is the caller's other step when a mint that writes only the private file would
 * resolve the same target, as one for a stopped local space does.
 */
export function resolveMintTarget(values: { space?: string; server?: string }, allowStoppedLocal = false, offlineRemedy?: string): MeshTarget {
  try { return resolveMeshTarget(process.cwd(), { ...values, readOnly: true, allowStoppedLocal }); }
  catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "no-meshes")
      throw new CommandFailure("refused", targetErrorCode(error.code), "the selected credential root could not be resolved; no other root was chosen", { remedy: "start a local static-auth space with `cotal up` in its project folder and retry there, or use `--space <name>` to select a static-auth space with signing trust on this machine" });
    const { message, remedy } = workspaceErrorParts({ kind: "target", error });
    let offline = false;
    if (offlineRemedy !== undefined) {
      try { resolveMeshTarget(process.cwd(), { ...values, readOnly: true, allowStoppedLocal: true }); offline = true; }
      catch (other) { if (!isWorkspaceTargetError(other)) throw other; }
    }
    const next = offline ? (remedy === undefined ? offlineRemedy : `${remedy}, or ${offlineRemedy}`) : remedy;
    throw new CommandFailure("refused", targetErrorCode(error.code), `${message}; no other root was chosen`, next === undefined ? {} : { remedy: next });
  }
}

/** Fixed profiles and endpoint callers share the same explicit local signing authority. */
export async function staticMintAuthority(values: { space?: string; server?: string }, reportTarget: Record<string, unknown>, allowStoppedLocal = false, offlineRemedy?: string) {
  const target = resolveMintTarget(values, allowStoppedLocal, offlineRemedy), { root, space } = target;
  const currentRoot = findCotalRoot(), store = workspaceSecretStore(root);
  const auth = await getSpaceAuth(store, space);
  const currentAuth = canonicalRoot(currentRoot) === canonicalRoot(root) ? auth : await getSoleSpaceAuth(workspaceSecretStore(currentRoot), authDir(currentRoot));
  const selected = { ...reportTarget, space };
  if (currentAuth && (!auth || currentAuth.space !== space || currentAuth.account.pub !== auth.account.pub)) throw new CommandFailure("refused", "CONFLICT", "the selected root and current folder disagree about the signing authority; no credential was minted", { target: { ...selected, root, currentRoot }, remedy: `run auth mint from the intended authority root: the selected root ${root} or the current folder's root ${currentRoot}` });
  // An open registration, not one inferred from missing trust: such a space issues no credentials.
  if (target.mode === "open" && target.origin !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "this space is open: it authenticates no one and issues no credentials, so nothing was minted", { target: selected, remedy: "connect to it without credentials" });
  if (!auth) throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected root holds no validated static signing trust; no other root or cached login was substituted", { target: selected });
  if (target.mode !== "auth" || hasUserAuthState(root, space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "static credentials are not issued for open or per-user-auth spaces", { target: selected, remedy: "use the space's supported login/enrollment path instead of a static identity" });
  return { target, auth, currentRoot, store };
}
