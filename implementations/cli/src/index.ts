import { registry, type Command } from "@cotal-ai/core";
import { targetFlags, type LocalProcess } from "@cotal-ai/workspace";
import { up, upComplete, upFlags } from "./commands/up.js";
import { runtimes } from "./commands/runtimes.js";
import { down, downComplete } from "./commands/down.js";
import { use, useComplete } from "./commands/use.js";
import { meshes } from "./commands/meshes.js";
import { setup, setupFlags } from "./commands/setup.js";
import { join } from "./commands/join.js";
import { console_ } from "./commands/console.js";
import { spawn, spawnComplete, spawnFlags, spawnRequiredExtensions } from "./commands/spawn.js";
import { attach, attachFlags, managedAgentComplete, ps, psFlags, stop, stopFlags } from "./commands/agents.js";
import { models, modelsComplete, modelsFlags } from "./commands/models.js";
import { c } from "./ui.js";
import { personas, personasComplete } from "./commands/personas.js";
import { completion, completionComplete, complete } from "./commands/completion.js";
import { mint } from "./commands/mint.js";
import { channels } from "./commands/channels.js";
import { history } from "./commands/history.js";
import { clean, cleanComplete } from "./commands/clean.js";
import { feedback } from "./commands/feedback.js";
import { send, sendComplete } from "./commands/send.js";
import { ext } from "./commands/ext.js";
import { topology } from "./commands/topology.js";
import { status, statusFlags } from "./commands/status.js";
import { doctor, doctorFlags } from "./commands/doctor.js";
import { endpoints } from "./commands/endpoints.js";
import { backup, backupComplete, backupFlags } from "./commands/backup.js";
import { update, updateFlags } from "./commands/update.js";

/** The minimal mesh CLI: thin NATS clients (up/join/console), plus `spawn` — an agent launch
 *  (foreground or --detach) that reuses the connector's launch recipe. Self-registers on import;
 *  heavier surfaces (the manager daemon, delivery) register the same way and are composed at a
 *  root. Flags are DECLARED (here or co-located with the command) — the dispatcher parses them,
 *  generates each command's help/usage/completion, and hands `run` the parsed args. Groups follow
 *  the user's mental model (Setup · Mesh · Messaging · Agents · Observe), and the array is ordered
 *  by group — the help listing renders groups in first-seen order. */
