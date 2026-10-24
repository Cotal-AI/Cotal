import { findMesh } from "./mesh-registry.js";
import { CommandFailure } from "./output.js";

/** The root of this machine's own stack for `space`: the registration a `cotal up` here made, not
 *  one added for a space that runs elsewhere. Undefined when there is none or the registry cannot be
 *  read. */
export function localStackRoot(space: string): string | undefined {
  let entry: ReturnType<typeof findMesh>;
  try { entry = findMesh(space); } catch { return undefined; }
  return entry && entry.origin !== "manual" && entry.origin !== "catalog" ? entry.root : undefined;
}

/** Whether a missing chat stream means the space's streams were removed. `cotal up` creates the
 *  streams of every space it starts, and an auth or user space has them from its broker's setup. An
 *  open space that runs elsewhere creates them on first use, so there a missing stream says nothing. */
export function spaceStreamsExpected(space: string, mode: "open" | "auth" | "user" | undefined): boolean {
  return mode === "auth" || mode === "user" || localStackRoot(space) !== undefined;
}

/**
 * The refusal for a space whose streams are not on its broker. A live `cotal space delete` leaves
 * the space so, and until they are created again a read finds nothing and a send finds no stream to
 * store it. A bare `cotal up` in the stack's root creates them when the stack's other members are
 * stopped, and changes nothing while they run. `stack` says which applies, and `root` is the stack's
 * root on this machine ({@link localStackRoot}). With either unknown, the remedy names both steps.
 */
export function spaceStreamsAbsent(space: string, root: string | undefined, stack?: "running" | "stopped"): CommandFailure {
  const where = root ? `in ${root}` : "where this space's stack runs";
  const message = stack === "running"
    ? `the streams of ${space} are not on its broker while its stack runs, so the space was deleted under it; nothing can be read or stored until they are created again`
    : `the streams of ${space} are not on its broker; a space delete removes them, and nothing can be read or stored until they are created again`;
  const remedy = stack === "running"
    ? `stop the stack with cotal down --yes ${where}, then run cotal up there to create them again, empty`
    : stack === "stopped"
      ? `run cotal up ${where} to create them again, empty`
      : `run cotal up ${where} to create them again, empty; while its stack runs, stop it first with cotal down --yes`;
  return new CommandFailure("refused", "TARGET_UNAVAILABLE", message, { target: { space }, remedy });
}
