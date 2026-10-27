/**
 * The multi-space delivery host (`cotal deliver --spaces <manifest> --server <url>`): one process
 * holding one delivery lane per space named in a manifest file, so a host runs one delivery process
 * instead of one per space.
 *
 * A lane is the daemon `cotal deliver --space` runs, held by this host instead of owning the
 * process ({@link openDeliveryLane}). Each lane reads its own space's credential from the one root,
 * dials the one broker on its own connections, and holds its own lease, watchdog, timer writer and
 * membership feed. Lanes share the process and nothing else, so one space losing its broker
 * connection, its credential or its lease closes that lane and leaves the others serving.
 *
 * The manifest grammar and the reconcile lifecycle are `runSpaceHost` in `@cotal-ai/workspace`,
 * shared with the auth callout host.
 */
import type { ParsedArgs } from "@cotal-ai/core";
import { runSpaceHost } from "@cotal-ai/workspace";
import { daemonRoot, openDeliveryLane, type DeliveryLog } from "./delivery.js";

/** How long a signalled host waits for its lanes to release their leases before it exits anyway. A
 *  row left behind is the bucket TTL's to expire, as it is for a single-space daemon's 2s bound. */
const STOP_BOUND_MS = 10_000;

/** The flags of a single-space daemon. Each would be ignored or wrong for every other lane. */
const SINGLE_SPACE_FLAGS = ["creds", "dev-mint", "shard", "shards"] as const;

/** Refuse a `--spaces` run that is not one complete host invocation. Nothing is read or dialed yet. */
export function validateDeliveryHost(args: ParsedArgs): { manifest: string; server: string } {
  const v = args.values as Record<string, string | undefined>;
  const manifest = v.spaces;
  if (manifest === undefined) throw new Error("deliver: --spaces <manifest> is required for the delivery host");
  if (args.positionals.length)
    throw new Error(`deliver --spaces runs the delivery host and takes no ${JSON.stringify(args.positionals[0])}; \`deliver pending\` reads one space with --space`);
  if (v.space !== undefined)
    throw new Error("deliver: --space and --spaces are alternatives - name one space or a manifest of spaces, not both");
  const single = SINGLE_SPACE_FLAGS.filter((flag) => v[flag] !== undefined);
  if (single.length)
    throw new Error(`deliver: ${single.map((f) => `--${f}`).join(" and ")} belong${single.length === 1 ? "s" : ""} to a single-space daemon and cannot be combined with --spaces; every lane reads its own space's credential from the root and runs one shard`);
  if (manifest.trim() === "") throw new Error("deliver: --spaces needs the path of a space manifest");
  const server = v.server;
  if (!server) throw new Error("deliver: --spaces requires --server <url>; every lane of one host dials that one broker");
  return { manifest, server };
}

/** A lane's lines, prefixed with its space so one host's stderr stays readable. */
function laneLog(space: string): DeliveryLog {
  return { out: (line) => console.log(`[${space}] ${line}`), err: (line) => console.error(`[${space}] ${line}`) };
}

/** Run one multi-space delivery host until a signal ends it. Every space in the manifest must open
 *  at startup: one that cannot is a configuration error naming the space, and no lane is left
 *  running. */
export async function runDeliveryHost(args: ParsedArgs): Promise<void> {
  const { manifest, server } = validateDeliveryHost(args);
  const v = args.values as Record<string, string | undefined>;
  // One root for every lane, chosen once: `--root`, or the nearest `.cotal/` above the working directory.
  const root = daemonRoot(v);
  const tls = v.tls !== undefined;
  const host = await runSpaceHost({
    manifest,
    open: (space) => openDeliveryLane({ space, server, root, rootNamed: v.root !== undefined, tls, log: laneLog(space) }),
    label: "delivery host",
    entry: "deliver --spaces",
    serving: "serving",
    onStop: (signal) => {
      console.error(`• delivery host: received ${signal}, closing every lane`);
      setTimeout(() => {
        console.error(`! delivery host: lanes still closing after ${STOP_BOUND_MS / 1000}s - exiting; a lease left behind expires with its bucket TTL`);
        process.exit(0);
      }, STOP_BOUND_MS).unref();
    },
  });
  console.log(`✓ delivery host up (${host.lanes.size} space(s): ${[...host.lanes.keys()].join(", ")}) - one delivery lane per space on ${server}${tls ? " with TLS required" : ""}`);
  process.exit(await host.ended);
}