const baseCommands: Command[] = [
  // ---- Setup --------------------------------------------------------------------------------
  {
    kind: "command",
    name: "setup",
    group: "Setup",
    summary: "guided setup (configure-only: installs + seeds, launches nothing) - --yes non-interactive, --full to redo",
    flags: setupFlags,
    run: setup,
  },
  {
    kind: "command",
    name: "ext",
    group: "Setup",
    summary: "operator-installed extensions - add commands, runtimes, and local process providers",
    usage: "ext [add <npm-package> | remove <name> | list | root | seed [--repair|--reset|--force]]",
    positionals: "[add <npm-package> | remove <name> | list | root | seed]",
    flags: [
      { name: "repair", type: "boolean", description: "seed: recover a lost ever-seeded authority from its durable backup" },
      { name: "reset", type: "boolean", description: "seed: discard the authority and re-seed all built-in connectors (resurrects removed ones)" },
      { name: "force", type: "boolean", description: "seed: re-seed the built-in connectors even when the stamp is current or a downgrade" },
    ],
    run: ext,
  },
  {
    kind: "command",
    name: "update",
    group: "Setup",
    summary: "reconcile first-party extensions and check for a coherent cotal-ai upgrade",
    flags: updateFlags,
    run: update,
  },
  {
    kind: "command",
    name: "completion",
    group: "Setup",
    summary: "shell completion - print a stub or install it persistently",
    usage: "completion <bash|zsh|fish|powershell | install [shell]>",
    positionals: "<bash|zsh|fish|powershell | install [shell]>",
    run: completion,
    complete: completionComplete,
  },
  {
    kind: "command",
    name: "__complete",
    group: "Setup",
    summary: "(internal) emit completion candidates for the current command line",
    rawArgs: true,
    positionals: "<words…>",
    run: complete,
  },
  // ---- Mesh ---------------------------------------------------------------------------------
  {
    kind: "command",
    name: "up",
    group: "Mesh",
    summary: "start a local mesh (nats-server + JetStream, JWT auth by default) - or `-f <cotal.yaml>` for a whole manifest",
    flags: upFlags,
    run: up,
    complete: upComplete,
  },
  {
    kind: "command",
    name: "runtimes",
    group: "Manager",
    summary: "list the agent runtimes the manager can spawn through (pty built in; others via `cotal ext add`) and whether each is reachable",
    run: runtimes,
  },
  {
    kind: "command",
    name: "down",
    group: "Mesh",
    summary: "stop the whole local stack, or name only the components to stop",
    positionals: "[<component> …]",
    flags: [
      { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "tear down this manifest's deploy" },
      { name: "run", type: "string", value: "<id>", description: "tear down one `spawn -f` run by id" },
      { name: "space", type: "string", value: "<name>", description: "with components: the mesh whose target-addressed components (e.g. web) to stop" },
      { name: "dry-run", type: "boolean", description: "print what would stop, mutate nothing" },
      { name: "preserve-state", type: "boolean", description: "bare whole stack: stop without logical teardown and publish an offline backup cut" },
      { name: "store-dir", type: "string", value: "<dir>", description: "with --preserve-state: actual JetStream store (default .cotal/nats)" },
    ],
    run: down,
    complete: downComplete,
  },
  {
    kind: "command",
    name: "backup",
    group: "Mesh",
    summary: "create an offline full-space or registry-only backup from a preserved cut",
    usage: "backup create <dir> [--only full|registry] [--store-dir <dir>]",
    positionals: "create <dir>",
    flags: backupFlags,
    run: backup,
    complete: backupComplete,
  },
  {
    kind: "command",
    name: "clean",
    group: "Mesh",
    summary:
      "configurable cleanup - history/store/all, plus explicit committed-restore fallback cleanup",
    usage:
      "clean <history|store|all> --force [--dms] [--space <s>] [--server <url>] [--creds <path>] [--store-dir <dir>] | clean restore-fallback --attempt <id> --force",
    positionals: "<history|store|all|restore-fallback>",
    flags: [
      ...targetFlags,
      { name: "dms", type: "boolean", description: "history: also clear DM history" },
      { name: "store-dir", type: "string", value: "<dir>", description: "store/all: JetStream store directory (default .cotal/nats)" },
      { name: "attempt", type: "string", value: "<id>", description: "restore-fallback: matching committed restore attempt" },
      { name: "force", type: "boolean", description: "required - destructive, no prompting" },
    ],
    run: clean,
    complete: cleanComplete,
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
    name: "status",
    group: "Mesh",
    summary: "detailed read-only status for setup, local processes, recorded meshes, and the selected live mesh",
    flags: statusFlags,
    run: status,
  },
  {
    kind: "command",
    name: "doctor",
    group: "Mesh",
    summary: "credential-health diagnosis + repair - `doctor auth [--fix]` renders every managed cred (healthy/near-expiry/expired) and ends in `healthy` or the exact next command",
    positionals: "auth",
    flags: doctorFlags,
    run: doctor,
  },
  {
    kind: "command",
    name: "use",
    group: "Mesh",
    summary: "set the default mesh for a bare `cotal spawn` from any directory",
    positionals: "<space>",
    run: use,
    complete: useComplete,
  },
  {
    kind: "command",
    name: "join",
    group: "Mesh",
    summary: "join a space (interactive) - --space <s> --name <n> [--role <r>]",
    flags: [
      ...targetFlags,
      { name: "name", type: "string", value: "<n>", description: "your presence name" },
      { name: "role", type: "string", value: "<r>", description: "your role" },
      { name: "channel", type: "string", value: "<c>", description: "channel to join" },
      { name: "kind", type: "string", value: "<k>", description: "endpoint kind" },
      { name: "link", type: "string", value: "<url>", description: "join link" },
      { name: "token", type: "string", value: "<t>", description: "join token" },
      { name: "lifecycle-uid", type: "string", value: "<uid>", description: "lifecycle uid paired with --creds (minted with the credential at provision time)" },
      { name: "tls", type: "boolean", description: "connect over TLS" },
    ],
    run: join,
  },
  {
    kind: "command",
    name: "mint",
    group: "Mesh",
    summary: "mint a creds file for a space (auth mode); --signer emits a stripped account-signing file",
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
    summary: "validate + view a mesh manifest's access graph (read-only)",
    positionals: "<view>",
    flags: [{ name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "the manifest to inspect" }],
    run: topology,
  },
  // ---- Messaging ----------------------------------------------------------------------------
  {
    kind: "command",
    name: "send",
    group: "Messaging",
    summary: "send one message, then exit - dm a peer, msg a channel, or ask a role",
    usage: 'send <dm <agent> | msg <channel> | ask <role>> "<text>"  [--space <s>] [--server <url>] [--creds <path>]',
    positionals: '<dm <agent> | msg <channel> | ask <role>> "<text>"',
    flags: [...targetFlags],
    run: send,
    complete: sendComplete,
  },
  {
    kind: "command",
    name: "channels",
    group: "Messaging",
    summary: "inspect or set the channel registry",
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
    group: "Messaging",
    summary: "clear retained message history (alias of `clean history`)",
    usage: "history clear --force [--dms] [--space <s>]",
    positionals: "<clear>",
    flags: [
      ...targetFlags,
      { name: "dms", type: "boolean", description: "also clear DM history" },
      { name: "force", type: "boolean", description: "required - clear without prompting" },
    ],
    run: history,
  },
  {
    kind: "command",
    name: "feedback",
    group: "Messaging",
    summary: 'send feedback to the Cotal developers - feedback "<summary>" [--type <t>] [--email <e>]',
    positionals: '"<summary>"',
    flags: [
      { name: "type", type: "string", value: "<t>", description: "bug | idea | friction | praise | other" },
      { name: "details", type: "string", value: "<text>", description: "longer free-form details" },
      { name: "severity", type: "string", value: "<s>", description: "low | medium | high" },
      { name: "area", type: "string", value: "<a>", description: "the part of Cotal this concerns" },
      { name: "email", type: "string", value: "<e>", description: "contact email (required on the keyless public path)" },
      { name: "name", type: "string", value: "<n>", description: "your name (optional)" },
      { name: "url", type: "string", value: "<url>", description: "intake URL override" },
      { name: "key", type: "string", value: "<k>", description: "feedback key (default: COTAL_FEEDBACK_KEY)" },
    ],
    run: feedback,
  },
  // ---- Agents -------------------------------------------------------------------------------
  {
    kind: "command",
    name: "spawn",
    group: "Agents",
    summary:
      "launch an agent from a persona - spawn [<persona>] (defaults to COTAL_DEFAULT_PERSONA or `default`); --config accepts a persona name or path; foreground here, or --detach via the manager",
    positionals: "[<persona>]",
    flags: spawnFlags,
    run: spawn,
    complete: spawnComplete,
    requiredExtensions: spawnRequiredExtensions,
  },
  {
    kind: "command",
    name: "models",
    group: "Agents",
    summary: "list connector model catalogs and variants from the manager",
    flags: modelsFlags,
    run: models,
    complete: modelsComplete,
  },
  {
    kind: "command",
    name: "start",
    group: "Agents",
    // Tombstone (stage 2a): the verb is gone, the ability moved. Errors with the replacement —
    // never a silent alias (no fallbacks). Hidden: not part of the surface, just a signpost.
    hidden: true,
    rawArgs: true,
    positionals: "…",
    summary: "(removed) `cotal start` was merged into `cotal spawn --detach`",
    run: async () => {
      console.error(
        c.red(
          "✗ `cotal start` was merged into `cotal spawn --detach` - one launch grammar for foreground and detached (persona positional or --config; --name/--model/--cwd/--prompt/--subscribe/--allow-*/--share-tools all apply)",
        ),
      );
      process.exit(1);
    },
  },
  {
    kind: "command",
    name: "stop",
    group: "Agents",
    summary: "ask the manager to stop an agent - --name <n>",
    flags: stopFlags,
    run: stop,
    complete: managedAgentComplete,
  },
  {
    kind: "command",
    name: "ps",
    group: "Agents",
    summary: "list managed agents + their mesh status",
    flags: psFlags,
    run: ps,
  },
  {
    kind: "command",
    name: "attach",
    group: "Agents",
    summary: "stream + drive an agent's terminal (pty runtime) - --name <n>",
    flags: attachFlags,
    run: attach,
    complete: managedAgentComplete,
  },
  {
    kind: "command",
    name: "personas",
    group: "Agents",
    summary: "list/manage local personas (.cotal/agents)",
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
      { name: "force", type: "boolean", description: "rm: required - delete without prompting" },
    ],
    run: personas,
    complete: personasComplete,
  },
  // ---- Observe ------------------------------------------------------------------------------
  {
    kind: "command",
    name: "endpoints",
    group: "Observe",
    summary: "list every endpoint in the live presence roster, including the manager",
    flags: [...targetFlags],
    run: endpoints,
  },
  {
    kind: "command",
    name: "console",
    group: "Observe",
    summary: "live protocol view for a space - lazygit-style TUI, or a line stream on --plain",
    flags: [...targetFlags, { name: "plain", type: "boolean", description: "line stream instead of the TUI" }],
    run: console_,
  },
  // `web` (dashboard) moved out to the `@cotal-ai/web` extension package (stage 4) — installed via
  // `cotal ext add`, it self-registers here and appears in this same surface.
];

