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
 * One reconcile function is the whole lifecycle: it diffs the manifest against the live lanes and
 * opens or closes the difference. It runs when the manifest changes on disk, on `SIGHUP`, when a
 * lane is lost, after a short fixed wait when a lane failed to open, and on a slow backstop
 * interval. A manifest that does not read or parse whole leaves the live lanes alone.
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { SecretStore } from "@cotal-ai/core";
import { workspaceSecretStore } from "@cotal-ai/workspace";
import { openCalloutLane, type CalloutLane } from "./callout-lane.js";
import type { AuthCalloutLimits } from "./callout.js";

/** How long after a lane fails to open the host tries it again. One fixed wait, never a growing
 *  backoff, and the log line that reports the failure names it. */
const REOPEN_WAIT_SECONDS = 5;

/** The backstop reconcile. A lost lane and a changed manifest each reconcile at once, so this only
 *  catches a change no watch reported. */
const BACKSTOP_INTERVAL_SECONDS = 60;

/** The manifest naming the spaces one host serves. Entries are space names: every lane of a host
 *  dials the one `--server`, so a deployment whose spaces live on different brokers runs one host
 *  process per broker. */
export interface SpaceManifest {
  version: 1;
  spaces: string[];
}

/** Parse a space manifest. Throws with what is wrong: the caller keeps its live lanes rather than
 *  acting on a file it could not read whole. */
