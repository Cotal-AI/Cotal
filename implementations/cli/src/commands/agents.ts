import { mintCreds, newIdentity, openSessionRail, standaloneConnectOpts, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs, type SessionGrant } from "@cotal-ai/core";
import { authDir, findCotalRoot, loadMeshes, loadSpaceAuth, targetFlags } from "@cotal-ai/workspace";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { c } from "../ui.js";
import { askManager, scatterManager, failIfNotOk, resolveControlTarget, onInstanceOrExit, type ScatterInstanceLiveness } from "../lib/control.js";
import { attachClient, detachKey, holdTerminal, isTransportEnd, meshSessionTransport, type TerminalHold } from "../lib/attach-client.js";
import { completingFlagValue } from "../lib/completion.js";

/**
 * The manager's operator clients — thin control-plane request/reply commands (`stop`/`ps`/
 * `attach`) that drive a RUNNING manager. Moved from `@cotal-ai/manager` in stage 2a of the CLI
 * rework: they are operator client commands, not daemon code; the manager keeps `supervise`.
 * Detached LAUNCH is `cotal spawn --detach` (spawn.ts) — one launch grammar for both modes.
 */

const nameFlag = (what: string) =>
  ({ name: "name", type: "string", value: "<n>", description: what }) as const;

/** `--on <instance>`: address ONE manager instance instead of the class queue. Shared by
 *  ps/stop/attach so the three cannot drift. For stop and attach it is the seat-locality escape
 *  hatch: the manager that can act on a seat is the one HOSTING it, which is not necessarily the
 *  one that wins the class queue. */
const onFlag = { name: "on", type: "string", value: "<instance>", description: "target a specific manager instance id (multi-manager space); default = class anycast" } as const;
export const stopFlags = [...targetFlags, nameFlag("managed agent to stop (required)"), onFlag] as const satisfies readonly FlagSpec[];
export const psFlags = [...targetFlags, onFlag] as const satisfies readonly FlagSpec[];
/** `--no-reconnect`: one session, exit when it ends, whatever ended it. The default reconnects,
 *  which is right for a person at a terminal and wrong for a script that wants a single run with a
 *  single exit code. */
const noReconnectFlag = { name: "no-reconnect", type: "boolean", description: "exit when the session ends instead of re-establishing it" } as const;
export const attachFlags = [...targetFlags, nameFlag("managed agent to attach to (required)"), onFlag, noReconnectFlag] as const satisfies readonly FlagSpec[];
/** `cotal input`: type into a seat without holding a terminal open. `--text` is a VALUE flag, so
 *  its argument is taken verbatim and may begin with `/` or `-` (`--text "/compact"`) - which is
 *  the point: a harness command is exactly the payload that would be eaten by a positional
 *  grammar. `--no-enter` is a declared boolean literally named `no-enter` rather than a negation
 *  of an `enter` flag: node's `parseArgs` does not negate under `strict`, and the CLI already
 *  spells this shape (`--no-open`, `--no-replay`). */
export const inputFlags = [
  ...targetFlags,
  nameFlag("managed agent to type into (required)"),
  { name: "text", type: "string", value: "<text>", description: "the text to type, verbatim (required); quote it when it starts with / or -" },
  { name: "no-enter", type: "boolean", description: "type the text without pressing Enter after it" },
  onFlag,
] as const satisfies readonly FlagSpec[];

