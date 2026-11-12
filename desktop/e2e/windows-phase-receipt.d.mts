/** Append diagnostic phase boundaries without changing the operation's result or rejection. */
export function windowsPhaseReceipt(output: string, enabled?: boolean): <T>(phase: string, operation: () => T | Promise<T>, observation?: (result: T) => object) => Promise<T>;
