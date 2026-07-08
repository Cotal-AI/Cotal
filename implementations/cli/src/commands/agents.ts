import { CONTROL_ADMIN, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
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
export const psFlags = [...targetFlags] as const satisfies readonly FlagSpec[];
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
  // Operator stop is a cross-agent (admin) op — the CLI operator isn't the agent's spawner, so the
  // privileged subject would reject it; the admin tier reaches any agent. The scoped
  // `control-caller-admin` cred holds ONLY `ctl.<admin>.<id>` (that IS the cross-agent authority —
  // the manager doesn't re-check the caller), so it reaches this op and nothing else.
  const t = await resolveControlTarget(v, "control-caller-admin");
  const reply = await askManager(t.space, t.server, "stop", { name: v.name }, t.auth, CONTROL_ADMIN);
  failIfNotOk(reply);
  // User mesh: a stop IS a grant revoke (rows are runtime grants — a non-running agent holds no
  // standing mint secret); a respawn re-grants automatically. Say so, so the operator's
  // restart-vs-revoke model is visible at the command, not inferred from docs.
  console.log(c.dim(`✓ stopped ${v.name}${t.auth.bearer ? " — its actor grant is revoked; a respawn re-grants automatically" : ""}`));
}

export async function ps(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof psFlags>;
  const t = await resolveControlTarget(v, "control-caller-privileged");
  const reply = await askManager(t.space, t.server, "ps", undefined, t.auth);
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
  // Operator attach is a cross-agent (admin) op — same reasoning as stop (the operator isn't the
  // spawner; admin reaches any agent). Scoped `control-caller-admin`: ctl.<admin> only.
  const t = await resolveControlTarget(v, "control-caller-admin");
  const reply = await askManager(t.space, t.server, "attach", { name: v.name }, t.auth, CONTROL_ADMIN);
  failIfNotOk(reply);
  const { ws } = reply.data as { ws: string };
  console.error(c.dim(`attached to ${v.name} — ${detachKey().label} to detach`));
  await attachClient(ws);
  console.error(c.dim(`\ndetached from ${v.name}`));
}
