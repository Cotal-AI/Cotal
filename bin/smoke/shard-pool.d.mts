/** Public pool calls exercised by the shard sentinel smoke. */
export function runPool(commands: string[], options: {
  jobs: number;
  runMarker: string;
  indices: Map<string, number>;
  onStart: (command: string) => void;
}): Promise<{
  results: { cmd: string; status: number; out: string; cells: number; skipped?: string; stopped?: string; seconds: number }[];
  failure?: { cmd: string; reason: string; status: number };
  interrupted?: string;
}>;
export function poolSelection(planned: string[]): { commands: string[]; jobs: number };
