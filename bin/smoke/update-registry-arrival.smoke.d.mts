export function registryArrivalCell(options: {
  scenario: "arrives" | "unavailable" | "integrity" | "reset" | "cache" | "orphan";
  entry?: string;
  parent?: string;
}): Promise<{
  scenario: string;
  code: number | null;
  elapsedMs: number;
  selected: string;
  missing: number;
  requests: { at: number; path: string }[];
  output: string;
}>;
