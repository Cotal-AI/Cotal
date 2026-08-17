import { mintCreds, newIdentity, standaloneConnectOpts, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs, type SessionGrant } from "@cotal-ai/core";
import { authDir, findCotalRoot, loadMeshes, loadSpaceAuth, targetFlags } from "@cotal-ai/workspace";
import { connect } from "@nats-io/transport-node";
import { c } from "../ui.js";
import { askManager, scatterManager, failIfNotOk, resolveControlTarget, onInstanceOrExit, type ScatterInstanceLiveness } from "../lib/control.js";
import { attachClient, detachKey, meshSessionTransport } from "../lib/attach-client.js";
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
export const attachFlags = [...targetFlags, nameFlag("managed agent to attach to (required)"), onFlag] as const satisfies readonly FlagSpec[];

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
  mesh: string;
  authHealth?: string;
  authReason?: string;
};

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
  // The honest error #383 asked for: name the search, not just the absence.
  const missed = loc.unreachable.length
    ? ` ${loc.unreachable.length} manager instance(s) did not answer (${loc.unreachable.join(", ")}), so it may be hosted by one of those: retry, or \`${verb} --on <instance>\` (the whole id, as printed) if you know where it is.`
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

/** Render one managed-agent row (status + optional auth-health line), indented for the per-manager
 *  grouping a class scatter prints. */
function printAgentRow(r: AgentRow, indent = ""): void {
  const status =
    r.mesh === "absent"
      ? c.yellow("starting…")
      : r.mesh === "offline"
        ? c.dim("offline")
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
    )}  ${status}${r.authHealth ? "  " + authColor(r.authHealth) : ""}`,
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

export async function attach(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof attachFlags>;
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  // Same reach routing as stop: static mesh → any-mode on the `control-caller-admin` instrument;
  // user mesh → the operator's own bearer with owner reach, the manager deciding (own owner-domain
  // passes with "spawn", cross-owner needs ledger "admin").
  // Same seat-locality rule as stop, and it matters more here: attaching to a seat means reaching
  // the process, which only its host manager has.
  const on = await pinForTarget(v as never, "cotal attach");
  const t = await resolveControlTarget(v, "control-caller-admin", on);
  const reach = t.auth.bearer ? "owner" : "any";
  const reply = await askManager(t.space, t.server, "attach", { name: v.name }, t.auth, reach, undefined, { instanceId: on });
  failIfNotOk(reply);
  // P2 item 6: the reply is the holder-bound §13.6 session GRANT (no ws:// URL). Redeem it over the
  // mesh — mint a per-session, rails-only caller cred from the local space seed, connect, and drive
  // the terminal through the session rail. USER mesh (bearer, no local seed): refuse LOUD — the
  // 2-step user-mode redemption callout is the #29 follow-up, deliberately not wired here.
  const { grant } = reply.data as { grant: SessionGrant };
  const auth = loadSpaceAuth(authDir(findCotalRoot()), t.space);
  if (!auth) {
    console.error(c.red("mesh attach needs the local space seed (static auth mesh); user-mode session redemption is the #29 callout follow-up, not wired yet"));
    process.exit(1);
  }
  const id = newIdentity();
  const creds = await mintCreds(auth, id, "session-caller", {
    sessionCaller: { endpoint: grant.endpoint, sessionId: grant.sessionId, epoch: grant.serving.epoch },
    expiresAt: Math.floor(grant.exp / 1000), // grant.exp is ms (now+ttlMs); the JWT exp is seconds
  });
  const nc = await connect({ servers: t.server, ...standaloneConnectOpts({ creds, tls: false }), inboxPrefix: `_INBOX_${id.id}`, maxReconnectAttempts: -1 });
  console.error(c.dim(`attached to ${v.name} - ${detachKey().label} to detach`));
  try {
    await attachClient(meshSessionTransport(nc, grant));
  } finally {
    await nc.drain().catch(() => nc.close());
  }
  console.error(c.dim(`\ndetached from ${v.name}`));
}

