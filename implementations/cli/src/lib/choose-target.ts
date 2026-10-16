import type { ParsedArgs } from "@cotal-ai/core";
import { getCurrent, isWorkspaceTargetError, pruneStaleMeshes, resolveMeshTarget } from "@cotal-ai/workspace";
import { canPrompt } from "../commands/meshes-wizard.js";

/**
 * With no `--space`, `--server` or `--creds` and no selection, a command that several running
 * meshes could serve asks a terminal which one. The answer becomes this operation's `--space`, so
 * every later resolution in it reads the same name, and the selection is left as it is. A script,
 * a `--json` caller or `--no-input` is not asked, and the command refuses with `TARGET_AMBIGUOUS`.
 * Cancelling the question does nothing and exits 0.
 */
export async function chooseMeshTarget(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; server?: string; creds?: string; json?: boolean };
  if (values.space !== undefined || values.server !== undefined || values.creds !== undefined || values.json === true) return;
  if (!canPrompt() || getCurrent() !== undefined) return;
  // The registry alone first, so a target that resolves costs no broker probe; only an ambiguous one
  // is checked against the brokers that answer, as the command itself would check it.
  if (!runningChoices([])) return;
  const spaces = runningChoices((await pruneStaleMeshes()).offline);
  if (!spaces) return;
  const p = await import("@clack/prompts");
  const chosen = await p.select({ message: "Several spaces are running. Which one?", options: spaces.map((space) => ({ value: space, label: space })) });
  if (p.isCancel(chosen)) {
    p.cancel("nothing was done - no space was chosen");
    process.exit(0);
  }
  values.space = chosen;
}

/** The running spaces a resolution could not choose between, or undefined when it resolves or fails
 *  for another reason, which the command's own resolution reports. */
function runningChoices(offline: string[]): string[] | undefined {
  try {
    resolveMeshTarget(process.cwd(), { offline });
    return undefined;
  } catch (e) {
    return isWorkspaceTargetError(e) && e.code === "ambiguous-target" ? e.details.spaces : undefined;
  }
}
