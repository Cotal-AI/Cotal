/** Typed surface of `_fixture-space.mjs` for `tsc -p tsconfig.smoke.json`. */
export interface FixtureSpaceManager {
  readonly instanceId: string;
  readonly pid: number;
  readonly state: string;
  readonly connectors: Array<{ readonly agent: string; readonly state: string; readonly reason?: string }>;
}

export interface FixtureSpace {
  readonly space: string;
  readonly participant: string;
  close(): Promise<void>;
  startManager(): Promise<FixtureSpaceManager>;
  call(args: readonly string[]): Promise<unknown>;
}

export function createFixtureSpace(options: {
  root: string;
  machineHome: string;
  runtime: string;
  node: string;
  env: NodeJS.ProcessEnv;
}): Promise<FixtureSpace>;
