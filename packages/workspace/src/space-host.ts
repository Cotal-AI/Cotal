/**
 * One process holding one lane per space named in a manifest file. The auth callout host
 * (`cotal auth-service --callout-only --spaces <manifest>`) and the delivery host
 * (`cotal deliver --spaces <manifest>`) both run on this, so the manifest grammar and the lane
 * lifecycle are one piece of code for every multi-space daemon.
 *
 * A lane is whatever the caller opens for one space. The host shares nothing between lanes but the
 * process: a lane that ends leaves the map and the others keep serving.
 *
 * One reconcile function is the whole lifecycle: it diffs the manifest against the live lanes and
 * opens or closes the difference. It runs when the manifest changes on disk, on `SIGHUP`, when a
 * lane is lost, after a short fixed wait when a lane failed to open, and on a slow backstop
 * interval. A manifest that does not read or parse whole leaves the live lanes alone.
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";

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

/** One space's lane, as a host holds it. */
export interface SpaceLane {
  readonly space: string;
  /** Settles with what this lane lost once it stops serving, by {@link close} or by a loss. It never
   *  rejects: a holder distinguishes the two by whether it asked for the close. */
  readonly lost: Promise<string>;
  /** Stop serving and release everything the lane holds. Safe to call more than once. */
  close(): Promise<void>;
}

/** What a multi-space daemon supplies to {@link runSpaceHost}. */
export interface SpaceHostOptions {
  /** Path of the manifest file. */
  manifest: string;
  /** Open one space's lane, or throw naming why the space cannot be served. */
  open(space: string): Promise<SpaceLane>;
  /** Names the host in its log lines, such as `auth callout host`. */
  label: string;
  /** Names the command in a startup refusal, such as `auth-service --callout-only --spaces`. */
  entry: string;
  /** What a lane does while it is up, for the loss line: `answering`, `serving`. */
  serving: string;
  /** Called once when SIGINT or SIGTERM starts the stop, before any lane closes. */
  onStop?: (signal: NodeJS.Signals) => void;
  /** Diagnostics sink. Default `console.error`. */
  log?: (line: string) => void;
}

/** A started host. `ended` resolves with the exit code once a signal has closed every lane. */
export interface SpaceHost {
  readonly lanes: ReadonlyMap<string, SpaceLane>;
  readonly ended: Promise<number>;
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
export function readSpaceManifest(path: string): SpaceManifest {
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

/** Open a lane for every space in the manifest, then keep the live lanes equal to the manifest until
 *  a signal stops the host. Every space must open at startup: one that cannot is a configuration
 *  error naming the space, and no lane is left running. Returns once startup has succeeded; the
 *  caller prints its ready line and exits with `ended`. */
export async function runSpaceHost(options: SpaceHostOptions): Promise<SpaceHost> {
  const { label } = options;
  const manifestPath = resolve(options.manifest);
  const log = options.log ?? ((l: string) => console.error(l));
  const lanes = new Map<string, SpaceLane>();
  let stopping = false;

  /** Watch one lane for a loss. A lane the host deliberately removed is no longer the map's lane for
   *  its space, so its settled `lost` is ignored rather than read as a failure to recover from. */
  const watchLane = (lane: SpaceLane): void => {
    void lane.lost.then((what) => {
      if (stopping || lanes.get(lane.space) !== lane) return;
      lanes.delete(lane.space);
      log(`✗ ${label}: space "${lane.space}" lost ${what} - that lane stopped ${options.serving}; ${lanes.size} lane(s) still up`);
      schedule(0);
    });
  };

  const open = async (space: string): Promise<SpaceLane> => {
    const lane = await options.open(space);
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
          wanted = readSpaceManifest(manifestPath);
        } catch (e) {
          log(`✗ ${label}: ${e instanceof Error ? e.message : String(e)} - keeping the ${lanes.size} lane(s) already open`);
          return;
        }
        const want = new Set(wanted.spaces);
        for (const [space, lane] of [...lanes]) {
          if (want.has(space) || stopping) continue;
          // Out of the map before the close, so this lane's `lost` reads as the removal it is.
          lanes.delete(space);
          await lane.close().catch(() => {});
          log(`${label}: space "${space}" left the manifest - closed its lane; ${lanes.size} lane(s) up`);
        }
        let failed = false;
        for (const space of wanted.spaces) {
          if (lanes.has(space) || stopping) continue;
          try {
            await open(space);
            log(`${label}: space "${space}" opened - ${lanes.size} lane(s) up`);
          } catch (e) {
            failed = true;
            log(`✗ ${label}: space "${space}" could not be served (${e instanceof Error ? e.message : String(e)}) - retrying in ${REOPEN_WAIT_SECONDS}s`);
          }
        }
        if (failed) schedule(REOPEN_WAIT_SECONDS);
      } while (pending && !stopping);
    } finally {
      reconciling = false;
    }
  };

  // ---- startup: every space or none -------------------------------------------------------------
  const initial = readSpaceManifest(manifestPath);
  for (const space of initial.spaces) {
    try {
      await open(space);
    } catch (e) {
      await Promise.all([...lanes.values()].map((lane) => lane.close().catch(() => {})));
      lanes.clear();
      throw new Error(`${options.entry}: space "${space}" could not be served (${e instanceof Error ? e.message : String(e)}) - no lane was left running`);
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
    await Promise.all([...lanes.values()].map((lane) => lane.close().catch(() => {})));
    lanes.clear();
    throw new Error(`${options.entry}: cannot watch ${dirname(manifestPath)} for manifest changes (${e instanceof Error ? e.message : String(e)})`);
  }
  const backstop = setInterval(() => schedule(0), BACKSTOP_INTERVAL_SECONDS * 1000);
  backstop.unref();

  const ended = new Promise<number>((resolve_) => {
    const stop = (signal: NodeJS.Signals) => () => {
      if (stopping) return;
      stopping = true;
      options.onStop?.(signal);
      if (retry !== undefined) clearTimeout(retry);
      if (debounce !== undefined) clearTimeout(debounce);
      clearInterval(backstop);
      watcher?.close();
      // Every lane closes at once: one lane waiting on a slow broker must not hold the others open.
      void Promise.all([...lanes.values()].map((lane) => lane.close().catch(() => {}))).then(() => {
        lanes.clear();
        resolve_(0);
      });
    };
    process.on("SIGINT", stop("SIGINT"));
    process.on("SIGTERM", stop("SIGTERM"));
    process.on("SIGHUP", () => schedule(0));
  });
  return { lanes, ended };
}
