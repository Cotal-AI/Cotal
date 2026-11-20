export function registryArrivalCell(options: {
  scenario: "arrives" | "unavailable" | "integrity" | "reset" | "cache" | "archive-interrupted" | "closure-killed" | "closure-nospace" | "orphan" | "pending" | "reconcile-killed" | "closed-scope" | "min-release-age" | "before" | "offline-metadata" | "offline-archive" | "offline-closure" | "offline-staging" | "staging-killed" | "concurrent" | "extension-peers";
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
