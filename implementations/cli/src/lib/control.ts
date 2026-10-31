import { assertLifecycleToken, type ControlReply, type FlagSpec } from "@cotal-ai/core";
import { c, CommandFailure, staleStoreHint, stderrLine } from "@cotal-ai/workspace";
import type { ControlClient } from "@cotal-ai/workspace/control";
import { compareSemver } from "../seed/reconcile.js";
import { cliVersion } from "./version.js";

/** What this CLI hands every manager control call: its own release, for a refusal of an argument the
 *  manager's contract does not declare, and the roster read that names your managers. */
export const cliControl: ControlClient = {
  // This CLI built the args for a manager of its own release, and the two release in lockstep, so a
  // key the manager's contract does not declare means the manager runs a different release. The
  // version the manager reports says which side is older, and so which one to update.
  versionSkew(detail, undeclared, managerVersion) {
    const cli = cliVersion();
    const skew = `${detail}. That is version skew: this CLI runs Cotal ${cli} and sends "${undeclared}", which the manager's contract does not declare.`;
    const order = managerVersion === undefined ? undefined : compareSemver(cli, managerVersion);
    if (order === undefined) return `${skew} The manager did not report its version. Run the manager at Cotal ${cli}, or use a CLI at the manager's version`;
    if (order > 0) return `${skew} The manager runs Cotal ${managerVersion}, so it is the older side: on its host run \`cotal update --self\`, then \`cotal manager restart\`, or use a CLI at Cotal ${managerVersion}`;
    if (order < 0) return `${skew} The manager runs Cotal ${managerVersion}, so this CLI is the older side: update it with \`cotal update --self\``;
    return `${skew} The manager also reports Cotal ${cli}, so one side is another build of that version, such as a source checkout: rebuild or reinstall that side`;
  },
  // Loaded on use: a static import of manager-choice here closes an import cycle through
  // stack-journal, which then evaluates a module before the constants it reads.
  roster: async (flags) => (await import("./manager-choice.js")).rosterOf(flags),
};

/** `--on <instance>`: address ONE manager instance instead of the class queue. Shared by
 *  ps/stop/attach/input/describe/models so they cannot drift. For stop and attach it is the seat-locality
 *  escape hatch: the manager that can act on a seat is the one HOSTING it, which is not necessarily
 *  the one that wins the class queue. On a user-auth mesh it also takes a manager's name or host
 *  ({@link managerPin}). */
export const onFlag = { name: "on", type: "string", value: "<instance>", description: "ask only this manager, by the instance id `ps` prints or, on a user-auth mesh, by its name or host" } as const satisfies FlagSpec;

/** Read `--on` at the site that declares it. Absent stays absent (class rails). An EMPTY value
 *  (`--on=`, `--on ""`, or `--on "$INSTANCE"` with the variable unset) is refused here, up front:
 *  it is falsy, so every `if (on)` branch would treat it as absent and drop the pin (a `stop` would
 *  fall through to seat locality, an open-mesh `ps` to the scatter), while the mint and core's
 *  route builder treat it as PRESENT and refuse it as an invalid token. Two answers for one input;
 *  a dropped pin is a silent fallback, so neither branch gets to see it. A roster principal id
 *  (`local.…`) is refused here too, naming the identifier `--on` wants (#423). Any other value is an
 *  instance id, name or host, which {@link managerPin} resolves to an instance id before use. */
export function onInstance(on: string | undefined, verb: string): string | undefined {
  if (on === undefined) return undefined;
  if (on === "")
    throw new CommandFailure("refused", "USAGE_INVALID", `--on requires a manager instance id (the whole id, as \`cotal ps\` prints it), or on a user-auth mesh a manager's name or host: \`${verb} --on <instance>\`. An empty value is refused, not dropped`, { selfContained: true });
  if (on.startsWith("local."))
    throw new CommandFailure("refused", "USAGE_INVALID", `"${on}" is a principal id. --on wants the manager INSTANCE id as \`cotal ps\` prints it (the \`instance\` it lists for a manager that answered, or the \`manager <id>\` header when several did), not the roster's principal id (\`local.U…\`, as \`cotal endpoints\` shows it): \`${verb} --on <instance>\``, { selfContained: true });
  return on;
}

/** {@link onInstance} for an `--on` that takes only an instance id: an endpoint's instance, or a
 *  step that runs before the mesh can be read. The value is shape-checked against core's
 *  lifecycle-token grammar, so a malformed id is refused naming the identifier `--on` wants. */
export function onInstanceId(on: string | undefined, verb: string): string | undefined {
  const value = onInstance(on, verb);
  if (value === undefined) return undefined;
  try {
    assertLifecycleToken(value, "instanceId");
  } catch (e) {
    throw new CommandFailure("refused", "USAGE_INVALID", `${(e as Error).message}. --on wants the INSTANCE id as \`cotal ps\` prints it (the \`instance\` it lists for a manager that answered, or the \`manager <id>\` header when several did): \`${verb} --on <instance>\``, { selfContained: true });
  }
  return value;
}

export function failIfNotOk(reply: ControlReply): void {
  if (!reply.ok) {
    const msg = reply.error ?? "error";
    stderrLine("✗ ", msg, c.red);
    // A manager-side stale-store durable collision (e.g. `spawn --detach` into a store minted by
    // an older Cotal generation) names its reset - the reply error stays verbatim.
    const hint = staleStoreHint(msg);
    if (hint) stderrLine("  ↳ ", hint, c.dim);
    process.exit(1);
  }
}
