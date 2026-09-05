/**
 * The GENERIC v0.4 endpoint commands (P2 item 1, item 5): `cotal describe <endpoint>` resolves a
 * registered service's command surface off the wire — the reserved `describe` command + the §13.7
 * content-addressed contract store, digest-verified end to end — and `cotal invoke <endpoint>
 * <command>` calls one command by name with JSON args. Neither imports any endpoint's contract
 * module: the schemas come from the store, recompiled and digest-checked against the registered
 * declaration (the same trust chain every migrated control consumer rides).
 *
 * Static instruments and user-mode bearers both carry the ep-rail caller rows. An open mesh has no
 * service registry to describe against.
 */
import {
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  dialerFor,
  invokeCommand,
  resolveService,
  standaloneConnectOpts,
  type CompletionResult,
  type EpVerbTarget,
  type FlagSpec,
  type FlagValues,
  type ParsedArgs,
  type ResolvedService,
} from "@cotal-ai/core";
import { type NatsConnection } from "@nats-io/transport-node";
import { loadMeshes, targetFlags } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { resolveControlTarget, type ControlAuth } from "../lib/control.js";

export const describeFlags = [...targetFlags] as const satisfies readonly FlagSpec[];

export const invokeFlags = [
  ...targetFlags,
  { name: "args", type: "string", value: "<json>", description: "command arguments as a JSON object" },
  { name: "name", type: "string", value: "<agent>", description: "targeted commands: the managed agent to act on (resolved to its current principal via inspect)" },
  { name: "self", type: "boolean", description: "targeted commands: target this caller itself (authz-mode self)" },
  { name: "admin", type: "boolean", description: "use the admin instrument (cross-agent any-mode reach on targeted commands)" },
  { name: "timeout", type: "string", value: "<ms>", description: "reply deadline in milliseconds (default 10000)" },
] as const satisfies readonly FlagSpec[];

export function describeComplete(argv: string[]): CompletionResult {
  if (argv.some((a) => a === "--space")) return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  return { items: [{ value: BASELINE_LIFECYCLE_ENDPOINT }], directive: "nofiles" };
}

/** Open the ep-rail caller connection for a generic command, or exit with the exact boundary. */
async function epConnection(
  values: Record<string, unknown>,
  profile: "control-caller-privileged" | "control-caller-admin",
): Promise<{ nc: NatsConnection; space: string; auth: ControlAuth }> {
  const t = await resolveControlTarget(values as { space?: string; server?: string; creds?: string }, profile);
  if (!t.auth.epCaller || (!t.auth.creds && !(t.auth.bearer && t.auth.sentinelCreds))) {
    console.error(c.red("✗ the generic describe/invoke surface needs an auth mesh with endpoint caller rows"));
    console.error(c.dim("  open meshes have no service registry; sign in and grant the required user capability, or use a static-auth mesh"));
    process.exit(1);
  }
  const nc = await dialerFor(t.server)({
    servers: t.server,
    ...standaloneConnectOpts(t.auth.creds
      ? { creds: t.auth.creds, tls: t.auth.tls === true }
      : { bearer: t.auth.bearer!, sentinelCreds: t.auth.sentinelCreds!, tls: t.auth.tls === true }),
    maxReconnectAttempts: 0,
  });
  return { nc, space: t.space, auth: t.auth };
}

