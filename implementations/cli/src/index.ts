import { registry, type Command } from "@cotal-ai/core";
import { up } from "./commands/up.js";
import { down } from "./commands/down.js";
import { setup, go } from "./commands/setup.js";
import { join } from "./commands/join.js";
import { watch } from "./commands/watch.js";
import { console_ } from "./commands/console.js";
import { demo } from "./commands/demo.js";
import { web } from "./commands/web.js";
import { spawn } from "./commands/spawn.js";
import { resume } from "./commands/resume.js";
import { mint } from "./commands/mint.js";
import { channels } from "./commands/channels.js";
import { history } from "./commands/history.js";
import { feedback } from "./commands/feedback.js";

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
  },
  {
    kind: "command",
    name: "resume",
    group: "Agents",
    summary:
      "late-join an existing Claude Code session onto the mesh (no agent file, any dir) — resume [--resume <id>] [--cwd <dir>] [--in-place] [--space <s>] [--server <url>] [--name <n>]",
    run: resume,
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
