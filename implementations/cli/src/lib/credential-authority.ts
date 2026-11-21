import {
  CommandFailure, authDir, canonicalRoot, codeSpan, findCotalRoot, findMesh, getSoleSpaceAuth, getSpaceAuth,
  hasUserAuthState, isWorkspaceTargetError, preparedLifecycle, preparedNeverStarted, preparedSpaceAt,
  resolveMeshTarget, retainedLegacyBroker, stackRunsUnderOtherHome, targetErrorCode,
  workspaceErrorParts, workspaceSecretStore, type MeshTarget, type MeshTargetErrorDetails,
} from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";
import { readStackJournal } from "./stack-journal.js";

function preparedMintRemedy(root: string, server?: string): string {
  const elsewhere = canonicalRoot(findCotalRoot()) !== canonicalRoot(root);
  const port = /^nats:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/i.exec(server ?? "")?.[1];
  // An arbitrary dial address may not be usable by a first local up, or may contain secrets.
  const broker = server !== undefined && server === server.trim() && port !== undefined && Number(port) <= 65535
    ? ` --server ${shellWord(server)}` : "";
  const command = `cotal up${broker}${elsewhere ? ` --root ${shellWord(root)}` : ""}`;
  return `start it with ${codeSpan(command)} to create the local static signing trust`;
}

function unsupportedStaticMint(target: object): CommandFailure {
  return new CommandFailure("refused", "UNSUPPORTED", "static credentials are not issued for open or per-user-auth spaces", {
    target, remedy: "use the space's supported login/enrollment path instead of a static identity",
  });
}

/** Use the resolver's target, never the auth mode of an unrelated folder or broker. */
function stoppedUserSpace(details: MeshTargetErrorDetails): string | undefined {
  const { root, stackSpace, home, recordedRoot, rootMissing, unsettled } = details;
  if (root === undefined || home !== undefined || recordedRoot !== undefined || rootMissing || unsettled !== undefined) return undefined;
  if (details.lastRun) {
    return stackSpace !== undefined && retainedLegacyBroker(root)?.open === false && hasUserAuthState(root, stackSpace, { readOnly: true }) ? stackSpace : undefined;
  }

  const { space } = details;
  if (space === undefined || details.stopped === undefined) return undefined;
  const journal = readStackJournal(root)?.journal;
  if (journal?.space !== space || journal.mode !== "user" || journal.operation.kind !== "down" || journal.operation.phase !== "completed") return undefined;
  // The named space pins the auth mode. A dial override and a historical recovery home do not.
  return stackRunsUnderOtherHome(root, journal) ? undefined : space;
}

/**
 * Offline resolution retains stale registrations instead of repairing the selected target.
 * `offlineRemedy` is the caller's other step when a mint that writes only the private file would
 * resolve the same target, as one for a stopped local space does.
 */
export function resolveMintTarget(values: { space?: string; server?: string }, options: {
  allowStoppedLocal?: boolean; offlineRemedy?: string; reportTarget?: Record<string, unknown>;
} = {}): MeshTarget {
  const { allowStoppedLocal, offlineRemedy, reportTarget } = options;
  try { return resolveMeshTarget(process.cwd(), { ...values, readOnly: true, allowStoppedLocal }); }
  catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "user-auth-unrecorded") throw unsupportedStaticMint({ ...reportTarget, space: error.details.space });
    if (error.code === "not-started") {
      const space = stoppedUserSpace(error.details);
      if (space !== undefined) throw unsupportedStaticMint({ ...reportTarget, space });
    }
    if (error.code === "no-meshes")
      throw new CommandFailure("refused", targetErrorCode(error.code), "the selected credential root could not be resolved; no other root was chosen", { remedy: "start a local static-auth space with `cotal up` in its project folder and retry there, or use `--space <name>` to select a static-auth space with signing trust on this machine" });
    const rendered = workspaceErrorParts({ kind: "target", error });
    const remedy = error.code === "not-started" && preparedNeverStarted(error.details)
      ? preparedMintRemedy(error.details.root, values.server) : rendered.remedy;
    let offline = false;
    if (offlineRemedy !== undefined) {
      try { resolveMeshTarget(process.cwd(), { ...values, readOnly: true, allowStoppedLocal: true }); offline = true; }
      catch (other) { if (!isWorkspaceTargetError(other)) throw other; }
    }
    const next = offline ? (remedy === undefined ? offlineRemedy : `${remedy}, or ${offlineRemedy}`) : remedy;
    throw new CommandFailure("refused", targetErrorCode(error.code), `${rendered.message}; no other root was chosen`, next === undefined ? {} : { remedy: next });
  }
}

/** Fixed profiles and endpoint callers share the same explicit local signing authority. */
export async function staticMintAuthority(values: { space?: string; server?: string }, reportTarget: Record<string, unknown>, allowStoppedLocal = false, offlineRemedy?: string) {
  const target = resolveMintTarget(values, { allowStoppedLocal, offlineRemedy, reportTarget }), { root, space } = target;
  const currentRoot = findCotalRoot(), store = workspaceSecretStore(root);
  const auth = await getSpaceAuth(store, space);
  const currentAuth = canonicalRoot(currentRoot) === canonicalRoot(root) ? auth : await getSoleSpaceAuth(workspaceSecretStore(currentRoot), authDir(currentRoot));
  const selected = { ...reportTarget, space };
  if (currentAuth && (!auth || currentAuth.space !== space || currentAuth.account.pub !== auth.account.pub)) throw new CommandFailure("refused", "CONFLICT", "the selected root and current folder disagree about the signing authority; no credential was minted", { target: { ...selected, root, currentRoot }, remedy: `run auth mint from the intended authority root: the selected root ${root} or the current folder's root ${currentRoot}` });
  // An open registration, not one inferred from missing trust: such a space issues no credentials.
  if (target.mode === "open" && target.origin !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "this space is open: it authenticates no one and issues no credentials, so nothing was minted", { target: selected, remedy: "connect to it without credentials" });
  if (!auth) {
    const prepared = target.source === "flag-server" && target.origin === undefined && preparedSpaceAt(root)?.space === space &&
      !findMesh(space) && preparedLifecycle(root, space).state === "prepared";
    throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected root holds no validated static signing trust; no other root or cached login was substituted", {
      target: selected, ...(prepared ? { remedy: preparedMintRemedy(root, values.server) } : {}),
    });
  }
  if (target.mode !== "auth" || hasUserAuthState(root, space, { readOnly: true })) throw unsupportedStaticMint(selected);
  return { target, auth, currentRoot, store };
}
