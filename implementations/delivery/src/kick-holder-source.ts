import type { SecretStore } from "@cotal-ai/core";
import { readSystemSigningSeed as readSeed, type SystemSigningSeedRecord } from "@cotal-ai/workspace";

/** The retained system signing seed for the space this source names. */
export const readRetainedSystemSeed = (source: { secrets: SecretStore; space: string }): Promise<SystemSigningSeedRecord | undefined> =>
  readSeed(source.secrets, source.space);
