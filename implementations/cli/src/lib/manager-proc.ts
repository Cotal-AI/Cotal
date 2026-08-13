import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, chmodSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { selfArgv } from "./self-exec.js";
import { resolveSpace } from "./status.js";
import { cotalPath } from "./paths.js";
import { parsePid, probeLiveness, type LivenessProbe } from "@cotal-ai/workspace";

/** Exported so the delivery cutover preflight can NAME the pid it refused on: an error that says
 *  "cannot be attributed" without saying which pid is not actionable. */
export const MANAGER_PID_PATH = (): string => cotalPath("manager.pid");
const PID_PATH = MANAGER_PID_PATH;
/** Sibling marker of `manager.pid`: written by THIS build's manager (which no longer hosts Plane-3 —
 *  the server-side delivery daemon does). Its presence beside a live `manager.pid` proves the manager is
 *  "delivery-aware" / non-hosting. A live `manager.pid` WITHOUT this marker is an OLD (pre-delivery-daemon)
 *  manager that still calls `startPlane3` — the delivery preflight stops it before the daemon binds, so an
 *  old hosting manager never double-binds `fanout`/`reader` against the new daemon. */
const DELIVERY_AWARE_MARKER = () => cotalPath("manager.delivery-aware");

/** The recorded manager's liveness, THREE-VALUED plus absent, because collapsing it to a boolean is
 *  what made this dangerous. Both collapses are silent and both are wrong:
 *    `!== "dead"`  -> an `unknown` reports UP forever; no retry clears it and nothing starts.
 *    `=== "alive"` -> an `unknown` reports DOWN and a second manager launches onto a possibly-live one.
 *  `unknown` is REACHABLE on a real kernel, not just under a test shim: a Linux seccomp filter
 *  (`SECCOMP_RET_ERRNO`) or an LSM policy can return an arbitrary errno for `kill(pid, 0)` without
 *  executing it at all, and libuv preserves it. Proven with a live seccomp BPF filter, not by
 *  interposition. So the caller has to SEE the third state and refuse. */
export function managerLiveness(probe: LivenessProbe = probeLiveness): "alive" | "dead" | "unknown" | "absent" | "unattributable" {
  const p = PID_PATH();
  if (!existsSync(p)) return "absent";
  const raw = readFileSync(p, "utf8").trim();
  if (raw === "") return "absent"; // a pre-protocol husk: nothing is behind it
  const pid = parsePid(raw);
  // NOT `absent`. Folding non-empty corrupt content into "no manager recorded" is what let the
  // ensure paths OVERWRITE it and launch a replacement, which is the same defect as deleting it:
  // that record may front a live process nobody can identify. `absent` means no pidfile (or an
  // empty husk); corrupt content is its own state and every action path must refuse on it.
  if (pid === undefined) return "unattributable";
  return probe(pid);
}

/** True only if the manager is PROVABLY running. `unknown` is not up, and callers that would ACT on
 *  that answer must use {@link managerLiveness} instead: this boolean cannot express the difference
 *  between "not running" and "cannot tell", and acting on the difference is the whole point. */
export function managerUp(): boolean {
  return managerLiveness() === "alive";
}



/** True if the live manager carries a delivery-aware marker BOUND to its current pid (i.e. it's THIS
 *  build, non-hosting). Fail-closed: the marker stores the pid it was written for, and this requires it
 *  to equal the live `manager.pid` — a stale marker left by a crash, a mismatch, or an unparseable file
 *  all read as NOT delivery-aware, so a live old hosting `manager.pid` can't be mistaken for non-hosting
 *  and the delivery preflight stops it. */
export function managerHasDeliveryMarker(): boolean {
  const markerPath = DELIVERY_AWARE_MARKER();
  const pidPath = PID_PATH();
  if (!existsSync(markerPath) || !existsSync(pidPath)) return false;
  const markerPid = Number(readFileSync(markerPath, "utf8").trim());
  const livePid = Number(readFileSync(pidPath, "utf8").trim());
  return Number.isFinite(markerPid) && Number.isFinite(livePid) && markerPid === livePid;
}

/** Start the control-plane manager detached (pid in `.cotal/manager.pid`, output to
 *  `.cotal/manager.log`), stopped by `cotal down`. Re-execs this same CLI's `supervise` — the
 *  composed `cotal` binary registers it; `process.execArgv` carries the tsx loader in dev and is
 *  empty in prod. `supervise`'s auto runtime resolves to pty when detached, which answers the
 *  control plane (`cotal_spawn`/`despawn`/`purge`/`persona`) with no tmux/cmux needed. */
