import { existsSync } from "node:fs";
import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import { boundedValue, clearCurrent, CommandFailure, findMesh, findPreparedSpace, folderSpaceOverSelection, getCurrent, jsonFlag, loadMeshes, loadPreparedSpaces, plainFlag, preparedLifecycle, presentationOf, readCurrent, setCurrent, SHOWN_VALUE_MAX, writeResult, type Cell, type OutputWarning, type PreparedSpace, type Report } from "@cotal-ai/workspace";

export const useFlags = [
  { name: "clear", type: "boolean", description: "clear the selection, so a command targets its folder's space again" },
  jsonFlag, plainFlag,
] as const satisfies readonly FlagSpec[];

interface Selection {
  readonly kind: "selection";
  /** The selected space after the command, or null when none is selected. */
  readonly current: string | null;
  /** The selection before the command. Equal to `current` for a bare read and for a no-op. */
  readonly previous: string | null;
  /** Whether `current` names a registration on this machine, as `cotal status --json` reports it. */
  readonly currentRecorded: boolean;
  readonly server: string | null;
  /** The root `cotal up` starts `current` in, when it names a space `cotal space create` prepared. */
  readonly preparedRoot: string | null;
  /** What that root's stack records, as `status` reports it: never started, stopped, or a last `up`
   *  or `down` with no recorded outcome. Null when `current` is not a prepared space. */
  readonly preparedState: "prepared" | "stopped" | "unsettled" | null;
  /** That last operation and how it ended, such as `cotal down, completed`, or null. */
  readonly lastOperation: string | null;
  /** This folder's space when a command without `--space` targets it here instead of `current`, or null. */
  readonly folder: string | null;
}

/**
 * `cotal use <space>` selects the space commands target when none is named, from any directory. It
 * changes the selection only: it starts nothing, and it does not check whether the space's broker
 * is up, so a stopped or prepared space can be selected and the command that targets it says so. Bare
 * `cotal use` reports the selection, and `--clear` removes it.
 */
export async function use(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof useFlags>;
  const presentation = presentationOf(values);
  if (args.positionals.length > 1) throw new CommandFailure("refused", "USAGE_INVALID", "usage: cotal use [<space> | --clear]");
  if (values.clear) return clearSelection(args.positionals.length > 0, presentation);
  const previous = getCurrent() ?? null;
  const name = args.positionals[0];
  if (name === undefined) {
    const m = previous === null ? undefined : findMesh(previous);
    const p = previous === null || m ? undefined : findPreparedSpace(previous);
    const result: Selection = { kind: "selection", current: previous, previous, currentRecorded: previous === null || m !== undefined, server: m?.server ?? null, ...prepared(p), folder: folderSpaceOverSelection(process.cwd(), previous) ?? null };
    const warnings: OutputWarning[] = previous !== null && !m && !p
      ? [{ code: "SELECTION_NOT_REGISTERED", target: { space: previous }, message: `the selected space "${previous}" is not registered here - select another with \`cotal use <name>\`` }]
      : [];
    writeResult(presentation, { command: "use", target: previous === null ? null : { space: previous }, result, warnings }, selectionView);
    return;
  }
  const m = findMesh(name);
  const p = m ? undefined : findPreparedSpace(name);
  if (!m && !p) {
    // No target, so the refusal is not headed with a space that does not exist. Clearing is a step only
    // while something is selected.
    const known = [...new Set([...loadMeshes().map((mesh) => mesh.space), ...loadPreparedSpaces().map((prepared) => prepared.space)])].sort();
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no space named "${boundedValue(name, SHOWN_VALUE_MAX)}" is registered or prepared here${known.length ? `; known spaces: ${known.join(", ")}` : ""}`, {
      remedy: `see the registered and prepared spaces with \`cotal space\`${previous === null ? "" : ", or clear the selection with `cotal use --clear`"}`,
    });
  }
  const changed = previous !== name;
  if (changed) setCurrent(name);
  const result: Selection = { kind: "selection", current: name, previous, currentRecorded: m !== undefined, server: m?.server ?? null, ...prepared(p), folder: folderSpaceOverSelection(process.cwd(), name) ?? null };
  writeResult(presentation, { command: "use", target: { space: name }, result, noOp: !changed }, selectionView);
}

