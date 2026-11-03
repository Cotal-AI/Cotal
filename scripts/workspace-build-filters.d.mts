export function workspaceBuildSelection(
  tokens: readonly string[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): { packages: Set<string> | null; tokens: string[] };
