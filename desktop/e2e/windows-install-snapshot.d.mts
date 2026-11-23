export interface WindowsInstallSnapshotOptions {
  stage: string;
  /** Exact installation receipt file, not a directory. */
  receipt: string;
  /** Append-only JSONL output file. */
  output: string;
  /** Actual CLI daemon status JSON supplied by the caller. No status call is made here. */
  status: unknown;
  validation?: unknown;
  refusal?: { message?: string; next?: string };
  /** Read-only exact root task query. Unknown/failed observations must not imply absence. */
  taskQuery?: (unit: string, options: { signal: AbortSignal }) => unknown | Promise<unknown>;
}
export function captureWindowsInstallSnapshot(options: WindowsInstallSnapshotOptions): Promise<Record<string, unknown>>;
