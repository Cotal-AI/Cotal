import { registry, type Command } from "@cotal-ai/core";
import { targetFlags } from "@cotal-ai/workspace";
import { up } from "./commands/up.js";
import { down } from "./commands/down.js";
import { use, useComplete } from "./commands/use.js";
import { meshes } from "./commands/meshes.js";
import { setup, go } from "./commands/setup.js";
import { join } from "./commands/join.js";
import { console_ } from "./commands/console.js";
import { demo } from "./commands/demo.js";
import { web } from "./commands/web.js";
import { spawn, spawnComplete } from "./commands/spawn.js";
import { personas, personasComplete } from "./commands/personas.js";
import { completion, completionComplete, complete } from "./commands/completion.js";
import { mint } from "./commands/mint.js";
import { channels } from "./commands/channels.js";
import { history } from "./commands/history.js";
import { feedback } from "./commands/feedback.js";
import { send, sendComplete } from "./commands/send.js";
import { topology } from "./commands/topology.js";

/** The minimal mesh CLI: thin NATS clients (up/join/console), plus `spawn` — a
 *  foreground agent launch that reuses the connector's launch recipe. Self-registers
 *  on import; heavier surfaces (the manager's control plane) register the same way
 *  and are composed at a root. Flags are DECLARED here — the dispatcher parses them,
 *  generates each command's help/usage/completion, and hands `run` the parsed args. */
