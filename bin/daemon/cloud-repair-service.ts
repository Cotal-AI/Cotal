/** The service's own repair door: Cloud's requests run this service's Repair, through its own
 *  endpoint, as the app's Repair does. */
import { appMutationBusy } from "./agent-app-admission.js";
import { createCloudRepair, type CloudRepair } from "./cloud-repair.js";
import type { DaemonPaths } from "./endpoint.js";
import { applyRepair, planRepair } from "./repair.js";

/** What the door reads from the account computer: space ids and the names that must stay here. */
interface AccountNames { spaceId(slug: string): string | undefined; privateNames(): string[] }

export function serviceCloudRepair(options: { readonly paths: DaemonPaths; readonly daemonHome: string | undefined; readonly version: string }, log: (line: string) => void, account: () => AccountNames): CloudRepair {
  return createCloudRepair({
    plan: () => planRepair(options),
    apply: async (digest, consent) => {
      let failure: unknown;
      const result = await applyRepair({ ...options, digest, consent, onFailure: error => { failure = error; } });
      return { result, failure };
    },
    busy: () => appMutationBusy(options.paths),
  }, { log, spaceId: slug => account().spaceId(slug), secrets: () => account().privateNames() });
}
