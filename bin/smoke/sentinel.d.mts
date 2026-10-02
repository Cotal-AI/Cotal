/** Typed surface of `sentinel.mjs` for `tsc -p tsconfig.smoke.json`. */
export const SENTINEL_PREFIX: "COTAL_SMOKE_SENTINEL";

export function formatSentinel(counts: { passed: number; failed: number; cells?: number }): string;
export function emitSentinel(counts: { passed: number; failed: number; cells?: number }): void;

export type ParsedSentinel = {
  cells: number;
  passed: number;
  failed: number;
  kind: "canonical" | "legacy";
};

export function parseSentinel(text: string): ParsedSentinel | null;
export function countedAssert<T extends object>(ns: T): { assert: T; cells: () => number };
export function createSuite(): {
  check: (name: string, cond: boolean, extra?: unknown) => void;
  finish: () => void;
  passed: () => number;
  failed: () => number;
};
