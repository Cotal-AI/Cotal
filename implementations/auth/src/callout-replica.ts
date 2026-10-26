/**
 * The callout-only replica (`cotal auth-service --callout-only --space <s>`): one more member of the
 * space's `cotal-auth-callout` queue group, for availability and horizontal scale. It answers
 * connects with the same hooks as the full auth service ({@link calloutAuthority}) and holds nothing
 * else: no HTTP listener, no `auth-service.json`, no plane claim, no service registration, scanners,
 * barrier, evictor, pruning or sweeps.
 *
 * This entry is one {@link openCalloutLane} plus the process around it: the signal handlers and the
 * non-zero exit on a loss, so the broker routes every later callout to the other members.
 * `--spaces` runs the same lane for several spaces in one process ({@link runCalloutHost}).
 */
import type { SecretStore } from "@cotal-ai/core";
import { workspaceSecretStore } from "@cotal-ai/workspace";
import { openCalloutLane } from "./callout-lane.js";
import type { AuthCalloutLimits } from "./callout.js";

/** Run one callout replica for `space` until a signal or a lost connection ends it. `limits` are the
 *  full service's: the broker's timeout is one value for every member of the queue group. */
export async function runAuthCalloutReplica(args: { space: string; server: string; root: string; limits?: AuthCalloutLimits }, store?: SecretStore): Promise<void> {
  const { space, server, root } = args;
  const log = (l: string) => console.error(l);
  const lane = await openCalloutLane({ space, server, root, secrets: store ?? workspaceSecretStore(root), log, ...(args.limits !== undefined ? { limits: args.limits } : {}) });

  const ended = new Promise<number>((resolve) => {
    let stopping = false;
    void lane.lost.then((what) => {
      if (stopping) return;
      stopping = true;
      log(`✗ auth-service --callout-only: lost ${what} - stopped answering the callout; exiting`);
      resolve(1);
    });
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void lane.close().then(() => resolve(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  console.log(`✓ auth callout replica up (space ${space}) - answering the callout on ${server}${args.limits?.authTimeoutMs !== undefined ? ` with a ${args.limits.authTimeoutMs / 1000}s authorization timeout` : ""}; no HTTP listener, no auth-service.json`);
  process.exit(await ended);
}
