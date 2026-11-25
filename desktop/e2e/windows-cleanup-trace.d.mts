export interface CleanupTraceOptions {
  home: string;
  receipt: string;
  output: string;
  taskQuery?: (unit: string, options: { signal: AbortSignal }) => unknown | Promise<unknown>;
}
export interface CleanupTrace {
  checkpoint(phase: string): Promise<object>;
  stop(): Promise<object>;
}
/** Passive diagnostics only. Output is a JSONL file path. */
export function startCleanupTrace(options: CleanupTraceOptions): Promise<CleanupTrace>;
