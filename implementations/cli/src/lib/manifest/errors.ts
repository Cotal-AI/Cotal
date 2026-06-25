/**
 * Located manifest errors. Every validation failure carries the offending file, the YAML path,
 * and (where the node is locatable) a line/column — so the CLI prints `cotal.yaml:12:5: …` instead
 * of a stack trace. All problems found in one pass are collected and thrown together.
 */
export interface ManifestIssue {
  message: string;
  /** YAML path to the offending node, e.g. ["channels", "review", "allowPublish"]. */
  path?: (string | number)[];
  line?: number;
  col?: number;
}

/** Render one issue as `file:line:col: message (at a.b.c)`. */
export function formatIssue(file: string, i: ManifestIssue): string {
  const loc = i.line ? `${file}:${i.line}${i.col ? `:${i.col}` : ""}` : file;
  const at = i.path?.length ? ` (at ${i.path.join(".")})` : "";
  return `${loc}: ${i.message}${at}`;
}

/** One or more located problems in a manifest. The message lists each on its own line. */
export class ManifestError extends Error {
  readonly file: string;
  readonly issues: ManifestIssue[];
  constructor(file: string, issues: ManifestIssue[]) {
    const body = issues.map((i) => `  • ${formatIssue(file, i)}`).join("\n");
    super(`${issues.length} problem(s) in ${file}:\n${body}`);
    this.name = "ManifestError";
    this.file = file;
    this.issues = issues;
  }
}