/** The selection's fields for a prepared space `p`, or nulls without one. */
function prepared(p: PreparedSpace | undefined): Pick<Selection, "preparedRoot" | "preparedState" | "lastOperation"> {
  if (!p) return { preparedRoot: null, preparedState: null, lastOperation: null };
  const lifecycle = existsSync(p.root) ? preparedLifecycle(p.root, p.space) : undefined;
  return { preparedRoot: p.root, preparedState: lifecycle?.state ?? "prepared", lastOperation: lifecycle?.lastOperation ?? null };
}

/** `use --clear`: remove the selection, so a command runs on its folder's space again. A pointer that
 *  cannot be read is removed as well, since it selects nothing usable. Nothing selected is a no-op. */
function clearSelection(named: boolean, presentation: ReturnType<typeof presentationOf>): void {
  if (named) throw new CommandFailure("refused", "USAGE_INVALID", "--clear removes the selection, so it takes no space name", { remedy: "run `cotal use --clear`, or `cotal use <space>` to select another" });
  let previous: string | null, damaged = false;
  try { previous = readCurrent() ?? null; } catch { previous = null; damaged = true; }
  if (previous !== null || damaged) clearCurrent();
  const result: Selection = { kind: "selection", current: null, previous, currentRecorded: true, server: null, preparedRoot: null, preparedState: null, lastOperation: null, folder: null };
  writeResult(presentation, { command: "use", target: null, result, noOp: previous === null && !damaged }, (s) => ({ sections: [{ blocks: [{ kind: "lines", lines: [
    s.previous === null ? { text: damaged ? "cleared the selection" : "no space was selected; nothing changed", tone: damaged ? "ok" : "hint", ...(damaged ? { mark: "✓" } : {}) } : { text: `cleared the selection (was ${s.previous})`, tone: "ok", mark: "✓" },
    { text: "  a command now targets the space in its folder, or the one named with --space", tone: "hint" },
  ] }] }] }));
}

function selectionView(s: Selection): Report {
  if (s.current === null) return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: "no space is selected - select one with `cotal use <name>`; `cotal space` lists them", tone: "hint" }] }] }] };
  const head: Cell = s.current === s.previous
    ? { text: `selected: ${s.current}`, tone: "selected" }
    : { text: `selected ${s.current}${s.previous ? ` (was ${s.previous})` : ""}`, tone: "ok", mark: "✓" };
  const lines: Cell[] = [head];
  if (s.server) lines.push({ text: `  ${s.server}`, tone: "hint" });
  if (s.preparedRoot) lines.push(!existsSync(s.preparedRoot) ? { text: `  prepared in ${s.preparedRoot}, which no longer exists - forget it with \`cotal space forget ${s.current}\``, tone: "waiting" }
    : s.preparedState === "stopped" ? { text: `  stopped; its last operation, ${s.lastOperation} - start it again with \`cotal up\` in ${s.preparedRoot}`, tone: "hint" }
    : s.preparedState === "unsettled" ? { text: `  its last operation, ${s.lastOperation} - run \`cotal status\` in ${s.preparedRoot}, which names the step that finishes or settles it`, tone: "waiting" }
    : { text: `  prepared, not started - start it with \`cotal up\` in ${s.preparedRoot}`, tone: "hint" });
  if (s.folder) lines.push({ text: `  commands in this folder target its space "${s.folder}"; the selection applies outside it`, tone: "hint" });
  return { sections: [{ blocks: [{ kind: "lines", lines }] }] };
}

export function useComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: [...loadMeshes().map((m) => ({ value: m.space })), ...loadPreparedSpaces().map((p) => ({ value: p.space }))], directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