export function startManagerDetached(
  o: { space?: string; server?: string; spawn?: string[]; launch?: string; runtime?: string; attachHost?: string; resumeAttempt?: string; resumeCommitToken?: string; wsPort?: number } = {},
): number {
  // 0600: the manager prints its console URL here, and that URL carries the console token — a
  // standing credential for every agent's terminal on this mesh, at rest for the life of the file.
  // `.cotal` is already 0700, so this is defence in depth rather than the boundary, but a log the
  // group/world can read is a needless second copy of that credential.
  const fd = openSync(cotalPath("manager.log"), "a", 0o600);
  // The mode above only applies when the file is CREATED, so every log that already exists from an
  // earlier version would keep its 0644. Narrow those too. Best-effort: a filesystem that cannot
  // represent the mode (or a Windows volume, where `.cotal`'s ACL is the real control) is not a
  // reason to refuse to start the manager.
  try { chmodSync(cotalPath("manager.log"), 0o600); } catch { /* mode is defence in depth, not the boundary */ }
  const [node, ...self] = selfArgv();
  const args = [
    ...self,
    "supervise",
    "--space",
    o.space ?? resolveSpace(process.cwd()),
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
  ];
  // This is an INTERNAL child re-exec: the `up`/`spawn` that reached here already ran the first-run
  // connector seed, so the manager skips it on boot (a direct `cotal supervise` still seeds).
  const child = spawn(node, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" } });
  closeSync(fd);
  child.unref();
  writeFileSync(PID_PATH(), String(child.pid));
  // Mark this manager as delivery-aware (non-hosting) so the delivery preflight can tell it apart from
  // an old Plane-3-hosting manager. Written next to the pid, removed together in stopManager / down.
  writeFileSync(DELIVERY_AWARE_MARKER(), String(child.pid));
  return child.pid ?? 0;
}

/** Make the control plane available: reuse a manager already running for this folder, else start
 *  one detached. Best-effort — callers treat it as non-fatal. A caller that needs THE manager to
 *  carry a runtime/launch spec (`up -f`) must stop any leftover manager first — a reused one is
 *  taken as-is. */
/** Refuse to stand a manager up OVER a record we cannot read or attribute.
 *
 *  Exported because `ensureManager` is not the only path that starts one: `cotal spawn -f` calls
 *  `startManagerDetached` directly after its own lease checks, and so skipped this entirely. A lease
 *  says nobody is ANSWERING; it does not say the recorded pid is dead. Overwriting an unknown or
 *  unattributable record is the same defect as deleting it, reached through a different verb, which
 *  is the third time that shape has appeared in this change. Any future starter calls this first. */
export function assertManagerRecordReplaceable(probe: LivenessProbe = probeLiveness): void {
  const state = managerLiveness(probe);
  if (state === "unattributable")
    throw new Error(
      `the manager pidfile at ${PID_PATH()} holds content that is not a pid (${JSON.stringify(readFileSync(PID_PATH(), "utf8").trim())}).\n` +
        `Refusing to start a manager over it: that record may front a live process nobody can identify, and overwriting it would orphan the process while reporting a healthy control plane.\n` +
        `NEXT: find and stop that process, then remove \`.cotal/manager.pid\` by hand.`,
    );
  if (state === "unknown")
    throw new Error(
      `the recorded manager pid (${readFileSync(PID_PATH(), "utf8").trim()}) cannot be attributed: the kernel answered neither "running" nor "no such process" (a seccomp filter or LSM policy does this inside some sandboxes).\n` +
        `Refusing to start a manager over it: it may still be running and bound to the control plane.\n` +
        `NEXT: verify with \`ps -p <pid>\`. If it is gone, remove \`.cotal/manager.pid\` and re-run.`,
    );
}

export function ensureManager(
  o: { space?: string; server?: string; spawn?: string[]; runtime?: string; launch?: string; attachHost?: string; resumeAttempt?: string; resumeCommitToken?: string; wsPort?: number } = {},
  probe: LivenessProbe = probeLiveness,
): { running: boolean } {
  const state = managerLiveness(probe);
  if (state === "alive") return { running: true };
  assertManagerRecordReplaceable(probe); // refuses on unknown / unattributable
  startManagerDetached(o);
  return { running: true };
}

/** A signal, injectable for the same reason the probe is: `EPERM` from `kill` is producible only by
 *  another user's process or by kernel policy, so the branch that handles it is otherwise unreachable
 *  from a test. Production passes nothing. */
export type SignalFn = (pid: number, signal: NodeJS.Signals) => void;

/** What a stop actually achieved, because "void" let this function claim success it had not earned. */
export type StopVerdict = "stopped" | "already-gone";

/** Blocking sleep. DO NOT reintroduce this for death-waiting: it blocks the event loop, so a child
 *  of this process is never reaped, remains a signalable zombie, and reads `alive` forever. That
 *  turned `cotal up` + Ctrl-C into an exit-1 that left the broker running. Death-waits await. */
// (sleepSync removed: see above.)

/** Stop the detached (pty) manager if we started one, and remove its records ONLY once it is gone.
 *
 *  THIS USED TO CATCH EVERY SIGNAL FAILURE AS "already gone" AND DELETE THE RECORDS ANYWAY. That was
 *  survivable while `EPERM` was misread as dead, because the caller never got here: the cutover
 *  preflight skipped a manager it thought was not running. Resolving `EPERM` to `alive` (the fix this
 *  change exists for) makes the preflight recognise ANOTHER USER's live manager and call this, at
 *  which point the old code sent a signal it was not permitted to send, swallowed the refusal, and
 *  deleted the pidfile and marker of a process that was still running and still bound to Plane 3.
 *  A correct fix upstream reaching a latent destructive bug downstream is the worst shape available,
 *  so this refuses instead: records are removed only on proven death, never on a signal we could not
 *  send or a death we could not confirm. Found by review, with a kernel seccomp proof. */
export async function stopManager(probe: LivenessProbe = probeLiveness, signal: SignalFn | undefined = undefined): Promise<StopVerdict> {
  const send: SignalFn = signal ?? ((pid, sig) => process.kill(pid, sig));
  const p = PID_PATH();
  const marker = DELIVERY_AWARE_MARKER();
  const clear = (): void => {
    rmSync(marker, { force: true });
    rmSync(p, { force: true });
  };
  if (!existsSync(p)) {
    rmSync(marker, { force: true }); // a marker with no pid records nothing
    return "already-gone";
  }
  const raw = readFileSync(p, "utf8").trim();
  const pid = parsePid(raw);
  if (pid === undefined) {
    // An EMPTY pidfile is a pre-protocol husk with nothing behind it, and clearing it is safe. ANY
    // OTHER unattributable content (garbled, fractional, out of range) may still front a LIVE
    // process we cannot identify or signal, so removing it would orphan that process while
    // reporting a clean stop. The contract at the top of pid.ts says such content is never a pid to
    // delete a record against; this is that rule at the destructive end, matching down.ts:298-311
    // and stopAuthService, which already refuse. My first version cleared it.
    if (raw === "") {
      clear();
      return "already-gone";
    }
    throw new Error(
      `the manager pidfile at ${p} is unattributable (${JSON.stringify(raw)}): it may still front a running process nobody can identify.\n` +
        `Refusing to remove it or report a clean stop; the delivery-aware marker is preserved with it.\n` +
        `NEXT: find and stop that process, then remove the file by hand.`,
    );
  }
  const before = probe(pid);
  if (before === "dead") {
    clear();
    return "already-gone";
  }
  if (before === "unknown")
    throw new Error(
      `refusing to stop manager pid ${pid}: its liveness cannot be determined (the kernel answered neither "running" nor "no such process"; a seccomp filter or LSM policy does this).\n` +
        `The pidfile and delivery-aware marker are LEFT IN PLACE: deleting them would orphan a process that may still be bound to the control plane.\n` +
        `NEXT: verify with \`ps -p ${pid}\`, then stop it yourself or remove \`.cotal/manager.pid\` if it is gone.`,
    );
  try {
    send(pid, "SIGTERM");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      clear(); // died between the probe and the signal, which is an ordinary race and genuinely gone
      return "already-gone";
    }
    throw new Error(
      `refusing to stop manager pid ${pid}: the signal was rejected (${code ?? "unknown error"}).\n` +
        `EPERM here means the process belongs to another user, so it is running and NOT ours to stop. The pidfile and marker are LEFT IN PLACE.\n` +
        `NEXT: stop it as its owner, or remove \`.cotal/manager.pid\` if you are certain it is gone.`,
    );
  }
  // The signal was accepted, which is not the same as the process being gone. Prove it before
  // removing the record, bounded, because a record deleted while its process lives is the defect.
  // AWAIT, never a blocking sleep: this process spawned the manager, so the event loop must run
  // for it to be reaped. A blocked loop leaves a zombie that still answers kill(pid,0).
  for (let i = 0; i < 40 && probe(pid) === "alive"; i++) await new Promise((r) => setTimeout(r, 50));
  const after = probe(pid);
  if (after !== "dead")
    throw new Error(
      `manager pid ${pid} accepted SIGTERM but was still ${after === "alive" ? "running" : "unattributable"} after 2s.\n` +
        `The pidfile and marker are LEFT IN PLACE rather than recording a stop that did not happen.\n` +
        `NEXT: check \`ps -p ${pid}\` and stop it directly if it is wedged.`,
    );
  clear();
  return "stopped";
}
