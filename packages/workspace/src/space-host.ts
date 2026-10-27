/**
 * One process holding one lane per space named in a manifest file. The auth callout host
 * (`cotal auth-service --callout-only --spaces <manifest>`), the auth service host
 * (`cotal auth-service --spaces <manifest>`) and the delivery host (`cotal deliver --spaces
 * <manifest>`) all run on this, so the manifest grammar and the lane lifecycle are one piece of code
 * for every multi-space daemon.
 *
 * A lane is whatever the caller opens for one space. The host shares nothing between lanes but the
 * process: a lane that ends leaves the map and the others keep serving.
 *
 * One reconcile function is the whole lifecycle: it diffs the manifest against the live lanes and
 * opens or closes the difference. It runs when the manifest changes on disk, on `SIGHUP`, when a
 * lane is lost, after a short fixed wait when a lane failed to open, and on a slow backstop
 * interval. A manifest that does not read or parse whole leaves the live lanes alone.
 *
 * Once a pass has closed every lane its manifest does not name, the host writes
 * `<manifest>.applied` naming the SHA-256 of the manifest bytes that pass read. A writer that
 * removes a space waits for that record to know the space has no lane left in this process.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
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

/** A version 2 manifest: one object per space, `{ "space": "<s>", ...settings }`, read by a host
 *  whose lanes take per-space settings. */
export interface SpaceSettingsManifest<S> {
  version: 2;
  spaces: string[];
  settings: ReadonlyMap<string, S>;
}

