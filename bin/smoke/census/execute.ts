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
import { ownersOf, parseOwner, type CommandOwner, type OwnerMap } from "./owners.js";

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
 * Conversely, the invocation selects one owner: its command, its mode and the path flags it passes,
 * where a path flag is one that a current endpoint-command row of the command names. `ps --slots`
 * selects `current:ps --slots`, and `run ps --local`, which reads the run stores directly, selects
 * an owner no row names. The endpoint-command rows of that owner are alternatives, so at least one
 * of them must have been issued: `invoke` issues the endpoint command its arguments name, and a
 * step that runs only on refusal (`abort-preservation`) is not issued when the operation succeeds.
 * An item that more than one entry point issues lists each owner, and each selects it.
 */
export function executionProblems(run: Invocation, observed: readonly ObservedRequest[], map: OwnerMap, steps: readonly string[] = []): string[] {
  const problems: string[] = [];
  const label = [run.command, ...run.words, ...run.flags].join(" ");
  const current = (item: string) =>
    ownersOf(map, item).flatMap((owner) => {
      const parsed = parseOwner(owner);
      return typeof parsed === "object" && parsed.state === "current" ? [parsed] : [];
    });
  const ownedHere = (item: string) => current(item).some((owner) => owner.command === run.command);
  const shown = (item: string) => ownersOf(map, item).join(" or ") || "missing";
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
    if (!ownedHere(item)) problems.push(`cotal ${label} issued ${req.endpoint} ${req.command}, whose owner is ${shown(item)}`);
    for (const field of new Set(req.fields.map((f) => fieldItem(item, f))))
      if (!ownedHere(field))
        problems.push(`cotal ${label} sent ${req.endpoint} ${req.command} field ${field.slice(item.length + 1)}, whose owner is ${shown(field)}`);
  }
  const commandRows = Object.keys(map.owners).filter((item) => /^ep:[^:]+:[^.@#]+$/.test(item));
  const ofCommand = (item: string) => current(item).filter((owner) => owner.command === run.command);
  const pathFlags = new Set(commandRows.flatMap((item) => ofCommand(item).flatMap((owner) => owner.flags)));
  const selected = run.flags.filter((flag) => pathFlags.has(flag));
  const selects = (owner: CommandOwner) =>
    owner.words.join(" ") === run.words.join(" ") && owner.flags.length === selected.length && selected.every((flag) => owner.flags.includes(flag));
  const required = commandRows.filter((item) => ofCommand(item).some(selects));
  if (required.length > 0 && !required.some((item) => issued.has(item)))
    problems.push(`cotal ${label} issued none of the rows owned by ${["current:" + run.command, ...run.words, ...selected].join(" ")}: ${required.join(", ")}`);
  return problems;
}
