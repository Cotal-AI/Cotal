export const INFRASTRUCTURE_MARKERS: readonly [
  "REAL Manager",
  "REAL agent processes",
  "REAL pty children",
  "REAL broker",
];

export function smokeTokens(command: string): string[];
export function isLiveNamedToken(token: string): boolean;
export function infrastructureMarkerIn(source: string): string | undefined;

export interface LiveCommandSafetyOptions {
  cwd?: string;
  readFile?: (path: string, encoding?: string) => string;
  exists?: (path: string) => boolean;
}

export function liveShapedCommandReason(
  command: string,
  options?: LiveCommandSafetyOptions,
): string | null;

export function liveShapedFixtureReason(
  fixture: {
    command?: string;
    mutations?: { command?: string }[];
  },
  options?: LiveCommandSafetyOptions,
): string | null;