export function managedAgentComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, attachFlags);
  if (flag?.name === "space") return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  if (flag?.name === "creds") return { items: [], directive: "default" };
  if (flag?.name === "name") return { items: [], directive: "nofiles" };
  if (argv.length <= 1)
    return { items: attachFlags.map((f) => ({ value: `--${f.name}`, description: f.description })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

export async function stop(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof stopFlags>;
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  // STATIC mesh: operator stop is a cross-agent op — the `control-caller-admin` instrument holds
  // the any-mode despawn row, so `reach: "any"` names any target (the broker grant IS the
  // authority).
  // USER mesh: ONE deterministic path — the op rides the operator's own bearer with `reach:
  // "owner"` (its own-domain despawn row), and the MANAGER authorizes: agents under your own
  // owner pass with scope "spawn", another owner's agent needs "admin" on your ledger row (the
  // handler's fresh any-mode authorization). No client-side try-admin-then-owner fallback.
  // Seat-locality: the manager that can stop a seat is the one HOSTING it, so resolve WHERE before
  // choosing WHO. Must precede the mint — a credential cannot gain an instance rail after issuance.
  const on = await pinForTarget(v, "cotal stop");
  const t = await resolveControlTarget(v, "control-caller-admin", on);
  const reach = t.auth.bearer ? "owner" : "any";
  const reply = await askManager(t.space, t.server, "stop", { name: v.name }, t.auth, reach, undefined, { instanceId: on });
  failIfNotOk(reply);
  // User mesh: a stop IS a grant revoke (rows are runtime grants — a non-running agent holds no
  // standing mint secret); a respawn re-grants automatically. Say so, so the operator's
  // restart-vs-revoke model is visible at the command, not inferred from docs.
  console.log(c.dim(`✓ stopped ${v.name}${t.auth.bearer ? " - its actor grant is revoked; a respawn re-grants automatically" : ""}`));
}

type AgentRow = {
  name: string;
  role?: string;
  agent: string;
  mode: string;
  status: string;
  uptimeMs: number;
  mesh: string;
  authHealth?: string;
  authReason?: string;
};

/** Compact process age for a row: `12s`, `47m`, `3.5h`, `2d 7h`. */
function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = s / 3600;
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${Math.floor(h - d * 24)}h`;
}

/**
 * WHERE does the named seat live? A `stop` or `attach` can only be served by the manager actually
 * HOSTING the seat, and the class queue does not know which one that is — so without this the verb
 * is answered by whichever instance wins the race and fails on a seat that plainly exists.
 *
 * This is a POSITIVE lookup, not a retry after a miss, and that is forced by measurement: a manager
 * asked about a seat it does not host answers `not-found: no agent "<n>"` — the SAME code and the
 * same message it gives for a name that exists nowhere. "Hosted elsewhere" and "does not exist" are
 * indistinguishable from a single manager's answer, so a caller that retried on a miss would scatter
 * for a typo and, worse, could only ever report the ambiguous message. Asking every instance is the
 * only construction that can tell the two apart — which is also what lets the error finally say
 * which case it is.
 *
 * Costs a second one-shot instrument. The scatter's freeze read belongs to the PRIVILEGED tier;
 * `stop`/`attach` mint ADMIN, which is denied that read deliberately ("the admin tier never
 * scatters"). Rather than widen admin for convenience, the lookup runs as its own privileged
 * instrument and the admin instrument is then minted pinned to the answer.
 */
type SeatLocation =
  | { kind: "pin"; instanceId: string }
  | { kind: "unpinned" } // one instance, or a mode that cannot scatter — no ambiguity to resolve
  | { kind: "absent"; checked: number; unreachable: string[] };

async function locateSeat(v: FlagValues<typeof stopFlags>, name: string): Promise<SeatLocation> {
  // USER mode cannot do this: a ledger-scoped bearer does not hold the freeze rows, so a scatter
  // dies on a permissions violation that reads as "no manager". Left unpinned — `--on` stays the
  // manual escape hatch there, and docs/cli.md says so rather than this failing mysteriously.
  const probe = await resolveControlTarget(v, "control-caller-privileged");
  if (probe.auth.bearer) return { kind: "unpinned" };
  const scatter = await scatterManager(probe.space, probe.server, "ps", probe.auth, probe.spaceAuth);
  if (!scatter.ok) return { kind: "unpinned" }; // cannot locate ⇒ behave exactly as before, never worse
  const reachable = scatter.instances.filter((i) => i.reachable);
  const unreachable = scatter.instances.filter((i) => !i.reachable).map((i) => i.instanceId);
  if (reachable.length <= 1 && !unreachable.length) return { kind: "unpinned" };
  const host = reachable.find((i) => ((i.data as AgentRow[] | undefined) ?? []).some((r) => r.name === name));
  if (host) return { kind: "pin", instanceId: host.instanceId };
  return { kind: "absent", checked: reachable.length, unreachable };
}

/** Resolve `--on` for a targeted verb: an explicit pin wins; otherwise locate the seat. Returns the
 *  instance to address, or exits with an error that says WHICH case the miss was. */
async function pinForTarget(v: FlagValues<typeof stopFlags>, verb: string): Promise<string | undefined> {
  const on = onInstanceOrExit(v.on, verb);
  if (on !== undefined) return on;
  const loc = await locateSeat(v, String(v.name));
  if (loc.kind === "pin") return loc.instanceId;
  if (loc.kind === "unpinned") return undefined;
  // The honest error #383 asked for: name the search, not just the absence. A registration that
  // gave no answer within the deadline is NOT told to "retry": a manager whose host died never
  // deregisters, so its row stays in the registry indefinitely and answers nothing, and a retry
  // against it loops forever. Say what is known (registered, silent), what it may mean (a live
  // slow host OR a dead registration), and the two real actions.
  const missed = loc.unreachable.length
    ? ` ${loc.unreachable.length} registered manager instance(s) gave no answer within the deadline (${loc.unreachable.join(", ")}). Either that host is alive but slow, or it died and its registration was never removed; if it is dead, deregister it. To address it directly: \`${verb} --on <instance>\` (the whole id, as printed).`
    : "";
  console.error(c.red(`✗ no managed agent "${v.name}" on any of the ${loc.checked} reachable manager instance(s) in this space.${missed}`));
  process.exit(1);
}

/**
 * What one SILENT manager instance's row says. The wording lives here, in the CLI, and not in the
 * scatter that produced the fact: core reports a frozen slot that did not answer, and turning that
 * into a sentence for an operator is a rendering decision.
 *
 * "unreachable" was the old word for all four of these, and it was a network verdict this client
 * never held. What it actually knows is narrower and more useful — whether it ASKED the broker
 * about the instance, and what the broker said:
 *
 *  - `gone`: the broker itself reports nothing subscribed on that instance's rail. The registration
 *    outlived its host, which never happens on its own and never heals on its own, so the row names
 *    the verb that removes it.
 *  - `unknown`: asked, nothing came back. "Alive but slow" and "wedged" are the same observation,
 *    and neither is death — so this row still says only what happened.
 *  - `not-probed` / `probe-refused`: this command could not ask. That is a fact about the command,
 *    not the instance, and saying so is what keeps a local gap from reading as a remote fault.
 */
function silentManagerRow(liveness: ScatterInstanceLiveness | undefined, instanceId: string): string {
  if (liveness === "gone")
    return (
      c.red("registration is stale") +
      c.dim(` (the broker reports nothing subscribed on its rail; its host is gone and never deregistered)`) +
      c.dim(`\n  ↳ remove the record: cotal deregister-instance --instance ${instanceId}`)
    );
  const why =
    liveness === "probe-refused"
      ? " (its liveness could not be probed: the broker refused this command's probe, named above)"
      : liveness === "not-probed"
        ? " (its liveness was not probed: this command holds no probe grant for it)"
        : " (either the host is alive and slow, or it died and its registration was never removed)";
  return c.red("registered, no answer within the deadline") + c.dim(why);
}

/** Render one managed-agent row (process fact, mesh fact, optional auth-health line), indented for
 *  the per-manager grouping a class scatter prints.
 *
 *  Two facts, printed as two facts. The manager reports the PROCESS (`status` from the runtime
 *  handle, `uptimeMs` from its start) and the MESH presence separately, and they disagree in the
 *  common failure: a seat that is `running` for two days but `offline` on the mesh. Folding them
 *  into one word rendered ten live processes as "offline" and a 57h-old process with no roster
 *  entry as "starting…", both false. `mesh: absent` means exactly "not in the presence roster",
 *  so it prints as that; the process age next to it tells the reader whether it is a fresh start
 *  or a seat that never joined. */
function printAgentRow(r: AgentRow, indent = ""): void {
  const proc =
    r.status === "running"
      ? c.green("running") + c.dim(" " + fmtUptime(r.uptimeMs))
      : r.status === "exited"
        ? c.red("exited") + c.dim(" after " + fmtUptime(r.uptimeMs))
        : c.yellow(r.status) + c.dim(" " + fmtUptime(r.uptimeMs));
  const mesh =
    r.mesh === "absent"
      ? c.yellow("not in roster")
      : r.mesh === "offline"
        ? c.dim("mesh offline")
        : r.mesh === "working"
          ? c.green("working")
          : r.mesh === "waiting"
            ? c.yellow("waiting")
            : c.cyan(r.mesh);
  // Confirmed failure is red; ambiguity/warning states (unknown/stale) are yellow — the operator
  // triages "definitely broken" before "might be".
  const authColor = r.authHealth === "auth-renewal-failed" ? c.red : c.yellow;
  console.log(
    `${indent}${c.bold(r.name)}${r.role ? c.dim("/" + r.role) : ""}  ${c.dim(
      r.agent + " · " + r.mode,
    )}  ${proc}  ${mesh}${r.authHealth ? "  " + authColor(r.authHealth) : ""}`,
  );
  // The detached agent's ONLY operator window into a failing bearer refresh: the provider command's
  // operator-exact sentence, verbatim (it already names the repair).
  if (r.authHealth && r.authReason) console.log(authColor(`${indent}    ${r.authReason}`));
}

export async function ps(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof psFlags>;
  const on = onInstanceOrExit(v.on, "cotal ps");
  // `--on` must reach the MINT, not just the invoke: the one-shot instrument is issued during
  // this resolve, and a credential cannot gain an instance rail after it is minted.
  const t = await resolveControlTarget(v, "control-caller-privileged", on);
  // `--on <instance>`: pin ps to ONE manager instance's `inst` route (P2 item 3 multi-manager) — a
  // single-manager view. Same path for both modes (no freeze; no scatter).
  if (on !== undefined) {
    const reply = await askManager(t.space, t.server, "ps", undefined, t.auth, "owner", undefined, { instanceId: on });
    failIfNotOk(reply);
    const rows = (reply.data as AgentRow[]) ?? [];
    if (!rows.length) {
      console.log(c.dim("(no managed agents)"));
      return;
    }
    for (const r of rows) printAgentRow(r);
    return;
  }

  // Mode chosen UP FRONT from the connection shape. Never try-scatter-catch-degrade: a silent
  // downgrade is the bug this branch fixes, and reintroducing it in the fix would be the whole
  // night in miniature.
  //
  // USER MODE (bearer present): `ep.one` to one manager. The ledger-scoped bearer holds
  // `ep.one.manager.ps` when scope includes `admin` (measured); it does NOT hold the freeze
  // STREAM.INFO row, so a class scatter would die on a permissions violation that reads as
  // "no manager". The manager answers from its in-memory roster with an owner filter — no
  // privileged records read. Multi-manager completeness is not claimed (see docs/cli.md).
  //
  // STATIC/OPEN (no bearer): class scatter. The operator instrument (or bare open connect) holds
  // the freeze rows; every registered instance is attributed, and a non-answering one is labeled
  // unreachable (pin 3).
  if (t.auth.bearer) {
    // `ps` has `--on` and did not pass it on this branch (the pinned branch returned above), so a
    // split may name it as the remedy: the pin is declared, empty.
    const reply = await askManager(t.space, t.server, "ps", undefined, t.auth, "owner", undefined, {});
    failIfNotOk(reply);
    const rows = (reply.data as AgentRow[]) ?? [];
    if (!rows.length) {
      console.log(c.dim("(no managed agents)"));
      return;
    }
    for (const r of rows) printAgentRow(r);
    return;
  }

  const scatter = await scatterManager(t.space, t.server, "ps", t.auth, t.spaceAuth);
  if (!scatter.ok) {
    console.error(c.red(`✗ ${scatter.error}`));
    process.exit(1);
  }
  // Stable ordering: reachable instances first, then by instance id.
  const instances = [...scatter.instances].sort(
    (a, b) => Number(b.reachable) - Number(a.reachable) || a.instanceId.localeCompare(b.instanceId),
  );
  // A single-manager space is the common case — print a flat list, no per-manager grouping noise.
  if (instances.length === 1 && instances[0].reachable && !instances[0].error) {
    const rows = (instances[0].data as AgentRow[]) ?? [];
    if (!rows.length) {
      console.log(c.dim("(no managed agents)"));
      return;
    }
    for (const r of rows) printAgentRow(r);
    return;
  }
  // Multi-manager: group under a per-instance header; unreachable instances are shown, never dropped.
  //
  // The header prints the FULL instance id, not a prefix. This block runs only in a multi-manager
  // space (precisely when the split makes `--on <instance>` the one way to address a manager) and
  // `--on` takes nothing but the whole 26-32 char lifecycle token (`assertLifecycleToken`). An
  // abbreviated header therefore showed the operator an id that the very next command refuses
  // (`"4ik6rb0e" is not a valid lifecycle token`), with the full value printed nowhere: the remedy
  // was named and then withheld. Width costs one line here; the prefix cost the flag entirely.
  for (const inst of instances) {
    const label = `manager ${inst.instanceId}`;
    if (!inst.reachable) {
      // Not "unreachable": the client holds no network verdict. What it knows is which question it
      // asked about this instance and what came back, which is narrower and more useful. The four
      // cases and their wording are `silentManagerRow`.
      console.log(`${c.bold(label)}  ${silentManagerRow(inst.liveness, inst.instanceId)}`);
      continue;
    }
    if (inst.error) {
      console.log(`${c.bold(label)}  ${c.red(inst.error)}`);
      continue;
    }
    const rows = (inst.data as AgentRow[]) ?? [];
    console.log(`${c.bold(label)}  ${c.dim(rows.length ? `${rows.length} agent${rows.length === 1 ? "" : "s"}` : "no agents")}`);
    for (const r of rows) printAgentRow(r, "  ");
  }
}

/** Re-establishment backoff, in order; the last value is the cap and repeats forever. A seat that
 *  exists is worth waiting for — the operator asked to be attached to it, and the alternative is
 *  the terminal they walked away from being gone when they come back. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long any single wait on a LINK may take before the loop stops waiting on it. Neither
 *  `flush()` nor `drain()` carries a deadline of its own, and `connect`'s `timeout` covers only the
 *  dial: a link that half-opens AFTER connect (the exact slow death this command exists for) would
 *  otherwise pin the loop, and the detach key with it, until the connection's own heartbeat gave up
 *  around two minutes later. */
const LINK_DEADLINE_MS = 5_000;

/** A deadline that never holds the process open by itself: the loser of a race must not add five
 *  seconds to an exit. */
/** Race a link round trip against a deadline, and answer `no` if the deadline wins. The timer is
 *  deliberately NOT unref'd: it is the only thing keeping the process alive while we wait on a
 *  socket that will never answer, and an unref'd one lets node empty its loop and abort the whole
 *  command on a pending await instead of finishing the wait and printing why. It is cleared as soon
 *  as either side settles, so a healthy link is never held open for the remainder of the deadline. */
const withDeadline = async (work: Promise<boolean>, ms: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); });
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
};

