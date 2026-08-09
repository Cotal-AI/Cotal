import { mintCreds, newIdentity, standaloneConnectOpts, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs, type SessionGrant } from "@cotal-ai/core";
import { authDir, findCotalRoot, loadMeshes, loadSpaceAuth, targetFlags } from "@cotal-ai/workspace";
import { connect } from "@nats-io/transport-node";
import { c } from "../ui.js";
import { askManager, scatterManager, failIfNotOk, resolveControlTarget } from "../lib/control.js";
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

export const stopFlags = [...targetFlags, nameFlag("managed agent to stop (required)")] as const satisfies readonly FlagSpec[];
export const psFlags = [...targetFlags, { name: "on", type: "string", value: "<instance>", description: "target a specific manager instance id (multi-manager space); default = class anycast" }] as const satisfies readonly FlagSpec[];
export const attachFlags = [...targetFlags, nameFlag("managed agent to attach to (required)")] as const satisfies readonly FlagSpec[];

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
  const t = await resolveControlTarget(v, "control-caller-admin");
  const reach = t.auth.bearer ? "owner" : "any";
  const reply = await askManager(t.space, t.server, "stop", { name: v.name }, t.auth, reach);
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
  const t = await resolveControlTarget(v, "control-caller-privileged");
  // `--on <instance>`: pin ps to ONE manager instance's `inst` route (P2 item 3 multi-manager) — a
  // single-manager view. Default = CLASS SCATTER: merge EVERY registered instance's rows below.
  if (v.on) {
    const reply = await askManager(t.space, t.server, "ps", undefined, t.auth, "owner", undefined, v.on);
    failIfNotOk(reply);
    const rows = (reply.data as AgentRow[]) ?? [];
    if (!rows.length) {
      console.log(c.dim("(no managed agents)"));
      return;
    }
    for (const r of rows) printAgentRow(r);
    return;
  }

  // DEFAULT CLASS SCATTER (P2 item 3): freeze the live class from the records registry, scatter `ps`
  // on the `all` rail, and merge with per-instance attribution. A non-answering instance is labeled
  // unreachable, NEVER silently omitted (pin 3).
  const scatter = await scatterManager(t.space, t.server, "ps", t.auth);
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
  for (const inst of instances) {
    const label = `manager ${inst.instanceId.slice(0, 8)}`;
    if (!inst.reachable) {
      console.log(`${c.bold(label)}  ${c.red("unreachable")}`);
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
  const t = await resolveControlTarget(v, "control-caller-admin");
  const reach = t.auth.bearer ? "owner" : "any";
  const reply = await askManager(t.space, t.server, "attach", { name: v.name }, t.auth, reach);
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
  const nc = await connect({ servers: t.server, ...standaloneConnectOpts({ creds }), inboxPrefix: `_INBOX_${id.id}`, maxReconnectAttempts: -1 });
  console.error(c.dim(`attached to ${v.name} - ${detachKey().label} to detach`));
  try {
    await attachClient(meshSessionTransport(nc, grant));
  } finally {
    await nc.drain().catch(() => nc.close());
  }
  console.error(c.dim(`\ndetached from ${v.name}`));
}