const baseProcesses: LocalProcess[] = [
  {
    kind: "local-process",
    name: "manager",
    label: "manager",
    order: 10,
    pidFile: "manager.pid",
    artifacts: ["manager.delivery-aware"],
  },
  {
    kind: "local-process",
    name: "delivery",
    label: "delivery daemon",
    order: 20,
    pidFile: "delivery.pid",
    artifacts: ["delivery.creds"],
  },
  {
    kind: "local-process",
    name: "auth",
    label: "user-auth service",
    order: 30,
    pidFile: "auth-service.{space}.pid",
    visibleWhen: "user-auth",
  },
  {
    kind: "local-process",
    name: "nats",
    label: "nats-server",
    order: 100,
    pidFile: "nats.pid",
    stopLast: true,
    clearsMesh: true,
  },
];

registry.register(...baseCommands, ...baseProcesses);

export { runCli } from "./command.js";
export { c, statusBadge } from "./ui.js";
// The full spawn grammar, for the composition root's launch-parity smoke (grammar ⊆ start-op ⊆ MCP).
export { spawnFlags } from "./commands/spawn.js";
export { updateFlags } from "./commands/update.js";
// The launch-client timeout + the manifest launch client, for the same smoke: every launch door
// must outlive the manager's readiness wait (#159 B1).
export { START_TIMEOUT_MS } from "./lib/control.js";
export { launchAgent } from "./lib/manifest/live.js";