/** Did a flush RETURN inside the deadline? That, and not the publish, is what says a frame left:
 *  publishing is a local buffer write. A rejection and a timeout are the same answer here, `no`. */
const flushed = (nc: NatsConnection): Promise<boolean> =>
  withDeadline(nc.flush().then(() => true, () => false), LINK_DEADLINE_MS);

/** Give a connection back, bounded. Draining is another flush, so a link that has already missed
 *  its deadline is closed outright instead of being asked to drain through the same dead socket.
 *  A drain that REJECTS has closed nothing either: it gives up inside that same flush, before the
 *  close it would have done, so a rejection means close it here or leak the socket. */
const closeLink = async (nc: NatsConnection): Promise<void> => {
  const drained = await withDeadline(nc.drain().then(() => true, () => false), LINK_DEADLINE_MS);
  if (!drained) await nc.close().catch(() => { /* already gone */ });
};

/** A session that ran at least this long counts as one that WORKED, whether or not the seat spoke.
 *  Below it, a link that comes up for the control round trip and dies again is a flap, and resetting
 *  the backoff on those re-mints a grant, a credential and a hand-back connection every second. */
const SESSION_WORKED_MS = 5_000;

/** One establishment attempt: the manager's answer, classified by what the CALLER should do about
 *  it rather than by prose. `gone`/`denied` stop the loop; `fatal` is a refusal that retrying can
 *  never fix; everything else is worth another attempt. */
