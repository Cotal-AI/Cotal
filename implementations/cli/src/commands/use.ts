import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import { boundedValue, canonicalRoot, clearCurrent, codeSpan, CommandFailure, cotalDirLink, findCotalRoot, findMesh, findPreparedSpace, folderSpace, folderSpaceHeld, getCurrent, isMeshRegistryError, readCurrentSelection, jsonFlag, loadMeshes, loadPreparedSpaces, plainFlag, preparedLifecycle, preparedRootRemedy, presentationOf, projectRootDisplaced, projectRootProblem, projectRootProblemText, readCurrent, setCurrent, SHOWN_VALUE_MAX, stackElsewhereRemedy, stoppedStack, writeResult, type Cell, type MeshEntry, type OutputWarning, type PreparedSpace, type ProjectRootProblem, type Report } from "@cotal-ai/workspace";
import { localDiagnostic } from "../telemetry.js";
import { registryFailure } from "../lib/registry-errors.js";
import { displayRemedy } from "../lib/self-exec.js";
import { journalRecordedElsewhere } from "../lib/stack-journal.js";

export const useFlags = [
  { name: "clear", type: "boolean", description: "clear the selection, so a command targets its folder's space again" },
  jsonFlag, plainFlag,
] as const satisfies readonly FlagSpec[];

export function validateUseArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals[0] !== undefined && !args.positionals[0].trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "space name cannot be empty", { remedy: "name a space with `cotal use <space>`, or omit the name to show the selection" });
}

interface Selection {
  readonly kind: "selection";
  /** The selected space after the command, or null when none is selected. */
  readonly current: string | null;
  /** The selection before the command. Equal to `current` for a bare read and for a no-op. */
  readonly previous: string | null;
  /** Whether `current` names a registration on this machine, as `cotal status --json` reports it. */
  readonly currentRecorded: boolean;
  readonly server: string | null;
  /** The root `cotal up` starts `current` in, when the space is prepared or recorded as stopped. */
  readonly preparedRoot: string | null;
  /** What that root's stack records, as `status` reports it: never started, stopped, or a last `up`
   *  or `down` with no recorded outcome. Null when there is no lifecycle state to report. */
  readonly preparedState: "prepared" | "stopped" | "unsettled" | null;
  /** That last operation and how it ended, such as `` `cotal down`, completed ``, or null. */
  readonly lastOperation: string | null;
  /** The space recorded for this folder, or null. It does not override explicit selection. */
  readonly folder: string | null;
}

/**
 * `cotal use <space>` selects the space commands target when none is named, from any directory. It
 * changes the selection only: it starts nothing, and it does not check whether the space's broker
 * is up, so a stopped or prepared space can be selected and the command that targets it says so. Bare
 * `cotal use` reports the selection, and `--clear` removes it.
 */