/** How a host reads the per-space settings of a version 2 manifest. */
export interface SpaceSettings<S> {
  /** Parse one entry's fields other than `space`, or throw naming what is wrong. Return a JSON
   *  value built in a fixed key order: the host compares two parses as JSON to tell whether a live
   *  lane's settings changed. */
  parse(space: string, fields: Readonly<Record<string, unknown>>): S;
  /** Refuse entries that conflict with each other, such as two spaces naming one port. */
  across?(settings: ReadonlyMap<string, S>): void;
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
export interface SpaceHostOptions<S = undefined> {
  /** Path of the manifest file. */
  manifest: string;
  /** Present for a host whose lanes take per-space settings: it reads version 2 manifests only.
   *  Absent, the host reads version 1 only, so neither kind of host runs on the other's file. */
  settings?: SpaceSettings<S>;
  /** Open one space's lane, or throw naming why the space cannot be served. */
  open(space: string, settings: S): Promise<SpaceLane>;
  /** `every` (the default) refuses to start unless every space opens, and leaves no lane running.
   *  `servable` starts with the spaces that open, reports each one that does not, and retries it as
   *  reconcile does after startup. A manifest that does not read whole refuses either way. */
  startup?: "every" | "servable";
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
  /** The spaces the manifest named at startup, in manifest order. */
  readonly named: readonly string[];
  readonly ended: Promise<number>;
}

/** Parse a space manifest. Throws with what is wrong: the caller keeps its live lanes rather than
 *  acting on a file it could not read whole. With `settings` it reads version 2, otherwise version 1. */
export function parseSpaceManifest(text: string): SpaceManifest;
export function parseSpaceManifest<S>(text: string, settings: SpaceSettings<S>): SpaceSettingsManifest<S>;
export function parseSpaceManifest<S>(text: string, settings?: SpaceSettings<S>): SpaceManifest | SpaceSettingsManifest<S> {
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
  if (settings === undefined && version !== 1)
    throw new Error(`version must be 1, got ${JSON.stringify(version)}${version === 2 ? "; this host takes no per-space settings" : ""}`);
  if (settings !== undefined && version !== 2)
    throw new Error(`version must be 2, got ${JSON.stringify(version)}${version === 1 ? '; this host reads one object per space, {"space": "<s>", ...}' : ""}`);
  if (!Array.isArray(spaces)) throw new Error(`spaces must be an array of ${settings === undefined ? "space names" : "space objects"}`);
  if (spaces.length === 0) throw new Error("spaces is empty; a host serves at least one space");
  const names: string[] = [];
  const parsed = new Map<string, S>();
  for (const entry of spaces) {
    let name: unknown = entry;
    let fields: Record<string, unknown> = {};
    if (settings === undefined) {
      if (typeof entry !== "string")
        throw new Error(`every entry of spaces must be a space name string, got ${JSON.stringify(entry)}; one host serves one broker, so run one host per broker rather than naming a server per space`);
    } else {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        throw new Error(`every entry of spaces must be an object {"space": "<s>", ...}, got ${JSON.stringify(entry)}`);
      ({ space: name, ...fields } = entry as Record<string, unknown>);
      if (typeof name !== "string") throw new Error(`every entry of spaces needs a space name string, got ${JSON.stringify(name)}`);
    }
    if ((name as string).trim() === "") throw new Error("a space name is empty");
    if (names.includes(name as string)) throw new Error(`space ${JSON.stringify(name)} is named more than once`);
    names.push(name as string);
    if (settings === undefined) continue;
    try {
      parsed.set(name as string, settings.parse(name as string, fields));
    } catch (e) {
      throw new Error(`space ${JSON.stringify(name)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (settings === undefined) return { version: 1, spaces: names };
  settings.across?.(parsed);
  return { version: 2, spaces: names, settings: parsed };
}

/** Read and parse the manifest at `path`. The error names the path, so a host log line is legible
 *  without the operator correlating it. */
export function readSpaceManifest(path: string): SpaceManifest {
  return readManifestFile(path, undefined).manifest as SpaceManifest;
}

/** Read the manifest at `path` and the SHA-256 of the bytes read, which an acknowledgment names. */
function readManifestFile<S>(path: string, settings: SpaceSettings<S> | undefined): { manifest: SpaceManifest | SpaceSettingsManifest<S>; sha256: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new Error(`${path} could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    const text = bytes.toString("utf8");
    const manifest = settings === undefined ? parseSpaceManifest(text) : parseSpaceManifest(text, settings);
    return { manifest, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (e) {
    throw new Error(`${path} is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Open a lane for every space in the manifest, then keep the live lanes equal to the manifest until
 *  a signal stops the host. Under the default `every` startup, a space that cannot open is a
 *  configuration error naming the space, and no lane is left running; under `servable` the host
 *  starts with the spaces that open. Returns once startup has succeeded; the caller prints its ready
 *  line and exits with `ended`. */
export async function runSpaceHost<S = undefined>(options: SpaceHostOptions<S>): Promise<SpaceHost> {
  const { label } = options;
  const manifestPath = resolve(options.manifest);
  const log = options.log ?? ((l: string) => console.error(l));
  const lanes = new Map<string, SpaceLane>();
  /** Each live lane's settings as JSON, which a changed entry no longer matches. */
  const opened = new Map<string, string>();
  let stopping = false;

  const settingsOf = (wanted: SpaceManifest | SpaceSettingsManifest<S>, space: string): S =>
    (wanted.version === 2 ? wanted.settings.get(space) : undefined) as S;

  /** Watch one lane for a loss. A lane the host deliberately removed is no longer the map's lane for
   *  its space, so its settled `lost` is ignored rather than read as a failure to recover from. */
  const watchLane = (lane: SpaceLane): void => {
    void lane.lost.then((what) => {
      if (stopping || lanes.get(lane.space) !== lane) return;
      lanes.delete(lane.space);
      opened.delete(lane.space);
      log(`✗ ${label}: space "${lane.space}" lost ${what} - that lane stopped ${options.serving}; ${lanes.size} lane(s) still up`);
      schedule(0);
    });
  };

  const open = async (space: string, settings: S): Promise<SpaceLane> => {
    const lane = await options.open(space, settings);
    lanes.set(space, lane);
    opened.set(space, JSON.stringify(settings) ?? "");
    watchLane(lane);
    return lane;
  };

  /** Open every wanted space without a lane. Each failure is reported and retried after the fixed
   *  wait; the others still open. */
  const openWanted = async (wanted: SpaceManifest | SpaceSettingsManifest<S>): Promise<void> => {
    let failed = false;
    for (const space of wanted.spaces) {
      if (lanes.has(space) || stopping) continue;
      try {
        await open(space, settingsOf(wanted, space));
        log(`${label}: space "${space}" opened - ${lanes.size} lane(s) up`);
      } catch (e) {
        failed = true;
        log(`✗ ${label}: space "${space}" could not be served (${e instanceof Error ? e.message : String(e)}) - retrying in ${REOPEN_WAIT_SECONDS}s`);
      }
    }
    if (failed) schedule(REOPEN_WAIT_SECONDS);
  };

  // ---- the acknowledgment ------------------------------------------------------------------------
  // Sound because passes are serialized and each reads the manifest afresh: a pass that read an
  // older manifest and is still opening a removed space is followed by one that closes it before
  // it acknowledges, and nothing opens a space except a pass whose own manifest names it.
  const appliedPath = `${manifestPath}.applied`;
  let acknowledged: string | undefined;
  /** Record that every space the manifest with this digest does not name has no lane. Written
   *  through a sibling and a rename, so a reader never sees a partial record. */
  const acknowledge = (sha256: string): void => {
    if (sha256 === acknowledged) return;
    const tmp = `${appliedPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, sha256 })}\n`);
    renameSync(tmp, appliedPath);
    acknowledged = sha256;
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
        let read: ReturnType<typeof readManifestFile<S>>;
        try {
          read = readManifestFile(manifestPath, options.settings);
        } catch (e) {
          log(`✗ ${label}: ${e instanceof Error ? e.message : String(e)} - keeping the ${lanes.size} lane(s) already open`);
          return;
        }
        const wanted = read.manifest;
        const want = new Set(wanted.spaces);
        for (const [space, lane] of [...lanes]) {
          if (stopping) continue;
          const changed = want.has(space) && opened.get(space) !== (JSON.stringify(settingsOf(wanted, space)) ?? "");
          if (want.has(space) && !changed) continue;
          // Out of the map before the close, so this lane's `lost` reads as the removal it is.
          lanes.delete(space);
          opened.delete(space);
          await lane.close().catch(() => {});
          log(changed
            ? `${label}: space "${space}" changed its settings - closed its lane to reopen it; ${lanes.size} lane(s) up`
            : `${label}: space "${space}" left the manifest - closed its lane; ${lanes.size} lane(s) up`);
        }
        if (stopping) return;
        try {
          acknowledge(read.sha256);
        } catch (e) {
          log(`✗ ${label}: could not write ${appliedPath} (${e instanceof Error ? e.message : String(e)}) - a writer waiting on it keeps waiting; retrying on the next pass`);
        }
        await openWanted(wanted);
      } while (pending && !stopping);
    } finally {
      reconciling = false;
    }
  };

  const closeAll = async (): Promise<void> => {
    await Promise.all([...lanes.values()].map((lane) => lane.close().catch(() => {})));
    lanes.clear();
    opened.clear();
  };

  // ---- startup ----------------------------------------------------------------------------------
  // A manifest that does not read whole refuses under either policy: there is no list to serve. The
  // acknowledgment is written before any lane opens, so a host that cannot write it refuses too.
  const initial = readManifestFile(manifestPath, options.settings);
  try {
    acknowledge(initial.sha256);
  } catch (e) {
    throw new Error(`${options.entry}: cannot write ${appliedPath} (${e instanceof Error ? e.message : String(e)}) - no lane was opened`);
  }
  if (options.startup === "servable") {
    reconciling = true;
    try { await openWanted(initial.manifest); } finally { reconciling = false; }
  } else {
    for (const space of initial.manifest.spaces) {
      try {
        await open(space, settingsOf(initial.manifest, space));
      } catch (e) {
        await closeAll();
        throw new Error(`${options.entry}: space "${space}" could not be served (${e instanceof Error ? e.message : String(e)}) - no lane was left running`);
      }
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
    if (retry !== undefined) clearTimeout(retry);
    await closeAll();
    throw new Error(`${options.entry}: cannot watch ${dirname(manifestPath)} for manifest changes (${e instanceof Error ? e.message : String(e)})`);
  }
  // A trigger that arrived during a servable startup's opens runs now.
  if (pending) schedule(0);
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
      void closeAll().then(() => resolve_(0));
    };
    process.on("SIGINT", stop("SIGINT"));
    process.on("SIGTERM", stop("SIGTERM"));
    process.on("SIGHUP", () => schedule(0));
  });
  return { lanes, named: initial.manifest.spaces, ended };
}
