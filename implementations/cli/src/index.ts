import { registry, type Command } from "@cotal-ai/core";
import { up } from "./commands/up.js";
import { down } from "./commands/down.js";
import { setup, go } from "./commands/setup.js";
import { join } from "./commands/join.js";
import { watch } from "./commands/watch.js";
import { console_ } from "./commands/console.js";
import { demo } from "./commands/demo.js";
import { web } from "./commands/web.js";
import { spawn, spawnComplete } from "./commands/spawn.js";
import { personas, personasComplete } from "./commands/personas.js";
import { completion, completionComplete, complete } from "./commands/completion.js";
import { mint } from "./commands/mint.js";
import { signer } from "./commands/signer.js";
import { channels } from "./commands/channels.js";
import { history } from "./commands/history.js";
import { feedback } from "./commands/feedback.js";
import { dm, msg, ask } from "./commands/send.js";

/** The minimal mesh CLI: thin NATS clients (up/join/watch), plus `spawn` — a
 *  foreground agent launch that reuses the connector's launch recipe. Self-registers
 *  on import; heavier surfaces (the manager's control plane) register the same way
 *  and are composed at a root. */
const baseCommands: Command[] = [
  {
    kind: "command",
    name: "setup",
    group: "Setup",
    summary: "guided setup — first run walks you through it; --yes for non-interactive (agents/CI), --full to redo",
    run: setup,
  },
  {
    kind: "command",
    name: "go",
    group: "Setup",
    summary: "open or resume your session (mesh + web + manager + your cmux tabs); first run installs",
    run: go,
  },
  {
    kind: "command",
    name: "up",
    group: "Mesh",
    summary: "start a local nats-server (JetStream, JWT auth by default; --open for an unauthenticated dev mesh)",
    run: up,
  },
  {
    kind: "command",
    name: "down",
    group: "Mesh",
    summary: "stop a background mesh started with `up --detach`",
    run: down,
  },
  {
    kind: "command",
    name: "join",
    group: "Mesh",
    summary: "join a space (interactive) — --space <s> --name <n> [--role <r>]",
    run: join,
  },
  {
    kind: "command",
    name: "watch",
    group: "Mesh",
    summary: "observe all activity in a space — --space <s>",
    run: watch,
  },
  {
    kind: "command",
    name: "dm",
    group: "Mesh",
    summary: "direct-message a peer by name",
    usage: 'dm <agent> "<text>"  [--space <s>] [--server <url>] [--creds <path>]',
    run: dm,
  },
  {
    kind: "command",
    name: "msg",
    group: "Mesh",
    summary: "broadcast a message to a channel",
    usage: 'msg <channel> "<text>"  [--space <s>] [--server <url>] [--creds <path>]',
    run: msg,
  },
  {
    kind: "command",
    name: "ask",
    group: "Mesh",
    summary: "anycast a message to a role (one instance answers)",
    usage: 'ask <role> "<text>"  [--space <s>] [--server <url>] [--creds <path>]',
    run: ask,
  },
  {
    kind: "command",
    name: "console",
    group: "Mesh",
    summary: "live protocol view for a space — lazygit-style TUI, or a line stream on --plain — --space <s> [--plain]",
    run: console_,
  },
  {
    kind: "command",
    name: "demo",
    group: "Mesh",
    summary: "replay a scripted multi-agent trace (all message types) to exercise the console/web — --space <s> [--interval <ms>] [--once]",
    run: demo,
  },
  {
    kind: "command",
    name: "web",
    group: "Mesh",
    summary: "browser observability dashboard — presence, channels, live feed — --space <s> [--port <n>] [--no-open]",
    run: web,
  },
  {
    kind: "command",
    name: "spawn",
    group: "Agents",
    summary:
      "launch an agent in this terminal from a file — spawn <name-or-path> | --name <n> --config <path> [--agent <a>] [--role <r>]",
    run: spawn,
    complete: spawnComplete,
  },
  {
    kind: "command",
    name: "personas",
    group: "Agents",
    summary:
      "list/manage local personas (.cotal/agents) — personas <list [-v] | show <name> | new <name> (--prompt <t>|--from <f>) [--role <r>] [--model <m>] | rm <name> --force>",
    run: personas,
    complete: personasComplete,
  },
  {
    kind: "command",
    name: "completion",
    group: "Agents",
    summary: "print a shell-completion script — completion <bash|zsh|fish|powershell>",
    run: completion,
    complete: completionComplete,
  },
  {
    kind: "command",
    name: "__complete",
    group: "Agents",
    summary: "(internal) emit completion candidates for the current command line",
    run: complete,
  },
  {
    kind: "command",
    name: "mint",
    group: "Mesh",
    summary: "mint a creds file for a space (auth mode) — mint <name> --profile <agent|observer> [--out <path>]",
    run: mint,
  },
  {
    kind: "command",
    name: "signer",
    group: "Mesh",
    summary:
      "emit a stripped signer file (account signing material only, no operator key) for a containerized manager — [--out <path>] [--force]",
    run: signer,
  },
  {
    kind: "command",
    name: "channels",
    group: "Mesh",
    summary:
      "inspect/set channel registry — channels <list | set <name> [--replay|--no-replay] [--desc <s>] [--instructions <s>] | default --replay|--no-replay>",
    run: channels,
  },
  {
    kind: "command",
    name: "history",
    group: "Mesh",
    summary: "clear retained message history — history clear --force [--dms] [--space <s>]",
    run: history,
  },
  {
    kind: "command",
    name: "feedback",
    group: "Mesh",
    summary:
      'send feedback — feedback "<summary>" [--type <t>] [--email <e>] — or run the intake server: feedback --keys <keys.json> --creds <creds> [--port <n>]',
    run: feedback,
  },
];

registry.register(...baseCommands);

export { runCli } from "./command.js";
export { c, statusBadge } from "./ui.js";
