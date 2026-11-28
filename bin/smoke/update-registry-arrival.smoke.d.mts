export function registryArrivalCell(options: {
  scenario: "arrives" | "unavailable" | "integrity" | "reset" | "cache" | "archive-interrupted" | "closure-killed" | "closure-nospace" | "orphan" | "pending" | "reconcile-killed" | "reconcile-orphan" | "reconcile-orphan-sigkill" | "pty-install-hangup" | "pty-reconcile-hangup" | "pty-real-child-hangup" | "closed-scope" | "min-release-age" | "before" | "offline-metadata" | "offline-archive" | "offline-closure" | "offline-staging" | "staging-refused" | "staging-killed" | "concurrent" | "extension-peers" | "extension-arrives" | "extension-unavailable" | "config-access-upgrade" | "config-access-auto" | "selection-upgrade" | "selection-rollback" | "version-named-node";
  entry?: string;
  parent?: string;
}): Promise<{
  scenario: string;
  skipped?: string;
  code: number | null;
  elapsedMs: number;
  selected: string;
  missing: number;
  requests: { at: number; path: string }[];
  output: string;
}>;