type Established =
  | { ok: true; nc: NatsConnection; grant: SessionGrant; creds: string; inbox: string; server: string }
  | { ok: false; kind: AttachRefusal | "fatal"; message: string; fromManager?: true };

/** What a caller should DO about a manager refusal. `denied` will not change by asking again;
 *  `gone` is the seat the manager no longer knows, so there is nothing left to attach to; anything
 *  else is worth another attempt. */
export type AttachRefusal = "denied" | "gone" | "transient";

/**
 * Classify a refusal on the manager's error CODE, never on its wording. The wording is operator
 * copy and changes; the code is the contract. Getting this wrong in either direction is a real
 * failure: reading `permission-denied` as transient turns a refusal into an infinite retry loop
 * against a manager that has already said no, and reading `not-found` as transient does the same
 * to a seat that no longer exists.
 */
export function attachRefusal(code: string | undefined): AttachRefusal {
  if (code === "permission-denied") return "denied";
  if (code === "not-found") return "gone";
  return "transient";
}

/**
 * What a re-establishment TELLS the operator while it keeps trying, and what it keeps to itself.
 * Returns the line to print, or undefined for silence.
 *
 * Only the MANAGER's own refusal is relayed, and only when it changes. An operator watching
 * `reconnecting` for ten minutes cannot otherwise tell a sleeping laptop from a manager that is at
 * its session ceiling, and the ceiling is the one a person can act on. Repeating a steady refusal
 * on every attempt would bury it.
 *
 * A LOCAL failure to reach anything is deliberately silent: it is already what `connection lost,
 * reconnecting` says, and the copy on this path is written for someone who just typed a command
 * ("no mesh running at X - run `cotal up`"), which is the wrong thing to tell someone whose wifi
 * dropped.
 */
