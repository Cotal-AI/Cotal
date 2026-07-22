import { type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { loadMeshes, targetFlags } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { askManager, failIfNotOk, resolveControlTarget } from "../lib/control.js";
import { attachClient, detachKey } from "../lib/attach-client.js";
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

export async function ps(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof psFlags>;
  const t = await resolveControlTarget(v, "control-caller-privileged");
  // `--on <instance>`: pin ps to one manager instance (P2 item 3 multi-manager). Default = class
  // anycast (whichever instance answers). A class scatter that merges every instance's rows is a
  // follow-up on the scatter primitive (freezeExpectedSet); today ps is per-instance / anycast.
  const reply = await askManager(t.space, t.server, "ps", undefined, t.auth, "owner", undefined, v.on);
  failIfNotOk(reply);
  const rows =
    (reply.data as Array<{
      name: string;
      role?: string;
      agent: string;
      mode: string;
      mesh: string;
      authHealth?: string;
      authReason?: string;
    }>) ?? [];
  if (!rows.length) {
    console.log(c.dim("(no managed agents)"));
    return;
  }
  for (const r of rows) {
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
      `${c.bold(r.name)}${r.role ? c.dim("/" + r.role) : ""}  ${c.dim(
        r.agent + " · " + r.mode,
      )}  ${status}${r.authHealth ? "  " + authColor(r.authHealth) : ""}`,
    );
    // The detached agent's ONLY operator window into a failing bearer refresh: the provider
    // command's operator-exact sentence, verbatim (it already names the repair).
    if (r.authHealth && r.authReason) console.log(authColor(`    ${r.authReason}`));
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
  const { ws } = reply.data as { ws: string };
  console.error(c.dim(`attached to ${v.name} - ${detachKey().label} to detach`));
  await attachClient(ws);
  console.error(c.dim(`\ndetached from ${v.name}`));
}
