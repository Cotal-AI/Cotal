import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, chmodSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { selfArgv } from "./self-exec.js";
import { resolveRuntimeSpace } from "./status.js";
import { cotalRoot } from "./paths.js";
import {
  assertManagerCanSpare, armManagerShutdownIntent, disarmManagerShutdownIntent,
  canonicalLocalProcessPath, commandIsCotalSupervisor, localProcessPath, parsePid, probeLiveness,
  readPidfile, readProcessCommand, reclaimDeadPreUpgradeRecord,
  MANAGER_DELIVERY_AWARE_MARKER, MANAGER_LOGFILE, MANAGER_PIDFILE, MANAGER_SHUTDOWN_INTENT, MANAGER_SPARE_CAPABILITY,
  type CommandReader, type LivenessProbe, type LocalProcess, type LocalProcessContext, type ManagerSpareSeats,
  parsePositiveIntegerFlag, verifyIdentityPin, writePidPair,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { stopLocalProcess } from "./local-process-stop.js";
import { listManagerSeatsForSpare, printLegacyManagerSpareUncertainty, printSparedAgents, type SpareSeatRow } from "./teardown-spare.js";
/** The `--max-sessions` value a live `cotal supervise` argv is actually serving.
 *
 *  The manager reads that flag only at start. A refresh that records a different number while this
 *  process stays up is a durable lie: MeshEntry claims a ceiling the live plane is not enforcing.
 *  Absent from argv means the plane default of 64, not a recorded decision. */
export function maxSessionsFromSuperviseArgv(command: string): number | undefined {
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let raw: string | undefined;
    if (token === "--max-sessions") raw = tokens[i + 1];
    else if (token.startsWith("--max-sessions=")) raw = token.slice("--max-sessions=".length);
    if (raw === undefined) continue;
    try {
      return parsePositiveIntegerFlag("--max-sessions", raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** True only when the live supervisor argv is proven to already be serving `requested`.
 *  An unreadable command line cannot prove that, so it is a refusal — persist would guess. */
export function liveManagerWouldApplyMaxSessions(command: string | undefined, requested: number): boolean {
  if (command === undefined) return false;
  return maxSessionsFromSuperviseArgv(command) === requested;
}

/** The space whose manager this folder's commands mean. Every helper below defaults to it, and the
 *  ones a caller reaches with an explicit `--space` take it as their last argument: the records are
 *  per-space now, so a helper that assumed the folder's space would answer about a sibling tenant's
 *  manager on a root that hosts more than one. Resolved from the folder's own RECORDS first: an open
 *  mesh has no account record to name its space, and answering with the default there is how a
 *  space-less read reports "absent" over a live manager. */
const folderSpace = (): string => resolveRuntimeSpace(process.cwd());
const ctx = (space: string): LocalProcessContext => ({ root: cotalRoot(), space });

/** The exact logfile the detached-manager writer opens. Exported so operator guidance names the
 *  writer-owned path instead of copying its filename template into command output. */
export const managerLogPath = (space: string, root: string = cotalRoot()): string =>
  canonicalLocalProcessPath(MANAGER_LOGFILE, { root, space });

/** The manager logfile as an operator-facing path relative to the selected mesh root. */
export const managerLogDisplayPath = (space: string, root: string = cotalRoot()): string =>
  relative(root, managerLogPath(space, root));

/** Exported so the delivery cutover preflight can NAME the pid it refused on: an error that says
 *  "cannot be attributed" without saying which pid is not actionable. READ-resolving, so it also
 *  names a pre-segmentation `manager.pid` when that is the record actually on disk. */
export const MANAGER_PID_PATH = (space: string = folderSpace()): string => localProcessPath(MANAGER_PIDFILE, ctx(space));
const PID_PATH = MANAGER_PID_PATH;
/** Sibling marker of `manager.pid`: written by THIS build's manager (which no longer hosts Plane-3 —
 *  the server-side delivery daemon does). Its presence beside a live `manager.pid` proves the manager is
 *  "delivery-aware" / non-hosting. A live `manager.pid` WITHOUT this marker is an OLD (pre-delivery-daemon)
 *  manager that still calls `startPlane3` — the delivery preflight stops it before the daemon binds, so an
 *  old hosting manager never double-binds `fanout`/`reader` against the new daemon. Per-space and
 *  READ-resolving, exactly like the pidfile it is a sibling of. */
const DELIVERY_AWARE_MARKER = (space: string = folderSpace()): string =>
  localProcessPath(MANAGER_DELIVERY_AWARE_MARKER, ctx(space));

/** The recorded manager's state. THREE-VALUED liveness plus absent, because collapsing it to a
 *  boolean is what made this dangerous. Both collapses are silent and both are wrong:
 *    `!== "dead"`  -> an `unknown` reports UP forever; no retry clears it and nothing starts.
 *    `=== "alive"` -> an `unknown` reports DOWN and a second manager launches onto a possibly-live one.
 *  `unknown` is REACHABLE on a real kernel, not just under a test shim: a Linux seccomp filter
 *  (`SECCOMP_RET_ERRNO`) or an LSM policy can return an arbitrary errno for `kill(pid, 0)` without
 *  executing it at all, and libuv preserves it. Proven with a live seccomp BPF filter, not by
 *  interposition. So the caller has to SEE the third state and refuse.
 *
 *  `foreign` is the fifth: the recorded pid is ALIVE and is provably NOT a manager. A record
 *  outliving its process is the same class of defect one layer down from a service registration
 *  outliving its host, and it resolves the same way — the number is eventually reused by an
 *  unrelated process, and from `kill(pid, 0)` alone that reads as a healthy manager forever. */
export type ManagerRecordState = "alive" | "dead" | "unknown" | "absent" | "unattributable" | "foreign";

/** The recorded manager, with the evidence behind the verdict — callers that must EXPLAIN a refusal
 *  need the pid and the command line that earned it, and a bare state cannot carry them. */
export interface ManagerRecord {
  state: ManagerRecordState;
  /** The recorded pid, when the file held one. */
  pid?: number;
  /** The live process's command line, when it was readable (present on `alive` and `foreign`). */
  command?: string;
}

/** Read + attribute the manager record in one place, so every caller decides on the same evidence.
 *
 *  ATTRIBUTION MAY ONLY DOWNGRADE ON PROOF. A live pid is demoted to `foreign` when its command line
 *  was READ and does not name the manager daemon — never when the read failed, never on a platform
 *  that cannot look, never on a process that died during the read. The asymmetry is the safety
 *  argument, and it is the same one the liveness probe makes: absence of evidence must fail toward
 *  the old behaviour (trust the record), because the opposite error starts a second manager on top
 *  of a live one. */
export function managerRecordState(
  probe: LivenessProbe = probeLiveness,
  readCommand: CommandReader = readProcessCommand,
  space: string = folderSpace(),
): ManagerRecord {
  const raw = readPidfile(PID_PATH(space));
  if (!raw) return { state: "absent" }; // no record, or a pre-protocol husk: nothing is behind it
  const pid = parsePid(raw);
  // NOT `absent`. Folding non-empty corrupt content into "no manager recorded" is what let the
  // ensure paths OVERWRITE it and launch a replacement, which is the same defect as deleting it:
  // that record may front a live process nobody can identify. `absent` means no pidfile (or an
  // empty husk); corrupt content is its own state and every action path must refuse on it.
  if (pid === undefined) return { state: "unattributable" };
  const liveness = probe(pid);
  if (liveness !== "alive") return { state: liveness, pid };
  const cmd = readCommand(pid);
  if (cmd.kind !== "command") return { state: "alive", pid }; // gone/unreadable: established nothing
  return { state: commandIsCotalSupervisor(cmd.command) ? "alive" : "foreign", pid, command: cmd.command };
}

/** {@link managerRecordState}'s verdict alone, for the callers that only branch on it. */
export function managerLiveness(
  probe: LivenessProbe = probeLiveness,
  readCommand: CommandReader = readProcessCommand,
  space: string = folderSpace(),
): ManagerRecordState {
  return managerRecordState(probe, readCommand, space).state;
}

/** One line describing what was found behind the record, for a caller that has to explain itself. */
export function describeManagerRecord(r: ManagerRecord): string {
  if (r.state === "absent") return "no manager pid recorded";
  if (r.state === "unattributable") return `the manager pidfile holds content that is not a pid`;
  const who = r.command !== undefined ? ` running \`${r.command}\`` : "";
  return `recorded manager pid ${String(r.pid)} is ${r.state}${who}`;
}

/** True only if the manager is PROVABLY running. `unknown` is not up, and neither is `foreign` — a
 *  live process that is not a manager answers no control plane. Callers that would ACT on that
 *  answer must use {@link managerRecordState} instead: this boolean cannot express the difference
 *  between "not running", "cannot tell" and "someone else's process", and acting on the difference
 *  is the whole point. */
export function managerUp(space: string = folderSpace()): boolean {
  return managerLiveness(probeLiveness, readProcessCommand, space) === "alive";
}



/** True if the live manager carries a delivery-aware marker BOUND to its current pid (i.e. it's THIS
 *  build, non-hosting). Fail-closed: the marker stores the pid it was written for, and this requires it
 *  to equal the live `manager.pid` — a stale marker left by a crash, a mismatch, or an unparseable file
 *  all read as NOT delivery-aware, so a live old hosting `manager.pid` can't be mistaken for non-hosting
 *  and the delivery preflight stops it. */
export function managerHasDeliveryMarker(space: string = folderSpace()): boolean {
  const markerPath = DELIVERY_AWARE_MARKER(space);
  const pidPath = PID_PATH(space);
  let markerPid: number;
  let livePid: number;
  try {
    // The pid record first: with no manager there is nothing to bind, so a leftover marker is never read.
    livePid = Number(readFileSync(pidPath, "utf8").trim());
    markerPid = Number(readFileSync(markerPath, "utf8").trim());
  } catch (e) {
    // A manager removes both records on exit, so either can be gone by the time it is read.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  return Number.isFinite(markerPid) && Number.isFinite(livePid) && markerPid === livePid;
}

/** Start the control-plane manager detached (pid in `.cotal/manager.<spaceKey>.pid`, output to
 *  `.cotal/manager.<spaceKey>.log`), stopped by `cotal down`. Re-execs this same CLI's `supervise` — the
 *  composed `cotal` binary registers it; `process.execArgv` carries the tsx loader in dev and is
 *  empty in prod. `supervise`'s auto runtime resolves to pty when detached, which answers the
 *  control plane (`cotal_spawn`/`despawn`/`purge`/`persona`) with no tmux/cmux needed. */
export type ManagerStartOpts = {
  space?: string;
  server?: string;
  spawn?: string[];
  launch?: string;
  runtime?: string;
  attachHost?: string;
  resumeAttempt?: string;
  resumeCommitToken?: string;
  wsPort?: number;
  /** Live-session ceiling forwarded as `supervise --max-sessions`. */
  maxSessions?: number;
};

export function startManagerDetached(
  o: ManagerStartOpts = {},
): number {
  const space = o.space ?? folderSpace();
  // BEFORE ANY RECORD OR LOG IS TOUCHED. `selfArgv` refuses when this process was not started from
  // the `cotal` entry (#1629), and a refusal must leave the root exactly as it found it. Computed after
  // the reclaim below, a refused start deleted dead pre-upgrade records; computed after `openSync`, it
  // created a manager log and leaked its descriptor.
  //
  // Then clear a provably dead PRE-UPGRADE record before claiming the canonical slot, so an upgraded
  // root does not end up holding both names and failing every later read as ambiguous. It refuses
  // (throws) on a live or unattributable one rather than orphaning the daemon behind it.
  const [node, ...self] = selfArgv();
  reclaimDeadPreUpgradeRecord(MANAGER_PIDFILE, ctx(space));
  reclaimDeadPreUpgradeRecord(MANAGER_DELIVERY_AWARE_MARKER, ctx(space));
  const logPath = managerLogPath(space);
  // 0600: the manager prints its console URL here, and that URL carries the console token — a
  // standing credential for every agent's terminal on this mesh, at rest for the life of the file.
  // `.cotal` is already 0700, so this is defence in depth rather than the boundary, but a log the
  // group/world can read is a needless second copy of that credential.
  const fd = openSync(logPath, "a", 0o600);
  // The mode above only applies when the file is CREATED, so every log that already exists from an
  // earlier version would keep its 0644. Narrow those too. Best-effort: a filesystem that cannot
  // represent the mode (or a Windows volume, where `.cotal`'s ACL is the real control) is not a
  // reason to refuse to start the manager.
  try { chmodSync(logPath, 0o600); } catch { /* mode is defence in depth, not the boundary */ }
  const args = [
    ...self,
    "supervise",
    "--space",
    space,
    "--server",
    o.server ?? DEFAULT_SERVER,
    ...(o.runtime ? ["--runtime", o.runtime] : []),
    // The address the broker was bound to. Passing it is what makes `cotal attach` reach this
    // manager from another machine; omitted, the endpoint stays loopback-only, so terminal exposure
    // never happens as a side effect of anything but an operator binding the mesh somewhere reachable.
    ...(o.attachHost ? ["--console-host", o.attachHost] : []),
    ...(o.spawn?.length ? ["--spawn", o.spawn.join(",")] : []),
    // A resolved mesh-manifest launch spec (cotal up -f): the manager materializes + boots each agent.
    ...(o.launch ? ["--launch", o.launch] : []),
    ...(o.resumeAttempt ? ["--resume-attempt", o.resumeAttempt] : []),
    ...(o.resumeCommitToken ? ["--resume-commit-token", o.resumeCommitToken] : []),
    // P2 item 6: the broker ws listener port (loopback) for the console session client's wsUrl.
    ...(o.wsPort !== undefined ? ["--ws-port", String(o.wsPort)] : []),
    ...(o.maxSessions !== undefined ? ["--max-sessions", String(o.maxSessions)] : []),
  ];
  // This is an INTERNAL child re-exec: the `up`/`spawn` that reached here already ran the first-run
  // connector seed, so the manager skips it on boot (a direct `cotal supervise` still seeds).
  const child = spawn(node, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" } });
  closeSync(fd);
  child.unref();
  // CANONICAL path, never a pre-upgrade one: a start that kept writing the root-scoped name would
  // keep minting the very records this change ends.
  const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, ctx(space));
  if (!child.pid) throw new Error("manager spawned with no pid");
  // #969/#1238: publish the pair by rename (pidfile + sibling start-token pin), so a crash never
  // leaves a torn pairing; a platform that cannot produce a start token still gets the legacy shape.
  writePidPair(pidPath, child.pid);
  // Mark this manager as delivery-aware (non-hosting) so the delivery preflight can tell it apart from
  // an old Plane-3-hosting manager. Written next to the pid, removed together in stopManager / down.
  writeFileSync(canonicalLocalProcessPath(MANAGER_DELIVERY_AWARE_MARKER, ctx(space)), String(child.pid));
  return child.pid ?? 0;
}

/** Refuse to stand a manager up OVER a record we cannot read or attribute.
 *
 *  Exported because `ensureManager` is not the only path that starts one: `cotal spawn -f` calls
 *  `startManagerDetached` directly after its own lease checks, and so skipped this entirely. A lease
 *  says nobody is ANSWERING; it does not say the recorded pid is dead. Overwriting an unknown or
 *  unattributable record is the same defect as deleting it, reached through a different verb, which
 *  is the third time that shape has appeared in this change. Any future starter calls this first. */
export function assertManagerRecordReplaceable(
  probe: LivenessProbe = probeLiveness,
  readCommand: CommandReader = readProcessCommand,
  space: string = folderSpace(),
): void {
  const record = managerRecordState(probe, readCommand, space);
  const state = record.state;
  // The record this is about, named in full: on a root that hosts two spaces "the manager pidfile"
  // is not a location an operator can act on, and on an un-upgraded one it is not even this name.
  const p = PID_PATH(space);
  // A FOREIGN record is replaceable, and saying what was found is the point of allowing it. The pid
  // is alive, so `probeLiveness` alone would have called this a healthy manager and every start
  // path would have skipped forever; it is provably not a manager, so nothing is orphaned by
  // writing over it. Announced rather than silent: a recycled pid means the record outlived its
  // process, and an operator who never hears that will meet it again.
  if (state === "foreign")
    console.error(
      `! ${describeManagerRecord(record)} - that is not a manager, so the record is stale (its process exited and the pid was reused). Replacing it.`,
    );
  if (state === "unattributable")
    throw new Error(
      `the manager pidfile at ${p} holds content that is not a pid (${JSON.stringify(readFileSync(p, "utf8").trim())}).\n` +
        `Refusing to start a manager over it: that record may front a live process nobody can identify, and overwriting it would orphan the process while reporting a healthy control plane.\n` +
        `NEXT: find and stop that process, then remove \`${p}\` by hand.`,
    );
  if (state === "unknown")
    throw new Error(
      `the recorded manager pid (${readFileSync(p, "utf8").trim()}) cannot be attributed: the kernel answered neither "running" nor "no such process" (a seccomp filter or LSM policy does this inside some sandboxes).\n` +
        `Refusing to start a manager over it: it may still be running and bound to the control plane.\n` +
        `NEXT: verify with \`ps -p <pid>\`. If it is gone, remove \`${p}\` and re-run.`,
    );
}

/** Make the control plane available: reuse a manager already running for this folder, else start
 *  one detached. Best-effort — callers treat it as non-fatal. A caller that needs THE manager to
 *  carry a runtime/launch spec (`up -f`) must stop any leftover manager first — a reused one is
 *  taken as-is. */
export function ensureManager(
  o: ManagerStartOpts = {},
  probe: LivenessProbe = probeLiveness,
  readCommand: CommandReader = readProcessCommand,
): { running: boolean; started: boolean; pid?: number } {
  const space = o.space ?? folderSpace();
  const state = managerLiveness(probe, readCommand, space);
  if (state === "alive") return { running: true, started: false };
  assertManagerRecordReplaceable(probe, readCommand, space); // refuses on unknown / unattributable, reports foreign
  const pid = startManagerDetached(o);
  return { running: true, started: true, pid };
}

/** A signal, injectable for the same reason the probe is: `EPERM` from `kill` is producible only by
 *  another user's process or by kernel policy, so the branch that handles it is otherwise unreachable
 *  from a test. Production passes nothing. */
export type SignalFn = (pid: number, signal: NodeJS.Signals) => void;

/** The manager as `cotal down` registers it: its pidfile, and the records that die with its process. */
export const MANAGER_PROCESS = {
  kind: "local-process",
  name: "manager",
  label: "manager",
  order: 10,
  pidFile: MANAGER_PIDFILE,
  artifacts: [MANAGER_DELIVERY_AWARE_MARKER, MANAGER_SHUTDOWN_INTENT, MANAGER_SPARE_CAPABILITY],
} satisfies LocalProcess;

/** Stop the space's manager. This is the one manager stop: `cotal down`, every `cotal up` teardown and
 *  the delivery cutover preflight run it, so each holds the stop reservation, refuses a concurrent stop,
 *  and escalates a wedged manager to SIGKILL. A default stop signals only a manager that published the
 *  capability to spare its managed agents, and reports the agents it left; `withAgents` arms their reap
 *  instead. Throws, with the records kept, when the stop is refused or the death is not confirmed. */
export async function stopManager(space: string = folderSpace(), { withAgents = false } = {}): Promise<boolean> {
  const context = ctx(space);
  let spared: SpareSeatRow[] | undefined;
  let spareSeats: ManagerSpareSeats | undefined;
  let legacyManagerSpareUnverified = false;
  if (!withAgents && existsSync(PID_PATH(space))) {
    const pin = verifyIdentityPin(PID_PATH(space));
    if (pin.kind === "legacy") legacyManagerSpareUnverified = true;
    else if (pin.kind === "match") spared = await listManagerSeatsForSpare(context);
  }
  let found: boolean;
  try {
    found = await stopLocalProcess(MANAGER_PROCESS, context, {
      owns: commandIsCotalSupervisor,
      beforeSignal: (attempt) => {
        if (attempt.target.token === undefined) {
          // Upgrade compatibility follows the shared identity contract: a live pre-pin record
          // is signalled after the warning emitted by stopLocalProcess. A default stop cannot verify
          // the newer spare capability. Destructive down uses the helper's reduced-guarantee
          // pid + reservation-inode handoff. A present pin still takes the fully identity-bound
          // paths below, and a mismatching pin was already refused before this hook.
          if (!withAgents)
            console.error(c.dim("could not verify that this legacy manager can spare its managed agents; signalling it for upgrade compatibility"));
        }
        if (withAgents) armManagerShutdownIntent(context, attempt);
        else if (attempt.target.token !== undefined) spareSeats = assertManagerCanSpare(context, undefined, attempt.target);
      },
    });
  } catch (e) {
    disarmManagerShutdownIntent(context);
    throw e;
  }
  for (const artifact of MANAGER_PROCESS.artifacts) rmSync(localProcessPath(artifact, context), { force: true });
  if (legacyManagerSpareUnverified) printLegacyManagerSpareUncertainty();
  else if (spared) printSparedAgents(spared, spareSeats);
  return found;
}
