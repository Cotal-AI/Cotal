export function registryArrivalCell(options: {
  scenario: "arrives" | "unavailable" | "integrity" | "reset" | "cache" | "archive-interrupted" | "closure-killed" | "closure-nospace" | "orphan" | "pending" | "reconcile-killed" | "closed-scope" | "min-release-age" | "before" | "offline-metadata" | "offline-archive" | "offline-closure" | "offline-staging" | "staging-refused" | "staging-killed" | "concurrent" | "extension-peers" | "extension-arrives" | "extension-unavailable" | "config-access-upgrade" | "config-access-auto" | "selection-upgrade" | "selection-rollback" | "version-named-node";
  entry?: string;
  parent?: string;
}): Promise<{
  scenario: string;
  code: number | null;
  elapsedMs: number;
  selected: string;
  missing: number;
  requests: { at: number; path: string }[];
  output: string;
}>;