export async function describeCmd(args: ParsedArgs): Promise<void> {
  const endpoint = args.positionals[0];
  if (!endpoint) {
    console.error(c.red("✗ usage: cotal describe <endpoint>"));
    process.exit(1);
  }
  const { nc, space, auth } = await epConnection(args.values, "control-caller-privileged");
  try {
    const service = await resolveService(nc, space, endpoint, auth.epCaller!, { deadlineMs: 10_000 });
    console.log(`${c.bold(service.endpoint)}  ${c.dim(`owner ${service.owner} · instance ${service.responder.instanceId} · epoch ${service.responder.epoch}`)}`);
    const rows = [...service.commands.values()].sort((a, b) => a.command.localeCompare(b.command));
    const nameW = Math.max(...rows.map((r) => r.command.length));
    const capW = Math.max(...rows.map((r) => r.capability.length));
    for (const r of rows) {
      const shape = r.targeted ? `targeted (${r.modes.join(", ")})` : "untargeted";
      console.log(`  ${c.bold(r.command.padEnd(nameW))}  ${c.dim(r.capability.padEnd(capW))}  ${shape}`);
    }
    console.log(c.dim(`\n${rows.length} commands; contracts fetched from the §13.7 store and digest-verified against the registered declaration`));
  } catch (e) {
    console.error(c.red(`✗ ${e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message}`));
    process.exit(1);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

export async function invokeCmd(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof invokeFlags>;
  const [endpoint, command] = args.positionals;
  if (!endpoint || !command) {
    console.error(c.red("✗ usage: cotal invoke <endpoint> <command> [--args '<json>'] [--name <agent> | --self]"));
    process.exit(1);
  }
  let parsedArgs: Record<string, unknown> | undefined;
  if (v.args !== undefined) {
    try {
      const parsed: unknown = JSON.parse(v.args);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      parsedArgs = parsed as Record<string, unknown>;
    } catch (e) {
      console.error(c.red(`✗ --args must be a JSON object (${(e as Error).message})`));
      process.exit(1);
    }
  }
  const { nc, space, auth } = await epConnection(args.values, v.admin === true ? "control-caller-admin" : "control-caller-privileged");
  try {
    const service = await resolveService(nc, space, endpoint, auth.epCaller!, { deadlineMs: 10_000 });
    const target = await resolveTarget(nc, space, service, v);
    const deadlineMs = v.timeout !== undefined ? Number(v.timeout) : 10_000;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      console.error(c.red(`✗ --timeout must be a positive number of milliseconds (got "${v.timeout}")`));
      process.exit(1);
    }
    const r = await invokeCommand(nc, space, service, command, parsedArgs, { ...(target ? { target } : {}), deadlineMs });
    if (r.reply.ok !== true) {
      console.error(c.red(`✗ ${r.reply.error?.code ?? "error"}: ${r.reply.error?.message ?? "the command failed"}`));
      process.exit(1);
    }
    console.log(JSON.stringify(r.reply.data, null, 2));
  } catch (e) {
    console.error(c.red(`✗ ${e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message}`));
    process.exit(1);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** Build the §13.2 target block from the flags: `--self` is the caller itself; `--name` resolves
 *  a managed agent's alias to its CURRENT principal triple through the manager's name-keyed
 *  `inspect` (targets are (owner, actor, lifecycleUid), never an alias) and rides mode `any` on
 *  the admin instrument or `owner` on the privileged one — the same tier rule every migrated
 *  control call uses. `inspect` is in the spawn set, unlike the manager-wide `ps` enumeration, so
 *  authorized user-mode targeted calls do not require an unrelated manager.read grant. */
async function resolveTarget(
  nc: NatsConnection,
  space: string,
  service: ResolvedService,
  v: FlagValues<typeof invokeFlags>,
): Promise<EpVerbTarget | undefined> {
  if (v.self === true && v.name !== undefined) {
    console.error(c.red("✗ --self and --name are mutually exclusive"));
    process.exit(1);
  }
  if (v.self === true) return { mode: "self" };
  if (v.name === undefined) return undefined;
  if (service.endpoint !== BASELINE_LIFECYCLE_ENDPOINT) {
    console.error(c.red(`✗ --name resolves aliases through the manager's inspect; endpoint "${service.endpoint}" has no alias resolver yet`));
    process.exit(1);
  }
  const inspected = await invokeCommand(nc, space, service, "inspect", { name: v.name }, { deadlineMs: 10_000 });
  if (inspected.reply.ok !== true) {
    console.error(c.red(`✗ could not resolve "${v.name}": ${inspected.reply.error?.message ?? "inspect failed"}`));
    process.exit(1);
  }
  const row = inspected.reply.data as { id: string; lifecycleUid: string };
  const dot = row.id.indexOf(".");
  const [owner, actor] = dot > 0 ? [row.id.slice(0, dot), row.id.slice(dot + 1)] : [service.caller.owner, row.id];
  return {
    mode: v.admin === true || owner !== service.caller.owner ? "any" : "owner",
    owner,
    actor,
    lifecycleUid: row.lifecycleUid,
  };
}