export function parseSpaceManifest(text: string): SpaceManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`not whole or not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("the manifest must be a JSON object");
  const keys = Object.keys(doc);
  const unknown = keys.filter((k) => k !== "version" && k !== "spaces");
  if (unknown.length) throw new Error(`unknown field(s) ${unknown.join(", ")}; the manifest takes version and spaces`);
  const { version, spaces } = doc as { version?: unknown; spaces?: unknown };
  if (version !== 1) throw new Error(`version must be 1, got ${JSON.stringify(version)}`);
  if (!Array.isArray(spaces)) throw new Error("spaces must be an array of space names");
  if (spaces.length === 0) throw new Error("spaces is empty; a host serves at least one space");
  for (const entry of spaces) {
    if (typeof entry !== "string")
      throw new Error(`every entry of spaces must be a space name string, got ${JSON.stringify(entry)}; one host serves one broker, so run one host per broker rather than naming a server per space`);
    if (entry.trim() === "") throw new Error("a space name is empty");
  }
  const seen = new Set<string>();
  for (const entry of spaces as string[]) {
    if (seen.has(entry)) throw new Error(`space ${JSON.stringify(entry)} is named more than once`);
    seen.add(entry);
  }
  return { version: 1, spaces: spaces as string[] };
}

/** Read and parse the manifest at `path`. The error names the path, so a host log line is legible
 *  without the operator correlating it. */
function readManifest(path: string): SpaceManifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`${path} could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    return parseSpaceManifest(text);
  } catch (e) {
    throw new Error(`${path} is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Run one multi-space callout host until a signal ends it. Every space in the manifest must open at
 *  startup: one that cannot is a configuration error naming the space, not a host serving the rest. */
export async function runCalloutHost(args: { manifest: string; server: string; root: string; limits?: AuthCalloutLimits }, store?: SecretStore): Promise<void> {
  const { server, root } = args;
  const manifestPath = resolve(args.manifest);
  const log = (l: string) => console.error(l);
  const secrets = store ?? workspaceSecretStore(root);
  const laneOptions = { server, root, secrets, log, ...(args.limits !== undefined ? { limits: args.limits } : {}) };
  const lanes = new Map<string, CalloutLane>();
  let stopping = false;

  /** Watch one lane for a loss. A lane the host deliberately removed is no longer the map's lane for
   *  its space, so its settled `lost` is ignored rather than read as a failure to recover from. */
  const watchLane = (lane: CalloutLane): void => {
    void lane.lost.then((what) => {
      if (stopping || lanes.get(lane.space) !== lane) return;
      lanes.delete(lane.space);
      log(`✗ auth callout host: space "${lane.space}" lost ${what} - that lane stopped answering; ${lanes.size} lane(s) still up`);
      schedule(0);
    });
  };

  const open = async (space: string): Promise<CalloutLane> => {
    const lane = await openCalloutLane({ ...laneOptions, space });
    lanes.set(space, lane);
    watchLane(lane);
    return lane;
  };

  // ---- reconcile: the one path that adds and removes a lane -------------------------------------
  let reconciling = false;
  let pending = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const schedule = (seconds: number): void => {
    if (stopping) return;
    if (seconds === 0) {
      void reconcile();
      return;
    }
    if (retry !== undefined) return;
    retry = setTimeout(() => { retry = undefined; void reconcile(); }, seconds * 1000);
    retry.unref();
  };

  const reconcile = async (): Promise<void> => {
    if (stopping) return;
    // One reconcile at a time: a second trigger during a slow open coalesces into one more pass.
    if (reconciling) { pending = true; return; }
    reconciling = true;
    try {
      do {
        pending = false;
        let wanted: SpaceManifest;
        try {
          wanted = readManifest(manifestPath);
        } catch (e) {
          log(`✗ auth callout host: ${e instanceof Error ? e.message : String(e)} - keeping the ${lanes.size} lane(s) already open`);
          return;
        }
        const want = new Set(wanted.spaces);
        for (const [space, lane] of [...lanes]) {
          if (want.has(space) || stopping) continue;
          // Out of the map before the close, so this lane's `lost` reads as the removal it is.
          lanes.delete(space);
          await lane.close().catch(() => {});
          log(`auth callout host: space "${space}" left the manifest - closed its lane; ${lanes.size} lane(s) up`);
        }
        let failed = false;
        for (const space of wanted.spaces) {
          if (lanes.has(space) || stopping) continue;
          try {
            await open(space);
            log(`auth callout host: space "${space}" opened - ${lanes.size} lane(s) up`);
          } catch (e) {
            failed = true;
            log(`✗ auth callout host: space "${space}" could not be served (${e instanceof Error ? e.message : String(e)}) - retrying in ${REOPEN_WAIT_SECONDS}s`);
          }
        }
        if (failed) schedule(REOPEN_WAIT_SECONDS);
      } while (pending && !stopping);
    } finally {
      reconciling = false;
    }
  };

  // ---- startup: every space or none -------------------------------------------------------------
  const initial = readManifest(manifestPath);
  for (const space of initial.spaces) {
    try {
      await open(space);
    } catch (e) {
      for (const lane of [...lanes.values()]) await lane.close().catch(() => {});
      lanes.clear();
      throw new Error(`auth-service --callout-only --spaces: space "${space}" could not be served (${e instanceof Error ? e.message : String(e)}) - no lane was left running`);
    }
  }

  // ---- triggers ---------------------------------------------------------------------------------
  // The manifest's DIRECTORY is watched, not the file: a provisioning backend that writes a new
  // manifest and renames it into place replaces the inode, which a watch on the file alone stops
  // reporting after the first change.
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const name = basename(manifestPath);
  try {
    watcher = watch(dirname(manifestPath), (_event, changed) => {
      if (changed !== null && changed !== name) return;
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = undefined; schedule(0); }, 100);
      debounce.unref();
    });
  } catch (e) {
    throw new Error(`auth-service --callout-only --spaces: cannot watch ${dirname(manifestPath)} for manifest changes (${e instanceof Error ? e.message : String(e)})`);
  }
  const backstop = setInterval(() => schedule(0), BACKSTOP_INTERVAL_SECONDS * 1000);
  backstop.unref();

  const ended = new Promise<number>((resolve_) => {
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (retry !== undefined) clearTimeout(retry);
      if (debounce !== undefined) clearTimeout(debounce);
      clearInterval(backstop);
      watcher?.close();
      void (async () => {
        for (const lane of [...lanes.values()]) await lane.close().catch(() => {});
        lanes.clear();
        resolve_(0);
      })();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", () => schedule(0));
  });
  console.log(`✓ auth callout host up (${lanes.size} space(s): ${[...lanes.keys()].join(", ")}) - answering the callout on ${server}${args.limits?.authTimeoutMs !== undefined ? ` with a ${args.limits.authTimeoutMs / 1000}s authorization timeout` : ""}; no HTTP listener, no auth-service.json`);
  process.exit(await ended);
}
