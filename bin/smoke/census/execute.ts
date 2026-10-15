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

/**
 * The invocation an argv names: the longest run of leading bare words that is a mode the command
 * declares (a `cli:<command> <mode>` row), so positional values are not mode words, and the
 * `--flags` outside the target set. A short flag is refused, since owner rows name long flags.
 */
export function invocationOf(argv: readonly string[], map: OwnerMap): Invocation {
  const [command, ...rest] = argv;
  const short = rest.find((t) => /^-[^-]/.test(t));
  if (short !== undefined) throw new Error(`write ${short} in its long form: owner rows name long flags`);
  const bare: string[] = [];
  for (const token of rest) {
    if (token.startsWith("-")) break;
    bare.push(token);
  }
  let words: string[] = [];
  for (let n = bare.length; n > 0 && words.length === 0; n--)
    if (`cli:${command} ${bare.slice(0, n).join(" ")}` in map.owners) words = bare.slice(0, n);
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
 * resolution for another one (a targeted command looks its target up first); they are exempt. A
 * field whose contract declares no properties (an options map, forwarded tool arguments) is one
 * value: the keys under it are data, not fields.
 *
 * Conversely, of the endpoint-command rows naming this command and mode with flags this invocation
 * passes, the most specific apply: `ps --slots` selects the `ps --slots` row rather than the bare
 * `ps` one. Rows that share one owner are alternatives, so at least one of them must have been
 * issued: `invoke` issues the endpoint command its arguments name, and a step that runs only on
 * refusal (`abort-preservation`) is not issued when the operation succeeds.
 */
export function executionProblems(run: Invocation, observed: readonly ObservedRequest[], map: OwnerMap, steps: readonly string[] = []): string[] {
  const problems: string[] = [];
  const label = [run.command, ...run.words, ...run.flags].join(" ");
  const ownerOf = (item: string) => {
    const owner = map.owners[item];
    const parsed = owner === undefined ? undefined : parseOwner(owner);
    return typeof parsed === "object" && parsed.state === "current" ? parsed : undefined;
  };
  const structured = new Set<string>();
  for (const key of Object.keys(map.owners))
    if (/^ep:[^@#]+$/.test(key)) for (let i = key.indexOf("."); i !== -1; i = key.indexOf(".", i + 1)) structured.add(key.slice(0, i));
  const fieldItem = (item: string, path: string) => {
    const parts = path.split(".");
    for (let n = 1; n < parts.length; n++) {
      const id = `${item}.${parts.slice(0, n).join(".")}`;
      if (id in map.owners && !structured.has(id)) return id;
    }
    return `${item}.${path}`;
  };
  const issued = new Set<string>();
  for (const req of observed) {
    if (PROTOCOL_COMMANDS.has(req.command)) continue;
    const item = `ep:${req.endpoint}:${req.command}`;
    issued.add(item);
    if (steps.includes(item)) continue;
    if (ownerOf(item)?.command !== run.command) problems.push(`cotal ${label} issued ${req.endpoint} ${req.command}, whose owner is ${map.owners[item] ?? "missing"}`);
    for (const field of new Set(req.fields.map((f) => fieldItem(item, f))))
      if (ownerOf(field)?.command !== run.command)
        problems.push(`cotal ${label} sent ${req.endpoint} ${req.command} field ${field.slice(item.length + 1)}, whose owner is ${map.owners[field] ?? "missing"}`);
  }
  const within = (a: readonly string[], b: readonly string[]) => a.every((x) => b.includes(x));
  const matching = Object.keys(map.owners).flatMap((item) => {
    const owner = /^ep:[^:]+:[^.@#]+$/.test(item) ? ownerOf(item) : undefined;
    const words = owner?.words.join(" ");
    return owner?.command === run.command && words === run.words.join(" ") && within(owner.flags, run.flags) ? [{ item, flags: owner.flags }] : [];
  });
  const alternatives = new Map<string, string[]>();
  for (const { item, flags } of matching) {
    if (matching.some((other) => other.flags.length > flags.length && within(flags, other.flags))) continue;
    const key = [...flags].sort().join(" ");
    alternatives.set(key, [...(alternatives.get(key) ?? []), item]);
  }
  for (const items of alternatives.values())
    if (!items.some((item) => issued.has(item)))
      problems.push(`cotal ${label} issued none of the rows owned by ${map.owners[items[0]!]}: ${items.join(", ")}`);
  return problems;
}