const baseCommands: Command[] = [
  {
    kind: "command",
    name: "setup",
    group: "Setup",
    summary: "guided setup — first run walks you through it; --yes for non-interactive (agents/CI), --full to redo",
    flags: [
      { name: "full", type: "boolean", description: "redo the full guided flow" },
      { name: "yes", type: "boolean", short: "y", description: "non-interactive accept-all (agents/CI)" },
      { name: "auth", type: "boolean", description: "JWT/ACL mesh (the default; kept for explicitness)" },
      { name: "open", type: "boolean", description: "opt OUT of auth — loopback-only open mesh, no durable backstop" },
    ],
    run: setup,
  },
  {
    kind: "command",
    name: "go",
    group: "Setup",
    summary: "open or resume your session (mesh + web + manager + your cmux tabs); first run installs",
    flags: [
      { name: "full", type: "boolean", description: "redo the full guided flow" },
      { name: "yes", type: "boolean", short: "y", description: "non-interactive accept-all (agents/CI)" },
      { name: "auth", type: "boolean", description: "JWT/ACL mesh (the default; kept for explicitness)" },
      { name: "open", type: "boolean", description: "opt OUT of auth — loopback-only open mesh, no durable backstop" },
    ],
    run: go,
  },
  {
    kind: "command",
    name: "up",
    group: "Mesh",
    summary:
      "start a local nats-server (JetStream, JWT auth by default; --open for an unauthenticated dev mesh) — or `-f <cotal.yaml>` to launch a whole mesh from a manifest [--dry-run; --server/--host/--space/--runtime/--open override the file]",
    flags: [
      { name: "server", type: "string", value: "<url>", description: "listen URL override" },
      { name: "host", type: "string", value: "<host>", description: "bind host override" },
      { name: "space", type: "string", value: "<s>", description: "space name (default: the folder's)" },
      { name: "store-dir", type: "string", value: "<dir>", description: "JetStream store directory" },
      { name: "channels", type: "string", value: "<a,b>", description: "channels to pre-create" },
      { name: "open", type: "boolean", description: "unauthenticated dev mesh (no JWT/ACLs)" },
      { name: "detach", type: "boolean", description: "run in the background (stop with `cotal down`)" },
      { name: "runtime", type: "string", value: "<pty|tmux|cmux>", description: "with -f: override the manifest's runtime" },
      { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "launch a whole mesh from a manifest" },
      { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
    ],
    run: up,
  },
  {
    kind: "command",
    name: "down",
    group: "Mesh",
    summary:
      "stop a background mesh started with `up --detach` — or `-f <cotal.yaml>` / `--run <id>` for an ownership-scoped teardown of a `spawn -f` deploy [--dry-run] (run from its project — local only)",
    flags: [
      { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "tear down this manifest's deploy" },
      { name: "run", type: "string", value: "<id>", description: "tear down one `spawn -f` run by id" },
      { name: "dry-run", type: "boolean", description: "print the plan, mutate nothing" },
    ],
    run: down,
  },
  {
    kind: "command",
    name: "meshes",
    group: "Mesh",
    summary: "list the running meshes (a `*` marks the `current` default a bare spawn joins)",
    run: meshes,
  },
  {
    kind: "command",
    name: "use",
    group: "Mesh",
    summary: "set the default mesh for a bare `cotal spawn` when several are running — use <space>",
    positionals: "<space>",
    run: use,
    complete: useComplete,
  },
  {
    kind: "command",
    name: "join",
    group: "Mesh",
    summary: "join a space (interactive) — --space <s> --name <n> [--role <r>]",
    flags: [
      ...targetFlags,
      { name: "name", type: "string", value: "<n>", description: "your presence name" },
      { name: "role", type: "string", value: "<r>", description: "your role" },
      { name: "channel", type: "string", value: "<c>", description: "channel to join" },
      { name: "kind", type: "string", value: "<k>", description: "endpoint kind" },
      { name: "link", type: "string", value: "<url>", description: "join link" },
      { name: "token", type: "string", value: "<t>", description: "join token" },
      { name: "tls", type: "boolean", description: "connect over TLS" },
    ],
    run: join,
  },
  {
    kind: "command",
    name: "send",
    group: "Mesh",
    summary: "send one message, then exit — send <dm <agent> | msg <channel> | ask <role>> \"<text>\"",
    usage: 'send <dm <agent> | msg <channel> | ask <role>> "<text>"  [--space <s>] [--server <url>] [--creds <path>]',
    positionals: '<dm <agent> | msg <channel> | ask <role>> "<text>"',
    flags: [...targetFlags],
    run: send,
    complete: sendComplete,
  },
  {
    kind: "command",
    name: "console",
    group: "Mesh",
    summary: "live protocol view for a space — lazygit-style TUI, or a line stream on --plain — --space <s> [--plain]",
    flags: [...targetFlags, { name: "plain", type: "boolean", description: "line stream instead of the TUI" }],
    run: console_,
  },
  {
    kind: "command",
    name: "demo",
    group: "Mesh",
    // A dev/test traffic generator (see docs/protocol-view.md) — runnable, but kept off the
    // top-level help so it doesn't clutter the user-facing surface.
    hidden: true,
    summary: "replay a scripted multi-agent trace (all message types) to exercise the console/web — --space <s> [--interval <ms>] [--once]",
    flags: [
      ...targetFlags,
      { name: "interval", type: "string", value: "<ms>", description: "delay between messages" },
      { name: "once", type: "boolean", description: "one pass, then exit" },
    ],
    run: demo,
  },
  {
    kind: "command",
    name: "web",
    group: "Mesh",
    summary: "browser observability dashboard — presence, channels, live feed — --space <s> [--port <n>] [--no-open]",
    flags: [
      ...targetFlags,
      { name: "port", type: "string", value: "<n>", description: "HTTP port (default 7799)" },
      { name: "no-open", type: "boolean", description: "don't open the browser" },
    ],
    run: web,
  },
  {
    kind: "command",
    name: "spawn",
    group: "Agents",
    summary:
      "launch an agent in this terminal from a file — spawn [<name-or-path>] (defaults to the `default` persona) | --name <n> --config <path> [--agent <a>] [--role <r>] [--resume <id>]",
    positionals: "[<name-or-path>]",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "target space (default: the resolved mesh)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (overrides the mesh registry entry)" },
      { name: "name", type: "string", value: "<n>", description: "presence name (defaults from the persona file)" },
      { name: "config", type: "string", value: "<path>", description: "agent file path (for a file outside .cotal/agents)" },
      { name: "agent", type: "string", value: "<a>", description: "connector type (claude, opencode, hermes …)" },
      { name: "role", type: "string", value: "<r>", description: "role override (wins over the agent file's role:)" },
      { name: "prompt", type: "string", value: "<text>", description: "initial prompt auto-submitted at start" },
      { name: "resume", type: "string", value: "<id>", description: "fork an existing session id into the mesh (claude only)" },
      { name: "transcript", type: "boolean", description: "mirror the session transcript to tr-<name>" },
      { name: "no-transcript", type: "boolean", description: "explicit default: no transcript mirror" },
      { name: "share-tools", type: "string", value: "<sel>", description: "share named operator MCP servers with the agent" },
      { name: "subscribe", type: "string", value: "<a,b>", description: "channel read set override" },
      { name: "allow-subscribe", type: "string", value: "<a,b>", description: "read ACL override" },
      { name: "allow-publish", type: "string", value: "<a,b>", description: "post ACL override" },
      { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "deploy a manifest onto the running mesh" },
      { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
      { name: "allow-stale", type: "string", value: "<a,b>", description: "with -f: waive named stale agents (apply-only)" },
      { name: "runtime", type: "string", value: "<pty|tmux|cmux>", description: "with -f: override the manifest's runtime" },
    ],
    run: spawn,
    complete: spawnComplete,
  },
  {
    kind: "command",
    name: "personas",
    group: "Agents",
    summary:
      "list/manage local personas (.cotal/agents) — personas <list [-v] [--running] | show <name> | edit <name> | new <name> (--prompt <t>|--from <f>) [--role <r>] [--model <m>] | rm <name> --force>",
    usage:
      "personas <list [-v] [--running] | show <name> | edit <name> | new <name> (--prompt <t>|--from <f>) [--role <r>] [--model <m>] | rm <name> --force>",
    positionals: "<list | show <name> | edit <name> | new <name> | rm <name>>",
    flags: [
      ...targetFlags,
      { name: "role", type: "string", value: "<r>", description: "new: the persona's role" },
      { name: "model", type: "string", value: "<m>", description: "new: the persona's model" },
      { name: "prompt", type: "string", value: "<t>", description: "new: the persona's prompt text" },
      { name: "from", type: "string", value: "<f>", description: "new: seed the prompt from a file" },
      { name: "verbose", type: "boolean", short: "v", description: "list: include role/model/description" },
      { name: "running", type: "boolean", description: "list: mark personas live on the mesh" },
      { name: "force", type: "boolean", description: "rm: required — delete without prompting" },
    ],
    run: personas,
    complete: personasComplete,
  },
  {
    kind: "command",
    name: "completion",
    group: "Agents",
    summary: "shell completion — completion <bash|zsh|fish|powershell | install [shell]>",
    positionals: "<bash|zsh|fish|powershell | install [shell]>",
    run: completion,
    complete: completionComplete,
  },
  {
    kind: "command",
    name: "__complete",
    group: "Agents",
    summary: "(internal) emit completion candidates for the current command line",
    rawArgs: true,
    positionals: "<words…>",
    run: complete,
  },
  {
    kind: "command",
    name: "mint",
    group: "Mesh",
    summary:
      "mint a creds file for a space (auth mode) — mint <name> --profile <agent|observer> [--out <path>]; --signer emits a stripped account-signing file (no operator key) for a containerized manager",
    positionals: "<name>",
    flags: [
      { name: "profile", type: "string", value: "<agent|observer|admin>", description: "cred profile (default agent)" },
      { name: "out", type: "string", value: "<path>", description: "output path (default .cotal/auth/creds/<name>.creds)" },
      { name: "signer", type: "boolean", description: "emit a stripped account-signing file instead" },
      { name: "force", type: "boolean", description: "with --signer: overwrite an existing file" },
      { name: "allow-subscribe", type: "string", value: "<a,b>", description: "read ACL override (comma-separated)" },
      { name: "allow-publish", type: "string", value: "<a,b>", description: "post ACL override (comma-separated)" },
    ],
    run: mint,
  },
  {
    kind: "command",
    name: "topology",
    group: "Mesh",
    summary: "validate + view a mesh manifest's access graph — topology view -f <cotal.yaml> (read-only; mutates nothing)",
    positionals: "<view>",
    flags: [{ name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "the manifest to inspect" }],
    run: topology,
  },
  {
    kind: "command",
    name: "channels",
    group: "Mesh",
    summary:
      "inspect/set channel registry — channels <list | set <name> [--replay|--no-replay] [--desc <s>] [--instructions <s>] | default --replay|--no-replay>",
    usage:
      "channels <list | set <name> [--replay|--no-replay] [--desc <s>] [--instructions <s>] | default --replay|--no-replay>",
    positionals: "<list | set <name> | default>",
    flags: [
      ...targetFlags,
      { name: "replay", type: "boolean", description: "set/default: replay history to new joiners" },
      { name: "no-replay", type: "boolean", description: "set/default: don't replay history" },
      { name: "window", type: "string", value: "<n>", description: "set: replay window size" },
      { name: "desc", type: "string", value: "<s>", description: "set: one-line channel description" },
      { name: "instructions", type: "string", value: "<s>", description: "set: instructions shown to joiners" },
    ],
    run: channels,
  },
  {
    kind: "command",
    name: "history",
    group: "Mesh",
    summary: "clear retained message history — history clear --force [--dms] [--space <s>]",
    positionals: "<clear>",
    flags: [
      ...targetFlags,
      { name: "dms", type: "boolean", description: "also clear DM history" },
      { name: "force", type: "boolean", description: "required — clear without prompting" },
    ],
    run: history,
  },
  {
    kind: "command",
    name: "feedback",
    group: "Mesh",
    summary:
      'send feedback — feedback "<summary>" [--type <t>] [--email <e>] — or run the intake server: feedback --keys <keys.json> --creds <creds> [--port <n>]',
    usage:
      'feedback "<summary>" [--type bug|idea|friction|praise|other] [--details …] [--severity low|medium|high] [--area …] [--email …] [--name …] [--url …] [--key …]  |  feedback --keys <keys.json> --creds <creds> [--port <n>]',
    // Dual-mode (client vs intake server) with two different flag sets — keeps its own parsing
    // until the intake server is split out of the CLI (stage 2b of the rework).
    rawArgs: true,
    positionals: '"<summary>" | --keys …',
    run: feedback,
  },
];

registry.register(...baseCommands);

export { runCli } from "./command.js";
export { c, statusBadge } from "./ui.js";
