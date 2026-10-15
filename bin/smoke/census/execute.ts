/**
 * Capability census, execution half: run a CLI command against a real broker, record the endpoint
 * requests it publishes, and compare them with the owner map.
 *
 * A census row says which command performs an item. Reading the source can only check that the
 * named command and flags exist; running the command shows which native command and input fields
 * it actually sends, so a row that names the wrong command fails here.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import { spacePrefix } from "@cotal-ai/core";
import { parseOwner, type OwnerMap } from "./owners.js";

/** One endpoint request seen on the wire. */
export interface ObservedRequest {
  endpoint: string;
  command: string;
  fields: string[];
}

/** Request envelopes carry `v`, an `op` naming endpoint and command, and no reply outcome. */
function asRequest(data: Uint8Array): ObservedRequest | undefined {
  let env: { v?: unknown; ok?: unknown; op?: { endpoint?: unknown; command?: unknown }; args?: unknown };
  try {
    env = JSON.parse(new TextDecoder().decode(data)) as typeof env;
  } catch {
    return undefined;
  }
  if (env?.v === undefined || "ok" in env || typeof env.op?.endpoint !== "string" || typeof env.op.command !== "string") return undefined;
  const args = env.args && typeof env.args === "object" && !Array.isArray(env.args) ? env.args : {};
  return { endpoint: env.op.endpoint, command: env.op.command, fields: Object.keys(args).sort() };
}

/** Every endpoint request published in `space` while `run` executes. */
export async function observeRequests(nc: NatsConnection, space: string, run: () => Promise<void>): Promise<ObservedRequest[]> {
  const seen: ObservedRequest[] = [];
  const sub = nc.subscribe(`${spacePrefix(space)}.>`, {
    callback: (err, msg) => {
      if (err) return;
      const req = asRequest(msg.data);
      if (req) seen.push(req);
    },
  });
  await nc.flush();
  try {
    await run();
    await nc.flush();
  } finally {
    sub.unsubscribe();
  }
  return seen;
}

/** The protocol's own resolution step, sent before any command; it is not a capability row. */
const PROTOCOL_COMMANDS = new Set(["describe"]);

/**
 * Why the requests one CLI invocation issued disagree with the owner map. `run` is the command
 * name and the long flags the invocation passed. Every observed command and input field must be
 * owned by `current:<command>` with no flag outside `run`, and every endpoint command owned by
 * exactly `current:<command>` with flags inside `run` must have been issued.
 */
export function executionProblems(run: { command: string; flags: string[] }, observed: readonly ObservedRequest[], map: OwnerMap): string[] {
  const problems: string[] = [];
  const label = [run.command, ...run.flags].join(" ");
  const ownedByRun = (item: string): boolean => {
    const owner = map.owners[item];
    const parsed = owner === undefined ? undefined : parseOwner(owner);
    return typeof parsed === "object" && parsed.state === "current" && parsed.command === run.command && parsed.words.length === 0
      && parsed.flags.every((f) => run.flags.includes(f));
  };
  const issued = new Set<string>();
  for (const req of observed) {
    if (PROTOCOL_COMMANDS.has(req.command)) continue;
    const item = `ep:${req.endpoint}:${req.command}`;
    issued.add(item);
    if (!ownedByRun(item)) problems.push(`cotal ${label} issued ${req.endpoint} ${req.command}, whose owner is ${map.owners[item] ?? "missing"}`);
    for (const field of req.fields)
      if (!ownedByRun(`${item}.${field}`))
        problems.push(`cotal ${label} sent ${req.endpoint} ${req.command} field ${field}, whose owner is ${map.owners[`${item}.${field}`] ?? "missing"}`);
  }
  for (const item of Object.keys(map.owners)) {
    if (!/^ep:[^:]+:[^.@#]+$/.test(item) || !ownedByRun(item)) continue;
    if (!issued.has(item)) problems.push(`${item} is owned by current:${label} but cotal ${label} did not issue it`);
  }
  return problems;
}