export async function use(args: ParsedArgs): Promise<void> {
  validateUseArguments(args);
  const values = args.values as FlagValues<typeof useFlags>;
  const presentation = presentationOf(values);
  if (args.positionals.length > 1) throw new CommandFailure("refused", "USAGE_INVALID", "usage: cotal use [<space> | --clear]");
  if (values.clear) return clearSelection(args.positionals.length > 0, presentation);
  const name = args.positionals[0];
  let previous: string | null;
  try { previous = (name === undefined ? readCurrent() : getCurrent()) ?? null; }
  catch (error) { throw isMeshRegistryError(error) ? registryFailure(error) : error; }
  const current = name ?? previous;
  const m = current === null ? undefined : findMesh(current);
  const p = current === null || m ? undefined : findPreparedSpace(current);
  if (name !== undefined && !m && !p) {
    // No target, so the refusal is not headed with a space that does not exist. Clearing is a step only
    // while something is selected.
    const known = [...new Set([...loadMeshes().map((mesh) => mesh.space), ...loadPreparedSpaces().map((prepared) => prepared.space)])].sort();
    throw localDiagnostic(new CommandFailure("refused", "TARGET_NOT_FOUND", `no space named "${boundedValue(name, SHOWN_VALUE_MAX)}" is registered or prepared here${known.length ? `; known spaces: ${known.join(", ")}` : ""}`, {
      remedy: `see the registered and prepared spaces with \`cotal space\`${previous === null ? "" : ", or clear the selection with `cotal use --clear`"}`,
    }));
  }
  const changed = name !== undefined && (previous !== name || readCurrentSelection()?.source !== "explicit");
  const cwd = process.cwd(), project = canonicalRoot(findCotalRoot(cwd));
  const problem = p === undefined ? undefined : projectRootProblem(p.root);
  let moved: ReturnType<typeof journalRecordedElsewhere>;
  if (p && projectRootDisplaced(problem) && cotalDirLink(project) === undefined) {
    try {
      const found = journalRecordedElsewhere(project);
      if (found?.recordedRoot === p.root && found.journal.space === p.space) moved = found;
    } catch { /* An unusable journal does not identify a moved project. */ }
  }
  const result: Selection = { kind: "selection", current, previous, currentRecorded: current === null || m !== undefined, server: m?.server ?? null, ...prepared(p, m, problem, moved && project), folder: folderSpace(cwd) ?? folderSpaceHeld(cwd)?.space ?? null };
  if (changed) setCurrent(name);
  const warnings: OutputWarning[] = current !== null && name === undefined && !m && !p
    ? [{ code: "SELECTION_NOT_REGISTERED", target: { space: current }, message: `the selected space "${current}" is not registered here - select another with \`cotal use <name>\`` }]
    : [];
  writeResult(presentation, { command: "use", target: current === null ? null : { space: current }, result, noOp: name !== undefined && !changed, warnings }, (s) => selectionView(s, project, moved, problem));
}

/** The selection's local lifecycle fields, without a broker probe. */
function prepared(p: PreparedSpace | undefined, m: MeshEntry | undefined, problem: ProjectRootProblem | undefined, moved?: string): Pick<Selection, "preparedRoot" | "preparedState" | "lastOperation"> {
  if (m?.stoppedByDown === true && m.origin !== "manual" && m.origin !== "catalog")
    return { preparedRoot: m.root, preparedState: "stopped", lastOperation: "`cotal down`, completed" };
  if (!p) return { preparedRoot: null, preparedState: null, lastOperation: null };
  const lifecycle = moved !== undefined ? preparedLifecycle(moved, p.space) : problem === undefined ? preparedLifecycle(p.root, p.space) : undefined;
  return { preparedRoot: p.root, preparedState: lifecycle?.state ?? "prepared", lastOperation: lifecycle?.lastOperation ?? null };
}

/** `use --clear`: remove the selection, so a command runs on its folder's space again. A pointer that
 *  cannot be read is removed as well, since it selects nothing usable. Nothing selected is a no-op. */
function clearSelection(named: boolean, presentation: ReturnType<typeof presentationOf>): void {
  if (named) throw new CommandFailure("refused", "USAGE_INVALID", "--clear removes the selection, so it takes no space name", { remedy: "run `cotal use --clear`, or `cotal use <space>` to select another" });
  let previous: string | null, damaged = false;
  try { previous = readCurrent() ?? null; } catch { previous = null; damaged = true; }
  if (previous !== null || damaged) clearCurrent();
  let folder: string | null = null;
  const warnings: OutputWarning[] = [];
  try {
    const cwd = process.cwd();
    folder = folderSpace(cwd) ?? folderSpaceHeld(cwd)?.space ?? null;
  } catch (error) {
    const failure = isMeshRegistryError(error) ? registryFailure(error) : undefined;
    warnings.push({ code: failure?.code ?? "OPERATION_FAILED", target: failure?.target ?? null,
      message: `Could not determine this folder's space${failure ? `: ${failure.message}${failure.remedy ? `. To fix it, ${failure.remedy}` : ""}` : ""}.` });
  }
  const result: Selection = { kind: "selection", current: null, previous, currentRecorded: true, server: null, preparedRoot: null, preparedState: null, lastOperation: null, folder };
  writeResult(presentation, { command: "use", target: null, result, noOp: previous === null && !damaged, completeness: warnings.length ? "partial" : "complete", warnings }, (s) => ({ sections: [{ blocks: [{ kind: "lines", lines: [
    s.previous === null ? { text: damaged ? "cleared the selection" : "no space was selected; nothing changed", tone: damaged ? "ok" : "hint", ...(damaged ? { mark: "✓" } : {}) } : { text: `cleared the selection (was ${s.previous})`, tone: "ok", mark: "✓" },
    { text: "  a command now targets the space in its folder, or the one named with --space", tone: "hint" },
  ] }] }] }));
}

