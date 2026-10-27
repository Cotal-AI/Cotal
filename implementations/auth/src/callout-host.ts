/**
 * The multi-space callout host (`cotal auth-service --callout-only --spaces <manifest>`): one
 * process holding one {@link CalloutLane} per space named in a manifest file, so a host runs one
 * callout process instead of one per space. Every per-space refusal, limit and log line a
 * single-space replica applies still applies per lane, because a lane is the same code.
 *
 * Lanes share the process and share nothing else. Each holds its own connections, its own connect
 * limits and its own signing material, so one space's key never signs another's response and one
 * space losing its store connection leaves the others answering.
 *
 * The manifest grammar and the reconcile lifecycle are `runSpaceHost` in `@cotal-ai/workspace`,
 * shared with the delivery host.
 */
import type { SecretStore } from "@cotal-ai/core";
import { runSpaceHost, workspaceSecretStore } from "@cotal-ai/workspace";
import { openCalloutLane } from "./callout-lane.js";
import type { AuthCalloutLimits } from "./callout.js";

export { parseSpaceManifest, type SpaceManifest } from "@cotal-ai/workspace";

/** Run one multi-space callout host until a signal ends it. Every space in the manifest must open at
 *  startup: one that cannot is a configuration error naming the space, not a host serving the rest. */
export async function runCalloutHost(args: { manifest: string; server: string; root: string; limits?: AuthCalloutLimits }, store?: SecretStore): Promise<void> {
  const { server, root } = args;
  const log = (l: string) => console.error(l);
  const secrets = store ?? workspaceSecretStore(root);
  const laneOptions = { server, root, secrets, log, ...(args.limits !== undefined ? { limits: args.limits } : {}) };
  const host = await runSpaceHost({
    manifest: args.manifest,
    open: (space) => openCalloutLane({ ...laneOptions, space }),
    label: "auth callout host",
    entry: "auth-service --callout-only --spaces",
    serving: "answering",
    log,
  });
  console.log(`✓ auth callout host up (${host.lanes.size} space(s): ${[...host.lanes.keys()].join(", ")}) - answering the callout on ${server}${args.limits?.authTimeoutMs !== undefined ? ` with a ${args.limits.authTimeoutMs / 1000}s authorization timeout` : ""}; no HTTP listener, no auth-service.json`);
  process.exit(await host.ended);
}
