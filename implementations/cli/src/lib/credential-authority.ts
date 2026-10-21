import {
  CommandFailure, authDir, canonicalRoot, findCotalRoot, getSoleSpaceAuth, getSpaceAuth,
  hasUserAuthState, isWorkspaceTargetError, resolveMeshTarget, targetErrorCode,
  workspaceSecretStore, type MeshTarget,
} from "@cotal-ai/workspace";

/** Offline resolution retains stale registrations instead of repairing the selected target. */
export function resolveMintTarget(values: { space?: string; server?: string }): MeshTarget {
  try { return resolveMeshTarget(process.cwd(), { ...values, readOnly: true }); }
  catch (error) { if (isWorkspaceTargetError(error)) throw new CommandFailure("refused", targetErrorCode(error.code), "the selected credential root could not be resolved; no other root was chosen"); throw error; }
}

/** Fixed profiles and endpoint callers share the same explicit local signing authority. */
export async function staticMintAuthority(values: { space?: string; server?: string }, reportTarget: Record<string, unknown>) {
  const target = resolveMintTarget(values), { root, space } = target;
  const currentRoot = findCotalRoot(), store = workspaceSecretStore(root);
  const auth = await getSpaceAuth(store, space);
  const currentAuth = canonicalRoot(currentRoot) === canonicalRoot(root) ? auth : await getSoleSpaceAuth(workspaceSecretStore(currentRoot), authDir(currentRoot));
  const selected = { ...reportTarget, space };
  if (currentAuth && (!auth || currentAuth.space !== space || currentAuth.account.pub !== auth.account.pub)) throw new CommandFailure("refused", "CONFLICT", "the selected root and current folder disagree about the signing authority; no credential was minted", { target: { ...selected, root, currentRoot }, remedy: `run auth mint from the intended authority root: the selected root ${root} or the current folder's root ${currentRoot}` });
  if (!auth) throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected root holds no validated static signing trust; no other root or cached login was substituted", { target: selected });
  if (target.mode !== "auth" || hasUserAuthState(root, space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "static credentials are not issued for open or per-user-auth spaces", { target: selected, remedy: "use the space's supported login/enrollment path instead of a static identity" });
  return { target, auth, currentRoot, store };
}
