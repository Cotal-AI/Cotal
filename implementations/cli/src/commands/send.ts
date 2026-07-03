import {
  resolvePeer,
  AmbiguousPeerError,
  type Presence,
  type CompletionResult,
  type ParsedArgs,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { openTransient } from "../lib/transient.js";
import { listDeclaredChannels, listDeclaredRoles } from "../lib/personas.js";
import { mentionsIn } from "../lib/mentions.js";

/**
 * One-shot send command — `cotal send <dm|msg|ask>` — the headless equivalent of the console's
 * `:dm` / `:msg` / `:ask`. The sub-verb picks the delivery mode (`unicast` / `multicast` /
 * `anycast`); each connects, sends one message, and exits. Fire-and-forget: no reply waiting.
 */

type SendValues = { space?: string; server?: string; creds?: string };

/** Split `<target> <text…>` positionals, stripping a leading `@`/`#` from the target. */
function targetAndText(positionals: string[], strip: RegExp): { target?: string; text: string } {
  return { target: positionals[0]?.replace(strip, ""), text: positionals.slice(1).join(" ").trim() };
}

/** `cotal send <dm|msg|ask> …` — dispatch one-shot send by delivery mode, then exit. */
export async function send(args: ParsedArgs): Promise<void> {
  const { values, positionals } = args;
  const [mode, ...rest] = positionals;
  if (mode === "dm") return dm(values, rest);
  if (mode === "msg") return msg(values, rest);
  if (mode === "ask") return ask(values, rest);
  console.error(
    'usage: cotal send <dm <agent> | msg <channel> | ask <role>> "<text>"  [--space <s>] [--server <url>] [--creds <path>]',
  );
  process.exit(1);
}

/** `cotal send dm <agent> "<text>"` — one unicast to a peer by name, then exit. */
async function dm(values: ParsedArgs["values"], positionals: string[]): Promise<void> {
  const { target, text } = targetAndText(positionals, /^@/);
  if (!target || !text) {
    console.error('usage: cotal send dm <agent> "<text>"  [--space <s>] [--server <url>] [--creds <path>]');
    process.exit(1);
  }
  const { ep, space } = await openTransient(values, "send");
  // Presence arrives asynchronously after connect; poll briefly (≤2s) for the target to appear.
  // resolvePeer is fail-loud: an exact id or a unique name resolves, a same-name collision throws.
  let peer: Presence | undefined;
  for (let i = 0; i < 20 && !peer; i++) {
    try {
      peer = resolvePeer(ep.getRoster(), target);
    } catch (e) {
      if (!(e instanceof AmbiguousPeerError)) throw e;
      console.error(c.red(`"${target}" is ambiguous — DM by instance id instead:`));
      for (const cand of e.candidates)
        console.error(c.dim(`  ${cand.name} (${cand.status})  ${cand.id}`));
      await ep.stop();
      process.exit(1);
    }
    if (!peer) await new Promise((r) => setTimeout(r, 100));
  }
  if (!peer) {
    console.error(c.red(`no agent "${target}" present in space ${space}`));
    await ep.stop();
    process.exit(1);
  }
  await ep.unicast(peer.card.id, text);
  console.log(c.green(`→ ${peer.card.name}`) + c.dim(`  ${text}`));
  await ep.stop();
}

/** `cotal send msg <channel> "<text>"` — one broadcast to a channel, then exit. */
async function msg(values: ParsedArgs["values"], positionals: string[]): Promise<void> {
  const { target: channel, text } = targetAndText(positionals, /^#/);
  if (!channel || !text) {
    console.error('usage: cotal send msg <channel> "<text>"  [--space <s>] [--server <url>] [--creds <path>]');
    process.exit(1);
  }
  const { ep } = await openTransient(values, "send");
  await ep.multicast(text, { channel, mentions: mentionsIn(text) });
  console.log(c.green(`→ #${channel}`) + c.dim(`  ${text}`));
  await ep.stop();
}

/** `cotal send ask <role> "<text>"` — one anycast to a role/service (exactly one instance), exit. */
async function ask(values: ParsedArgs["values"], positionals: string[]): Promise<void> {
  const { target: role, text } = targetAndText(positionals, /^@/);
  if (!role || !text) {
    console.error('usage: cotal send ask <role> "<text>"  [--space <s>] [--server <url>] [--creds <path>]');
    process.exit(1);
  }
  const { ep } = await openTransient(values, "send");
  await ep.anycast(role, text);
  console.log(c.green(`→ @${role}`) + c.dim(`  ${text}`));
  await ep.stop();
}

/** Complete `cotal send <dm|msg|ask> …`. Word 0 offers the sub-verbs; `msg`/`ask` then complete
 *  their target from the channels/roles the local persona files declare — never the live broker (a
 *  <TAB> stays offline by contract), and fail-closed (a malformed agent file makes the completer
 *  decline rather than offer a silently-partial set; see {@link listDeclaredChannels}). `dm` offers
 *  nothing: peer presence is live, so it can't be completed offline. */
export function sendComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1)
    return {
      items: [
        { value: "dm", description: "unicast to a peer" },
        { value: "msg", description: "broadcast to a channel" },
        { value: "ask", description: "anycast to a role" },
      ],
      directive: "nofiles",
    };
  const [mode, ...rest] = argv;
  if (mode === "msg" && rest.length <= 1)
    return {
      items: listDeclaredChannels().map((value) => ({ value, description: "declared channel" })),
      directive: "nofiles",
    };
  if (mode === "ask" && rest.length <= 1)
    return {
      items: listDeclaredRoles().map((value) => ({ value, description: "declared role" })),
      directive: "nofiles",
    };
  return { items: [], directive: "nofiles" };
}
