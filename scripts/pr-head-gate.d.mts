export interface WorkflowRun {
  id?: number;
  name?: string;
  event?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  created_at?: string;
  pull_requests?: Array<{ number?: number }>;
}

export interface HeadVerdict {
  expected: string[];
  missing: string[];
  pending: string[];
  failing: string[];
  green: boolean;
}

export function expectedPullRequestWorkflows(
  workflows: Record<string, string>,
  changedPaths: string[],
): string[];

export function classifyPullRequestHead(input: {
  pr: number;
  headSha: string;
  expected: string[];
  runs: WorkflowRun[];
}): HeadVerdict;