export function reconnectNotice(est: { fromManager?: true; message: string }, alreadySaid: string): string | undefined {
  if (!est.fromManager || est.message === alreadySaid) return undefined;
  return `[cotal: ${est.message}]`;
}

/**
 * The line an exit owes an operator about sessions this attach could not hand back, or nothing.
 *
 * Suppressed on `gone`, and that is not tidiness. That verdict exists because the manager answered
 * `not-found`, which it only answers once the seat has been freed, and freeing a seat ends every
 * session bound to it (`freeSlot` into `endForTarget`, on despawn, self-stop, reap and natural exit
 * alike). The sessions this would name have already been collected, so naming them would be
 * inventing work for someone who is about to close their terminal.
 */
export function heldSessionNotice(pending: number, verdict: AttachVerdict["kind"]): string | undefined {
  if (pending < 1 || verdict === "gone") return undefined;
  const what = pending === 1 ? "a session" : `${pending} sessions`;
  return `[cotal: the manager still holds ${what} from the lost link; each frees when the seat or the manager ends it]`;
}

/**
 * Ask the manager for a session and open it: a FRESH grant, a FRESH per-session caller credential,
 * a FRESH connection, every time. Nothing is carried over from a previous attempt, so a reconnect
 * re-runs the manager's whole authorization path (`serveGated` → `authorizeNamed` → a one-use
 * holder-bound grant with its own TTL) exactly as the first attach did. A revoked or expired grant
 * cannot be kept alive by reconnecting, because no grant is ever presented twice.
 */
