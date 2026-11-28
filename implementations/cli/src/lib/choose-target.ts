import type { ParsedArgs } from "@cotal-ai/core";
import { brokerAddressForDisplay, codeSpan, isWorkspaceTargetError, presentationOf, pruneStaleMeshes, resolveMeshTarget, type Presentation, type ResolveFlags } from "@cotal-ai/workspace";
import { canPrompt } from "../commands/meshes-wizard.js";
import { shellWord } from "./endpoint-errors.js";
import { displayCmd } from "./self-exec.js";

/** Inventory is machine-wide: carry only its output mode, never the refused target. */
export function spaceInventoryCommand(presentation: Presentation): string {
  return codeSpan(`cotal space${presentation === "rich" ? "" : ` --${presentation}`}`);
}

/** List spaces for an unknown explicit target, or offer each registered choice for an ambiguous one. */
export function spaceChoiceRemedy(error: unknown, command: string, args: ParsedArgs, rest: readonly string[]): string | undefined {
  if (!isWorkspaceTargetError(error)) return undefined;
  if (error.code === "unknown-space" && !error.details.selected && typeof args.values.space === "string" && args.values.space === error.details.requested)
    return `see ${spaceInventoryCommand(presentationOf(args.values))}`;
  if (error.code !== "ambiguous-target" || !error.details.spaces?.length) return undefined;
  const show = command === "space" && args.positionals[0] === "show";
  const remove = command === "endpoint" && args.positionals[0] === "remove";
  const describe = command === "describe" || command === "endpoint" && args.positionals[0] === "describe";
  const endpointRead = command === "endpoint" && ["list", "show"].includes(args.positionals[0] ?? "list");
  const brokerRead = error.details.server !== undefined && (command === "ps" || command === "whoami" ||
    command === "channel" && (args.positionals[0] ?? "list") === "list" ||
    command === "history" && !["clear", "limit"].includes(args.positionals[0] ?? ""));
  if (args.values.creds !== undefined && !endpointRead) return undefined;
  if (!show && !endpointRead && !remove && !describe && !brokerRead && command !== "who") return undefined;
  const server = args.values.server;
  if (server !== undefined && (show || typeof server !== "string" || brokerAddressForDisplay(server) !== server)) return undefined;
  const cli = displayCmd({ fromAnyFolder: true });
  const end = rest.indexOf("--");
  const flags = remove
    ? ["remove", args.positionals[1]!, ...(args.values.json ? ["--json"] : args.values.plain ? ["--plain"] : [])].map(shellWord)
    : (end === -1 ? rest : rest.slice(0, end)).map(shellWord);
  const words = show ? [cli, "space", "show"] : [cli, command, ...flags, "--space"];
  const suffix = show && args.values.json ? ["--json"] : show && args.values.plain ? ["--plain"]
    : (brokerRead || describe) && end !== -1 ? rest.slice(end).map(shellWord) : [];
  return `run ${error.details.spaces.map((space) => codeSpan([...words, shellWord(space), ...suffix].join(" "))).join(" or ")}`;
}

/**
 * With no `--space`, `--server` or `--creds`, a command that several running meshes could serve
 * asks a terminal which one. A selection resolves the target, so it is never ambiguous. The answer becomes this operation's `--space`, so
 * every later resolution in it reads the same name, and the selection is left as it is. A script,
 * a `--json` caller or `--no-input` is not asked, and the command refuses with `TARGET_AMBIGUOUS`.
 * Cancelling the question does nothing and exits 0.
 */
export async function chooseMeshTarget(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; server?: string; creds?: string; json?: boolean };
  if (values.space !== undefined || values.server !== undefined || values.creds !== undefined || values.json === true) return;
  if (!canPrompt()) return;
  // The registry alone first, so a target that resolves costs no broker probe; only an ambiguous one
  // is checked against the brokers that answer, as the command itself would check it.
  if (!targetChoices({})?.spaces) return;
  const { target, spaces, uncheckedCandidates } = targetChoices(await pruneStaleMeshes(undefined, "targets")) ?? {};
  if (target !== undefined) { values.space = target; return; }
  if (!spaces) return;
  const p = await import("./prompts.js");
  const chosen = await p.select({ message: uncheckedCandidates ? "Several spaces are recorded. Which one?" : "Several spaces are running. Which one?", options: spaces.map((space) => ({ value: space, label: space })) });
  if (p.isCancel(chosen)) {
    p.cancel("nothing was done - no space was chosen");
    process.exit(0);
  }
  values.space = chosen;
}

/** Choices from the registry, including a sole candidate resolved by inventory. */
function targetChoices(flags: ResolveFlags): { target?: string; spaces?: string[]; uncheckedCandidates?: boolean } | undefined {
  try {
    const target = resolveMeshTarget(process.cwd(), { ...flags, readOnly: true });
    return target.source === "registry" && flags.openInventory?.unserved.length ? { target: target.space } : undefined;
  } catch (e) {
    return isWorkspaceTargetError(e) && e.code === "ambiguous-target" ? e.details : undefined;
  }
}
