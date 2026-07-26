import { CONTROL_ADMIN, CONTROL_PRIVILEGED, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
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
  // STATIC mesh: operator stop is a cross-agent op — the admin tier with the scoped
  // `control-caller-admin` cred (holding ONLY the admin-subject publish; that cred IS the
  // cross-agent authority, the manager honors any named target on it).
  // USER mesh: ONE deterministic path — the op rides the operator's own bearer on the SPAWN
  // (privileged) tier, and the MANAGER authorizes: agents under your own owner pass with scope
  // "spawn" (owner-domain), another owner's agent needs "admin" on your ledger row. No
  // client-side try-admin-then-privileged fallback; sending on ctl.admin would die at the
  // broker for every spawn-scoped operator before the manager could decide anything.
  const t = await resolveControlTarget(v, "control-caller-admin");
  const tier = t.auth.bearer ? CONTROL_PRIVILEGED : CONTROL_ADMIN;
  const reply = await askManager(t.space, t.server, "stop", { name: v.name }, t.auth, tier);
  failIfNotOk(reply);
  // User mesh: a stop IS a grant revoke (rows are runtime grants — a non-running agent holds no
  // standing mint secret); a respawn re-grants automatically. Say so, so the operator's
  // restart-vs-revoke model is visible at the command, not inferred from docs.
  console.log(c.dim(`✓ stopped ${v.name}${t.auth.bearer ? " - its actor grant is revoked; a respawn re-grants automatically" : ""}`));
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
  // Same tier routing as stop: static mesh → admin tier on the scoped `control-caller-admin`
  // cred; user mesh → the operator's own bearer on the SPAWN tier, with the manager deciding
  // (own owner-domain passes with "spawn", cross-owner needs ledger "admin").
  const t = await resolveControlTarget(v, "control-caller-admin");
  const tier = t.auth.bearer ? CONTROL_PRIVILEGED : CONTROL_ADMIN;
  const reply = await askManager(t.space, t.server, "attach", { name: v.name }, t.auth, tier);
  failIfNotOk(reply);
  const { ws } = reply.data as { ws: string };
  console.error(c.dim(`attached to ${v.name} - ${detachKey().label} to detach`));
  await attachClient(dialableAttachUrl(ws, t.server));
  console.error(c.dim(`\ndetached from ${v.name}`));
}

/** Hosts that only ever mean "this machine", so a manager advertising one has told us nothing about
 *  where IT is. */
const SELF_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/**
 * The attach URL to actually dial.
 *
 * The manager advertises the host it was told to bind, but it cannot always name an address the
 * CLIENT can reach: bound to a wildcard it has no single dialable name and falls back to loopback,
 * and loopback means *this* machine, which for a remote manager is the wrong box entirely (the
 * original ECONNREFUSED). The client, though, does know one address that provably works — the
 * broker address its own control connection just used to ask this question. So when the manager
 * advertises a self-only host and we reached the mesh somewhere else, dial there instead. Port,
 * path, and the capability token are preserved untouched.
 *
 * A manager that named a real host is left alone: it may legitimately sit somewhere other than its
 * broker, and it knows its own address better than we do.
 */
export function dialableAttachUrl(ws: string, server: string): string {
  const u = new URL(ws);
  if (!SELF_HOSTS.has(u.hostname)) return ws;
  const brokerHost = new URL(server.split(",")[0].trim()).hostname;
  if (!brokerHost || SELF_HOSTS.has(brokerHost)) return ws;
  u.hostname = brokerHost;
  return u.toString();
}