async function establishAttachSession(
  v: FlagValues<typeof attachFlags>,
  on: string | undefined,
  reconnect: boolean,
  first: boolean,
): Promise<Established> {
  // A reconnect must never cross a path that can END THE PROCESS. The mesh resolve and its
  // preflight are written to do exactly that ("no mesh running at X - run `cotal up`"), which is
  // the right answer for a person who just typed a command and the wrong one for a link that is
  // coming back. So a RE-ESTABLISHMENT asks for the throwing form and treats the refusal as the
  // transient it is.
  //
  // Keyed off `first`, NOT off the reconnect flag, and the difference is user-visible. A refusal
  // that escapes as an exception is rendered by the dispatcher's generic handler, which prints
  // `✗ ${message}` over a sentence that already opens with `✗` and drops the refusal's hint line.
  // The reconnect flag is on by DEFAULT, so keying on it sent the very first attach down that path
  // and turned today's "no mesh running at X - run `cotal up`" into a double mark with no remedy.
  // The first attempt is not a re-establishment and has nothing to survive for.
  //
  // `pinForTarget` is deliberately not crossed here: seat locality is resolved ONCE, before the
  // loop, and the pin is carried in. It is the other step on this path that exits.
  // Same reach routing as stop: static mesh → any-mode on the `control-caller-admin` instrument;
  // user mesh → the operator's own bearer with owner reach, the manager deciding (own owner-domain
  // passes with "spawn", cross-owner needs ledger "admin").
  const t = await resolveControlTarget(v, "control-caller-admin", on, first ? {} : { onRefusal: "throw" });
  const reach = t.auth.bearer ? "owner" : "any";
  const reply = await askManager(t.space, t.server, "attach", { name: v.name }, t.auth, reach, undefined, { instanceId: on });
  if (!reply.ok) return { ok: false, kind: attachRefusal(reply.code), message: reply.error ?? "error", fromManager: true };
  // P2 item 6: the reply is the holder-bound §13.6 session GRANT (no ws:// URL). Redeem it over the
  // mesh — mint a per-session, rails-only caller cred from the local space seed, connect, and drive
  // the terminal through the session rail. USER mesh (bearer, no local seed): refuse LOUD — the
  // 2-step user-mode redemption callout is the #29 follow-up, deliberately not wired here.
  const { grant } = reply.data as { grant: SessionGrant };
  const auth = loadSpaceAuth(authDir(findCotalRoot()), t.space);
  if (!auth)
    return {
      ok: false, kind: "fatal",
      message: "mesh attach needs the local space seed (static auth mesh); user-mode session redemption is the #29 callout follow-up, not wired yet",
    };
  const id = newIdentity();
  const creds = await mintCreds(auth, id, "session-caller", {
    sessionCaller: { endpoint: grant.endpoint, sessionId: grant.sessionId, epoch: grant.serving.epoch },
    expiresAt: Math.floor(grant.exp / 1000), // grant.exp is ms (now+ttlMs); the JWT exp is seconds
  });
  // maxReconnectAttempts is the whole difference between the two modes, and it is deliberate.
  // ONE-SHOT keeps the old -1: the NATS layer redials forever under a single session.
  // RECONNECTING uses 0, because that redial is what breaks the attach rather than saving it — the
  // session is already dead by the time the link comes back (the serving rail either kept
  // advancing `seq` into a subject nobody was subscribed to, so the restored subscription faults
  // with `gap`, or it stalled out and closed while this side was away, so nothing ever arrives
  // again). Owning re-establishment here means the link coming back produces a real session with a
  // real repaint, instead of a restored socket over a session that ended without us.
  const nc = await connect({
    servers: t.server,
    ...standaloneConnectOpts({ creds, tls: false }),
    inboxPrefix: `_INBOX_${id.id}`,
    maxReconnectAttempts: reconnect ? 0 : -1,
    // Detection latency is part of the defect, not a detail of it. A laptop waking from sleep does
    // not always get a socket error: the connection can sit half-open, and on the stock two-minute
    // ping with two misses the client would not learn its link was dead for about four minutes,
    // with the terminal frozen the whole time. Ten seconds puts that in tens of seconds. Only on
    // the reconnecting path, so `--no-reconnect` keeps today's timing along with today's exit.
    //
    // NOT MEASURED by this change's suite, and said so rather than implied: the smoke severs the
    // link by destroying sockets, so every number it prints is close detection. A fault model that
    // half-opens a link is what would grade this line, and it does not exist here yet.
    ...(reconnect ? { pingInterval: 10_000 } : {}),
  });
  return { ok: true, nc, grant, creds, inbox: id.id, server: t.server };
}

/** A session this side can no longer reach, plus the one credential that can still speak for it. */
type Abandoned = { grant: SessionGrant; creds: string; inbox: string; server: string };

/**
 * Tell the manager a session is over, so it gets its slot back.
 *
 * NOTHING on the serving side reaps a session whose caller went away while the seat is quiet: the
 * rail's stall watchdog only arms once the send window FILLS (`endpoint-session-rail.ts`), an idle
 * seat never fills it, and the bridge has no expiry timer of its own. Measured against a manager
 * with an idle seat: 45s of dead link left the live-session count at 1, and the reconnect took it
 * to 2 — one slot per outage, held until the seat or the manager ends it, against a ceiling of 64.
 *
 * The mechanism is the advisory close frame the rail already defines; the manager's bridge ends on
 * it. It has to be published with THIS session's caller credential, the only one scoped to this
 * session's subjects, so a re-establishment cannot send it on the abandoned session's behalf — a
 * fresh session's credential covers a fresh session's subjects. Hence a short-lived connection
 * minted from the credential the abandoned session already had.
 */
