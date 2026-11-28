import { dirname, isAbsolute } from "node:path";

export type ObserveWrite = (error: unknown, directory: string) => void;

/** For operations spanning multiple records, prefer the failed syscall's destination. */
export function writeDirectory(error: unknown, fallback: string): string {
  for (let e = error, depth = 0; e && typeof e === "object" && depth < 2; depth++) {
    const { dest, path, cause } = e as { dest?: unknown; path?: unknown; cause?: unknown };
    const target = dest ?? path;
    if (typeof target === "string" && isAbsolute(target)) return dirname(target);
    e = cause;
  }
  return fallback;
}

export function observeWrite<T>(observe: ObserveWrite | undefined, directory: string, write: () => T): T {
  try { return write(); }
  catch (error) { observe?.(error, directory); throw error; }
}

export async function observeAsyncWrite<T>(observe: ObserveWrite | undefined, directory: string, write: () => Promise<T>): Promise<T> {
  try { return await write(); }
  catch (error) { observe?.(error, writeDirectory(error, directory)); throw error; }
}
