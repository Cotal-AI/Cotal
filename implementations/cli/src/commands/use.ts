import { existsSync } from "node:fs";
import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, findMesh, findPreparedSpace, getCurrent, jsonFlag, loadMeshes, loadPreparedSpaces, plainFlag, presentationOf, setCurrent, writeResult, type Cell, type OutputWarning, type Report } from "@cotal-ai/workspace";

export const useFlags = [jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

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
}

/**
 * `cotal use <space>` selects the space commands target when none is named, from any directory. It
 * changes the selection only: it starts nothing, and it does not check whether the space's broker
 * is up, so a stopped or prepared space can be selected and the command that targets it says so. Bare
 * `cotal use` reports the selection.
 */
export async function use(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values as FlagValues<typeof useFlags>);
  if (args.positionals.length > 1) throw new CommandFailure("refused", "USAGE_INVALID", "usage: cotal use [<space>]");
  const previous = getCurrent() ?? null;
  const name = args.positionals[0];
  if (name === undefined) {
    const m = previous === null ? undefined : findMesh(previous);
    const p = previous === null || m ? undefined : findPreparedSpace(previous);
    const result: Selection = { kind: "selection", current: previous, previous, currentRecorded: previous === null || m !== undefined, server: m?.server ?? null, preparedRoot: p?.root ?? null };
    const warnings: OutputWarning[] = previous !== null && !m && !p
      ? [{ code: "SELECTION_NOT_REGISTERED", target: { space: previous }, message: `the selected space "${previous}" is not registered here - select another with \`cotal use <name>\`` }]
      : [];
    writeResult(presentation, { command: "use", target: previous === null ? null : { space: previous }, result, warnings }, selectionView);
    return;
  }
  const m = findMesh(name);
  const p = m ? undefined : findPreparedSpace(name);
  if (!m && !p) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no space named "${name}" is registered here`, { remedy: "see the registered spaces with `cotal space`" });
  const changed = previous !== name;
  if (changed) setCurrent(name);
  const result: Selection = { kind: "selection", current: name, previous, currentRecorded: m !== undefined, server: m?.server ?? null, preparedRoot: p?.root ?? null };
  writeResult(presentation, { command: "use", target: { space: name }, result, noOp: !changed }, selectionView);
}

function selectionView(s: Selection): Report {
  if (s.current === null) return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: "no space is selected - select one with `cotal use <name>`; `cotal space` lists them", tone: "hint" }] }] }] };
  const head: Cell = s.current === s.previous
    ? { text: `selected: ${s.current}`, tone: "selected" }
    : { text: `selected ${s.current}${s.previous ? ` (was ${s.previous})` : ""}`, tone: "ok", mark: "✓" };
  const lines: Cell[] = [head];
  if (s.server) lines.push({ text: `  ${s.server}`, tone: "hint" });
  if (s.preparedRoot) lines.push(existsSync(s.preparedRoot)
    ? { text: `  prepared, not started - start it with \`cotal up\` in ${s.preparedRoot}`, tone: "hint" }
    : { text: `  prepared in ${s.preparedRoot}, which no longer exists - forget it with \`cotal space forget ${s.current}\``, tone: "waiting" });
  return { sections: [{ blocks: [{ kind: "lines", lines }] }] };
}

export function useComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: [...loadMeshes().map((m) => ({ value: m.space })), ...loadPreparedSpaces().map((p) => ({ value: p.space }))], directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