async function releaseAbandonedSession(s: Abandoned): Promise<void> {
  const nc = await connect({
    servers: s.server,
    ...standaloneConnectOpts({ creds: s.creds, tls: false }),
    inboxPrefix: `_INBOX_${s.inbox}`,
    maxReconnectAttempts: 0,
    timeout: LINK_DEADLINE_MS,
    // The same short ping the reconnecting session uses. This connection exists BECAUSE a link died,
    // so it is the last one that should be left waiting on the stock two-minute heartbeat to find
    // out that the replacement died too.
    pingInterval: 10_000,
  });
  try {
    // The rail is opened only because `close()` is the public way to speak the framing; no timers,
    // and it tears itself down on the same call.
    openSessionRail({ nc, grant: s.grant, role: "caller", onData: () => {}, idleCreditMs: 0, stallTimeoutMs: 0 }).close();
    // Throwing is what keeps the record: the caller holds the session until a flush RETURNS.
    if (!(await flushed(nc))) throw new Error(`the close frame for session ${s.grant.sessionId} never left`);
  } finally {
    await closeLink(nc);
  }
}

/** Watch stdin for the detach key while there is NO session reading it. Without this the key is
 *  dead for as long as a reconnect takes, which is exactly when an operator is most likely to give
 *  up and press it. Non-detach keystrokes are dropped: there is no seat to send them to, and
 *  buffering them would replay a burst into the agent on reconnect. */
function watchDetachKey(byte: number): { pressed: Promise<void>; stop: () => void } {
  const stdin = process.stdin;
  let hit!: () => void;
  const pressed = new Promise<void>((r) => { hit = r; });
  const onData = (d: Buffer) => { if (d.length === 1 && d[0] === byte) hit(); };
  stdin.on("data", onData);
  stdin.resume();
  return { pressed, stop: () => { stdin.off("data", onData); stdin.pause(); } };
}

/**
 * The attach loop. One session at a time; when the LINK breaks and the operator did not detach, it
 * re-establishes with backoff and keeps going, because the seat is still there and the terminal the
 * operator walked away from should still be theirs when they come back.
 */
async function runAttachLoop(
  vv: FlagValues<typeof attachFlags>,
  pin: string | undefined,
  reconnect: boolean,
  key: ReturnType<typeof detachKey>,
  hold: TerminalHold,
): Promise<AttachVerdict> {
  let first = true;
  let attempt = 0; // consecutive re-establishment attempts since the last live session
  // Sessions the manager still counts, waiting to be told. A LIST rather than one slot: a second
  // link death before the first hand-back lands would overwrite the first and leak it with nothing
  // said. It cannot grow without bound, because every entry needed a successful establishment, and
  // successful establishments are exactly what the manager's own session ceiling counts.
  const abandoned: Abandoned[] = [];
  let saidWhy = ""; // the last transient refusal printed, so a steady reason prints once, not per attempt
  // Every exit runs through here, so the one thing an operator cannot see for themselves is never
  // swallowed. What to say, and when to say nothing, is `heldSessionNotice`.
  const done = (v: AttachVerdict): AttachVerdict => {
    const notice = heldSessionNotice(abandoned.length, v.kind);
    if (notice) console.error(c.dim(notice));
    return v;
  };
  for (;;) {
    if (!first) {
      // Back off BEFORE the attempt, and stay interruptible: the detach key must work while we
      // wait, not only while a session is up.
      const wait = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      const watch = watchDetachKey(key.byte);
      const detached = await Promise.race([sleep(wait).then(() => false), watch.pressed.then(() => true)]);
      watch.stop();
      if (detached) return done({ kind: "ended" });
      attempt++;
    }
    // Give the manager its slots back BEFORE claiming another one. The order is load-bearing at the
    // ceiling: a client that claims first is refused by the very sessions it abandoned. Oldest
    // first, and one failure ends the round rather than skipping ahead, because the reason is the
    // link and the link is the same for all of them. A failure is retried on the next attempt and
    // accounted for by `done` if it never lands.
    while (abandoned.length > 0) {
      try {
        await releaseAbandonedSession(abandoned[0]);
        abandoned.shift();
      } catch { break; }
    }
    let est: Established;
    try {
      est = await establishAttachSession(vv, pin, reconnect, first);
    } catch (e) {
      // The FIRST attempt throws exactly as it always has — the CLI's top-level handler renders
      // it. Only a reconnect turns a thrown establishment into another attempt.
      if (first) throw e;
      est = { ok: false, kind: "transient", message: (e as Error).message };
    }
    if (!est.ok) {
      // Nothing changes for the first attach: any refusal is the same loud exit as before.
      if (first || est.kind === "fatal" || est.kind === "denied") return done({ kind: "failed", message: est.message });
      if (est.kind === "gone") return done({ kind: "gone" });
      const notice = reconnectNotice(est, saidWhy);
      if (notice) {
        saidWhy = est.message;
        console.error(c.dim(notice));
      }
      continue; // transient: the manager or the link is unreachable right now
    }
    saidWhy = "";
    if (first) console.error(c.dim(`attached to ${vv.name} - ${key.label} to detach`));
    else console.error(c.dim("[cotal: reconnected]"));
    first = false;
    let outcome;
    const startedAt = Date.now();
    const transport = meshSessionTransport(est.nc, est.grant);
    try {
      // The manager replays its byte-exact backlog snapshot on every open (the `ready` handshake
      // in session/bridge.ts), so the reconnected screen repaints through the path that already
      // exists; there is no second backlog here.
      outcome = await attachClient(transport, hold);
    } finally {
      // Hand the session back. With the link still up that is one advisory frame over the
      // connection already open (a rail that broke while the socket lived — a stall, a gap — is
      // exactly this case, and it is idempotent after a detach has already closed it). The FLUSH is
      // what decides whether it left, not the publish: a link can die between the closed-check and
      // the frame, which is the same slow death this whole change is about. Only a flush that
      // returned counts as handed back; anything else keeps the credential for the next attempt,
      // and see releaseAbandonedSession for why no other credential can carry it.
      let handedBack = false;
      if (!est.nc.isClosed()) {
        transport.close();
        handedBack = await flushed(est.nc);
      }
      if (!handedBack && reconnect) {
        abandoned.push({ grant: est.grant, creds: est.creds, inbox: est.inbox, server: est.server });
      }
      await closeLink(est.nc);
    }
    // The backoff resets on a session that WORKED, not on one that merely opened. `carried` is not
    // enough on its own: a seat that has produced nothing has an empty backlog snapshot, so a
    // perfectly healthy attach to a QUIET agent would never reset and would climb to the 30s cap
    // over a few blips, which is the seat this whole change cares most about. A session that simply
    // lasted is the other half of the same question.
    if (outcome.carried || Date.now() - startedAt >= SESSION_WORKED_MS) attempt = 0;
    if (!reconnect) {
      // One-shot: a faulted session still throws, so `--no-reconnect` exits the way it does today.
      if (outcome.error) throw outcome.error;
      return done({ kind: "ended" });
    }
    if (!isTransportEnd(outcome.reason)) {
      // A faulted end this classification does not recognise is NOT a detach. Printing
      // `detached from` over it would be the silent swallow this whole change exists to remove,
      // so it exits non-zero carrying the fault. Every `fireEnd` site passes a reason today, so
      // this is a guard against a future one that forgets, not a live path.
      if (outcome.error) return done({ kind: "failed", message: outcome.error.message });
      return done({ kind: "ended" });
    }
    console.error(c.dim("[cotal: connection lost, reconnecting]"));
  }
}