function selectionView(s: Selection, project: string, moved: ReturnType<typeof journalRecordedElsewhere>, preparedProblem: ProjectRootProblem | undefined): Report {
  if (s.current === null) return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: loadMeshes().length === 0 && loadPreparedSpaces().length === 0
    ? "no spaces are known here - sign in to Cotal Cloud with `cotal login`"
    : "no space is selected - select one with `cotal use <name>`; `cotal space` lists them", tone: "hint" }] }] }] };
  const head: Cell = s.current === s.previous
    ? { text: `selected: ${s.current}`, tone: "selected" }
    : { text: `selected ${s.current}${s.previous ? ` (was ${s.previous})` : ""}`, tone: "ok", mark: "✓" };
  const lines: Cell[] = [head];
  if (s.server) lines.push({ text: `  ${s.server}`, tone: "hint" });
  const problem = s.currentRecorded && s.preparedRoot ? projectRootProblem(s.preparedRoot) : preparedProblem;
  if (moved) {
    if (problem === "not-directory") lines.push(`  ${moved.recordedRoot} ${projectRootProblemText(problem)}`);
    if (s.lastOperation) lines.push({ text: `  ${s.preparedState === "stopped" ? "stopped; its last operation" : "its last operation"}, ${s.lastOperation}`, tone: "waiting" });
    lines.push(
      { text: `  this folder holds the stack journal of "${s.current}" and was moved from ${moved.recordedRoot}`, tone: "waiting" },
      { text: `  ${displayRemedy(stackElsewhereRemedy(project, moved.recordedRoot, moved.journal.space, moved.journal.members, moved.journal.operation))}`, tone: "hint" });
  } else if (s.preparedRoot) lines.push(problem !== undefined ? { text: `  ${s.currentRecorded ? "recorded" : "prepared"} in ${s.preparedRoot}, which ${projectRootProblemText(problem)} - ${displayRemedy(preparedRootRemedy(s.current, problem))}`, tone: "waiting" }
    : s.preparedState === "stopped" ? { text: `  stopped; its last operation, ${s.lastOperation} - start it again with ${codeSpan(stoppedStack(s.preparedRoot, s.current)?.noManager ? "cotal up --no-manager" : "cotal up")} in ${s.preparedRoot}`, tone: "hint" }
    : s.preparedState === "unsettled" ? { text: `  its last operation, ${s.lastOperation} - run \`cotal status\` in ${s.preparedRoot}, which names the step that finishes or settles it`, tone: "waiting" }
    : { text: `  prepared, not started - start it with \`cotal up\` in ${s.preparedRoot}`, tone: "hint" });
  // `use` reads no broker, so it says when this folder's space is the target rather than whether it is.
  if (s.folder && s.folder !== s.current) lines.push({ text: readCurrentSelection()?.source === "adopted"
    ? `  commands here target this folder's space "${s.folder}" while it runs; use --space ${s.current} to reach the adopted selection`
    : `  commands here target "${s.current}"; reach this folder's space with --space ${s.folder} or \`cotal use --clear\``, tone: "hint" });
  if (readCurrentSelection()?.source === "adopted") lines.push({ text: "  Cotal adopted this selection automatically; another folder's running space takes precedence", tone: "hint" });
  return { sections: [{ blocks: [{ kind: "lines", lines }] }] };
}

export function useComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: [...loadMeshes().map((m) => ({ value: m.space })), ...loadPreparedSpaces().map((p) => ({ value: p.space }))], directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
