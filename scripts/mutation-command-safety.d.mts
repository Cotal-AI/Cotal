import type { existsSync, readFileSync } from "node:fs";

export const INFRASTRUCTURE_MARKERS: readonly [
  "REAL Manager",
  "REAL agent processes",
  "REAL pty children",
  "REAL broker",
];

export function smokeTokens(command: string): string[];
export function isLiveNamedToken(token: string): boolean;
export function infrastructureMarkerIn(source: string): string | undefined;

export function liveShapedCommandReason(
  command: string,
  options?: {
    cwd?: string;
    readFile?: typeof readFileSync;
    exists?: typeof existsSync;
  },
): string | null;

export function liveShapedFixtureReason(
  fixture: {
    command?: string;
    mutations?: { command?: string }[];
  },
  options?: {
    cwd?: string;
    readFile?: typeof readFileSync;
    exists?: typeof existsSync;
  },
): string | null;