/** How the attach finished, decided inside the loop and acted on outside it — so the terminal is
 *  always given back before anything prints or exits. */
type AttachVerdict = { kind: "ended" } | { kind: "gone" } | { kind: "failed"; message: string };

export async function attach(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof attachFlags>;
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reconnecting = v["no-reconnect"] !== true;
  // Seat-locality first, exactly as `stop` does it: attaching to a seat means reaching the process,
  // which only its host manager has. Resolved ONCE — the seat does not move between reconnects, and
  // a manager that stops answering is a transient the loop already retries through.
  const on = await pinForTarget(v as never, "cotal attach");
  const detach = detachKey();
  const hold = holdTerminal();
  let verdict: AttachVerdict;
  try {
    verdict = await runAttachLoop(v, on, reconnecting, detach, hold);
  } finally {
    // The terminal comes back before anything else happens, whatever ended the attach — including
    // a throw out of the one-shot path, which is how `--no-reconnect` keeps its old exit.
    hold.restore();
  }
  if (verdict.kind === "failed") {
    console.error(c.red(`✗ ${verdict.message}`));
    process.exit(1);
  }
  if (verdict.kind === "gone") {
    console.error(c.dim(`\nseat ${v.name} is gone`));
    return;
  }
  console.error(c.dim(`\ndetached from ${v.name}`));

}

/**
 * `cotal input --name <seat> --text <text> [--no-enter]`: deliver one line of text into a running
 * seat's terminal, as if a human had typed it. The command an external control surface needs that
 * `attach` cannot be: `attach` is a stream that holds a session and wants a pty on this side, and a
 * web request has neither.
 *
 * Routing is `attach`'s, unchanged: the seat-locality pin first (only the manager HOSTING the seat
 * can type into it), then the reach that mesh mode implies. Nothing is echoed back - the caller
 * reads the resulting turns from the event plane or the transcript, so this prints only what was
 * delivered.
 */
export async function input(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof inputFlags>;
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  // An EMPTY --text is refused here rather than sent: the op's contract requires a non-empty
  // string, so sending it would spend a round trip to be told the same thing in a contract error
  // that names a schema instead of the flag the operator got wrong. `v.text === undefined` (flag
  // omitted) and `""` (flag given, empty) are the same mistake to the caller, so one message.
  if (!v.text) {
    console.error(c.red("--text is required and must not be empty"));
    process.exit(1);
  }
  const on = await pinForTarget(v as never, "cotal input");
  const t = await resolveControlTarget(v, "control-caller-admin", on);
  const reach = t.auth.bearer ? "owner" : "any";
  const reply = await askManager(t.space, t.server, "input", { name: v.name, text: v.text, enter: v["no-enter"] !== true }, t.auth, reach, undefined, { instanceId: on });
  failIfNotOk(reply);
  const { name, bytes } = reply.data as { name: string; bytes: number };
  console.log(c.dim(`✓ sent ${bytes} bytes to ${name}`));
}
