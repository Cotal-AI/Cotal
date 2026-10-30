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
 * removes a space waits for that record to know the space has no lane left in this process. A space
 * the manifest does not name whose open is still running holds that record back until the open has
 * settled and any lane it produced is closed, because that open would otherwise become a lane after
 * the writer was told there was none.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

/** How long after a lane fails to open the host tries it again. One fixed wait, never a growing
 *  backoff, and the log line that reports the failure names it. */
const REOPEN_WAIT_SECONDS = 5;

/** Lane startup signs broker handshakes on this process's event loop. Bound simultaneous opens so
 *  one large manifest cannot consume the connection budgets of its own lanes. */
const MAX_CONCURRENT_OPENS = 4;

/** How long a pass waits for one space's open. Admitted opens run together, and an open
 *  that has not settled by then no longer holds the pass: the others are served, the ready line is
 *  written, and the lane is taken or closed when that open settles. The acknowledgment is written
 *  too while the manifest still names the space, and held back once it does not. */
const OPEN_DEADLINE_SECONDS = 30;

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
  /** Stop serving and release everything the lane holds. Safe to call more than once. A rejection
   *  says the lane may still serve: the host then acknowledges nothing until a later close resolves. */
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
  /** How many seconds a pass waits for one space's open before serving the others without it.
   *  Default 30. */
  openDeadlineSeconds?: number;
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
  /** Spaces whose open outlived a pass's deadline and is still running. */
  readonly opening: ReadonlySet<string>;
  /** Spaces waiting for admission. Their opening deadlines have not started. */
  readonly queued: ReadonlySet<string>;
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
  /** Lanes taken out of service whose close rejected. Each may still serve, so while any is here
   *  no acknowledgment is written and its space is not opened again; every pass retries its close. */
  const unclosed = new Map<string, SpaceLane>();
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

  /** Opens that outlived their pass's deadline and have not settled. No second open starts for a
   *  space here: the one pending is taken, or closed, when it settles. One whose space the manifest
   *  no longer names holds back the acknowledgment until then. */
  const opening = new Set<string>();
  /** Names only: every pass reads settings afresh before admitting a queued lane. Set order keeps
   *  retries behind spaces that have not had a turn. An overdue open still occupies its slot. */
  const queued = new Set<string>();
  const retryAfter = new Map<string, number>();
  /** The spaces the manifest the last pass read named. An open that settles after its deadline
   *  reads it to tell a retry of a space still wanted from one the acknowledgment is waiting on. */
  let wantedSpaces: ReadonlySet<string> = new Set<string>();
  const openDeadline = options.openDeadlineSeconds ?? OPEN_DEADLINE_SECONDS;

  const take = (lane: SpaceLane, settings: S): void => {
    lanes.set(lane.space, lane);
    opened.set(lane.space, JSON.stringify(settings) ?? "");
    watchLane(lane);
  };

  /** Wait for an open until the deadline. `pending` says it is still running. */
  const within = async (attempt: Promise<SpaceLane>): Promise<{ outcome: "opened"; lane: SpaceLane } | { outcome: "failed"; why: string } | { outcome: "pending" }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        attempt.then(
          (lane) => ({ outcome: "opened" as const, lane }),
          (e: unknown) => ({ outcome: "failed" as const, why: e instanceof Error ? e.message : String(e) })),
        new Promise<{ outcome: "pending" }>((r) => { timer = setTimeout(() => r({ outcome: "pending" }), openDeadline * 1000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Open one space's lane, waiting at most the deadline. `opened` took the lane; `failed` was
   *  reported and is the pass's to retry; `pending` means the open is still running past the
   *  deadline, so the pass goes on without it and the open settles into {@link opening}'s rule. */
  const openWithin = async (space: string, settings: S): Promise<"opened" | "failed" | "pending"> => {
    const attempt = options.open(space, settings);
    const settled = await within(attempt);
    if (settled.outcome === "opened") {
      // A stop that landed while this open ran has already snapshotted the lanes to close: this one
      // is closed here instead of taken, and the stop waits for it (#4959).
      if (stopping) { await settled.lane.close().catch(() => {}); return "opened"; }
      take(settled.lane, settings);
      return "opened";
    }
    if (settled.outcome === "failed") {
      retryAfter.set(space, performance.now() + REOPEN_WAIT_SECONDS * 1000);
      log(`✗ ${label}: space "${space}" could not be served (${settled.why}) - retrying in ${REOPEN_WAIT_SECONDS}s`);
      return "failed";
    }
    opening.add(space);
    log(`✗ ${label}: space "${space}" did not open within ${openDeadline}s - serving the others without it; its open is still running and is not started again`);
    void attempt.then((lane) => {
      opening.delete(space);
      // A host that is stopping takes nothing; otherwise the lane is taken as opened and the next
      // pass closes it again if the manifest dropped or changed the space meanwhile.
      if (stopping) { void lane.close().catch(() => {}); return; }
      take(lane, settings);
      log(`${label}: space "${space}" opened after its deadline - ${lanes.size} lane(s) up`);
      schedule(0);
    }, (e: unknown) => {
      opening.delete(space);
      const why = e instanceof Error ? e.message : String(e);
      // A space the manifest dropped meanwhile opens no lane to retry, and its pending open was
      // holding back the acknowledgment: that pass runs now rather than after the retry wait.
      const wanted = wantedSpaces.has(space);
      if (wanted) retryAfter.set(space, performance.now() + REOPEN_WAIT_SECONDS * 1000);
      log(wanted
        ? `✗ ${label}: space "${space}" could not be served (${why}) after its deadline - retrying in ${REOPEN_WAIT_SECONDS}s`
        : `✗ ${label}: space "${space}" could not be served (${why}) after its deadline - it left the manifest meanwhile, so it is not opened again`);
      schedule(wanted && queued.size === 0 ? REOPEN_WAIT_SECONDS : 0);
    });
    return "pending";
  };

  /** Admit one bounded batch, then reconcile again for the rest. A fresh manifest read precedes
   *  each batch, so a queued removal or settings replacement never starts from the old snapshot. */
  const openWanted = async (wanted: SpaceManifest | SpaceSettingsManifest<S>, sha256: string): Promise<void> => {
    if (stopping) return;
    // Closing a removed lane may have awaited I/O since the pass read its manifest. Do not admit
    // queued work from that snapshot if a replacement arrived during the close.
    try {
      if (readManifestFile(manifestPath, options.settings).sha256 !== sha256) { schedule(0); return; }
    } catch (e) {
      log(`✗ ${label}: ${e instanceof Error ? e.message : String(e)} - keeping the ${lanes.size} lane(s) already open`);
      return;
    }
    const want = new Set(wanted.spaces);
    const now = performance.now();
    const eligible = (space: string): boolean => !lanes.has(space) && !unclosed.has(space)
      && !opening.has(space) && (retryAfter.get(space) ?? 0) <= now;
    for (const space of retryAfter.keys()) if (!want.has(space)) retryAfter.delete(space);
    for (const space of queued) if (!want.has(space) || !eligible(space)) queued.delete(space);
    for (const space of wanted.spaces) if (eligible(space)) queued.add(space);
    const slots = Math.max(0, MAX_CONCURRENT_OPENS - opening.size - inflight.size);
    await Promise.all([...queued].slice(0, slots).map(async (space) => {
      if (stopping) return;
      queued.delete(space);
      retryAfter.delete(space);
      const open = openWithin(space, settingsOf(wanted, space));
      inflight.add(open);
      try {
        const outcome = await open;
        if (outcome === "opened") log(stopping ? `${label}: space "${space}" opened during the stop - closed it` : `${label}: space "${space}" opened - ${lanes.size} lane(s) up`);
      } finally {
        inflight.delete(open);
      }
    }));
    if (stopping) return;
    let nextRetry = Infinity;
    const afterBatch = performance.now();
    for (const [space, at] of retryAfter) {
      if (at <= afterBatch) queued.add(space);
      else nextRetry = Math.min(nextRetry, at);
    }
    if (Number.isFinite(nextRetry)) schedule(Math.max(0, nextRetry - afterBatch) / 1000);
    if (queued.size > 0 && opening.size + inflight.size < MAX_CONCURRENT_OPENS) schedule(0);
  };

  /** Opens a pass is waiting on. A stop waits for them before it closes the lanes, so a lane that
   *  opens under the stop is closed by it and not left to the process exit (#4959). Each is bounded
   *  by the open deadline, so the wait is too. */
  const inflight = new Set<Promise<unknown>>();

  // ---- the acknowledgment ------------------------------------------------------------------------
  // Sound because passes are serialized and each reads the manifest afresh: a pass that read an
  // older manifest and is still opening a removed space is followed by one that closes it before
  // it acknowledges, nothing opens a space except a pass whose own manifest names it, no pass
  // acknowledges while a lane whose close rejected may still serve, and no pass acknowledges while
  // an open it left running past its deadline could still bring up a lane for a space the manifest
  // does not name (#5079).
  const appliedPath = `${manifestPath}.applied`;
  let acknowledged: string | undefined;
  /** The digest a pending open already held back, so the hold is reported once per manifest rather
   *  than on every pass that finds it. */
  let heldDigest: string | undefined;
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
        wantedSpaces = want;
        // Taken before the closes below, so an open that settles while this pass runs is either
        // still listed here or already a lane this pass's own close loop takes out (#5079).
        const heldOpening = [...opening].filter((space) => !want.has(space));
        for (const [space, lane] of [...unclosed]) {
          if (stopping) continue;
          if (await closeLane(space, lane)) log(`${label}: space "${space}" closed its lane on a retry`);
        }
        for (const [space, lane] of [...lanes]) {
          if (stopping) continue;
          const changed = want.has(space) && opened.get(space) !== (JSON.stringify(settingsOf(wanted, space)) ?? "");
          if (want.has(space) && !changed) continue;
          // Out of the map before the close, so this lane's `lost` reads as the removal it is.
          lanes.delete(space);
          opened.delete(space);
          if (!(await closeLane(space, lane))) continue;
          log(changed
            ? `${label}: space "${space}" changed its settings - closed its lane to reopen it; ${lanes.size} lane(s) up`
            : `${label}: space "${space}" left the manifest - closed its lane; ${lanes.size} lane(s) up`);
        }
        if (stopping) return;
        if (unclosed.size === 0 && heldOpening.length === 0) {
          try {
            acknowledge(read.sha256);
          } catch (e) {
            log(`✗ ${label}: could not write ${appliedPath} (${e instanceof Error ? e.message : String(e)}) - a writer waiting on it keeps waiting; retrying on the next pass`);
          }
        } else {
          if (heldOpening.length > 0 && heldDigest !== read.sha256) {
            heldDigest = read.sha256;
            log(`✗ ${label}: space(s) ${heldOpening.map((space) => JSON.stringify(space)).join(", ")} left the manifest while still opening - acknowledging nothing until each open settles and any lane it opened is closed`);
          }
          schedule(REOPEN_WAIT_SECONDS);
        }
        await openWanted(wanted, read.sha256);
      } while (pending && !stopping);
    } finally {
      reconciling = false;
    }
  };

  /** Close a lane already out of the map. A close that rejects keeps the lane in `unclosed`, which
   *  holds back every acknowledgment until a later pass closes it. */
  const closeLane = async (space: string, lane: SpaceLane): Promise<boolean> => {
    try {
      await lane.close();
      unclosed.delete(space);
      return true;
    } catch (e) {
      unclosed.set(space, lane);
      log(`✗ ${label}: space "${space}" did not confirm its lane closed (${e instanceof Error ? e.message : String(e)}) - acknowledging nothing until it does; retrying in ${REOPEN_WAIT_SECONDS}s`);
      return false;
    }
  };

  /** Close every lane at once. Each leaves the maps before its close, so its `lost` reads as the
   *  deliberate close it is and never schedules a reconcile that would open it again. */
  const closeAll = async (): Promise<void> => {
    const all = [...lanes.values(), ...unclosed.values()];
    lanes.clear();
    opened.clear();
    unclosed.clear();
    await Promise.all(all.map((lane) => lane.close().catch(() => {})));
  };

  // ---- startup ----------------------------------------------------------------------------------
  // A manifest that does not read whole refuses under either policy: there is no list to serve. The
  // acknowledgment is written before any lane opens, so a host that cannot write it refuses too.
  const initial = readManifestFile(manifestPath, options.settings);
  wantedSpaces = new Set(initial.manifest.spaces);
  try {
    acknowledge(initial.sha256);
  } catch (e) {
    throw new Error(`${options.entry}: cannot write ${appliedPath} (${e instanceof Error ? e.message : String(e)}) - no lane was opened`);
  }
  if (options.startup === "servable") {
    reconciling = true;
    try { await openWanted(initial.manifest, initial.sha256); } finally { reconciling = false; }
  } else {
    // One space at a time, and the first that does not open refuses the host. An open still running
    // past the deadline closes its lane when it settles: the host is stopping by then.
    for (const space of initial.manifest.spaces) {
      const attempt = options.open(space, settingsOf(initial.manifest, space));
      const settled = await within(attempt);
      if (settled.outcome === "opened") { take(settled.lane, settingsOf(initial.manifest, space)); continue; }
      stopping = true;
      if (settled.outcome === "pending") void attempt.then((lane) => lane.close().catch(() => {}), () => {});
      await closeAll();
      throw new Error(settled.outcome === "failed"
        ? `${options.entry}: space "${space}" could not be served (${settled.why}) - no lane was left running`
        : `${options.entry}: space "${space}" did not open within ${openDeadline}s - no lane was left running`);
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
  if (pending) setImmediate(() => schedule(0));
  const backstop = setInterval(() => schedule(0), BACKSTOP_INTERVAL_SECONDS * 1000);
  backstop.unref();

  const ended = new Promise<number>((resolve_) => {
    const stop = (signal: NodeJS.Signals) => () => {
      if (stopping) return;
      stopping = true;
      queued.clear();
      retryAfter.clear();
      options.onStop?.(signal);
      if (retry !== undefined) clearTimeout(retry);
      if (debounce !== undefined) clearTimeout(debounce);
      clearInterval(backstop);
      watcher?.close();
      // Every lane closes at once: one lane waiting on a slow broker must not hold the others open.
      // An open still running for a pass finishes first, closing its lane under the stop, so the
      // process does not exit with that lane's footprint (a delivery lease, a callout connection)
      // left behind (#4959).
      void Promise.allSettled([...inflight]).then(closeAll).then(() => resolve_(0));
    };
    process.on("SIGINT", stop("SIGINT"));
    process.on("SIGTERM", stop("SIGTERM"));
    process.on("SIGHUP", () => schedule(0));
  });
  return { lanes, opening, queued, named: initial.manifest.spaces, ended };
}
