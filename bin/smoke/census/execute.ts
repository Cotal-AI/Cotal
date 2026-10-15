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

/** One endpoint request seen on the wire, with its input fields as dotted paths. */
export interface ObservedRequest {
  endpoint: string;
  command: string;
  fields: string[];
}

/** Every key of a JSON object, nested object keys included, as dotted paths. */
function fieldPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, sub]) => [prefix + key, ...fieldPaths(sub, `${prefix}${key}.`)]);
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
  return { endpoint: env.op.endpoint, command: env.op.command, fields: fieldPaths(env.args).sort() };
}

/** Every endpoint request published in `space`, on any plane, while `run` executes. */
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

/** One CLI invocation as the owner grammar names it: command, mode words and long flags. */
export interface Invocation {
  command: string;
  words: string[];
  flags: string[];
}

/** Flags that pick the target space or connection rather than the capability. */
const TARGET_FLAGS = new Set(["--space", "--server", "--creds"]);

/** The invocation an argv names: leading bare words are the mode, `--flags` outside the target set. */
export function invocationOf(argv: readonly string[]): Invocation {
  const [command, ...rest] = argv;
  const words: string[] = [];
  for (const token of rest) {
    if (token.startsWith("-")) break;
    words.push(token);
  }
  const flags = [...new Set(rest.filter((t) => t.startsWith("--") && !TARGET_FLAGS.has(t)).map((t) => t.split("=", 1)[0]!))];
  return { command: command!, words, flags };
}

/** The protocol's own resolution step, sent before any command; it is not a capability row. */
const PROTOCOL_COMMANDS = new Set(["describe"]);

/**
 * Why the requests one CLI invocation issued disagree with the owner map.
 *
 * Every issued command and input field must be owned by `current:<command>`, whatever mode or flag
 * the row adds, because a command can send a field on every run (a default) or issue a command as a
 * step of a larger operation. `steps` lists the endpoint commands this invocation issues as
 * resolution for another one (a targeted command looks its target up first); they are exempt.
 * Conversely, every endpoint command whose row names exactly this command, mode and flags must
 * have been issued.
 */
export function executionProblems(run: Invocation, observed: readonly ObservedRequest[], map: OwnerMap, steps: readonly string[] = []): string[] {
  const problems: string[] = [];
  const label = [run.command, ...run.words, ...run.flags].join(" ");
  const ownerOf = (item: string) => {
    const owner = map.owners[item];
    const parsed = owner === undefined ? undefined : parseOwner(owner);
    return typeof parsed === "object" && parsed.state === "current" ? parsed : undefined;
  };
  const issued = new Set<string>();
  for (const req of observed) {
    if (PROTOCOL_COMMANDS.has(req.command)) continue;
    const item = `ep:${req.endpoint}:${req.command}`;
    issued.add(item);
    if (steps.includes(item)) continue;
    if (ownerOf(item)?.command !== run.command) problems.push(`cotal ${label} issued ${req.endpoint} ${req.command}, whose owner is ${map.owners[item] ?? "missing"}`);
    for (const field of req.fields)
      if (ownerOf(`${item}.${field}`)?.command !== run.command)
        problems.push(`cotal ${label} sent ${req.endpoint} ${req.command} field ${field}, whose owner is ${map.owners[`${item}.${field}`] ?? "missing"}`);
  }
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  for (const item of Object.keys(map.owners)) {
    if (!/^ep:[^:]+:[^.@#]+$/.test(item)) continue;
    const owner = ownerOf(item);
    if (owner?.command === run.command && same(owner.words, run.words) && same(owner.flags, run.flags) && !issued.has(item))
      problems.push(`${item} is owned by current:${label} but cotal ${label} did not issue it`);
  }
  return problems;
}
