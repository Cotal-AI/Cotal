export class SuiteMetadataError extends Error {
  readonly diagnosis: string;
}

export function parseSuiteSources(
  root: string,
  configPath: string,
  value: unknown,
  options?: { checkExists?: boolean },
): string[];
