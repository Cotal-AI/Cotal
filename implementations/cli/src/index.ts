import { registry, type Command } from "@cotal-ai/core";
import {
  serverFlag, spaceFlag, targetFlags,
  type LocalProcess,
} from "@cotal-ai/workspace";
import { MANAGER_PROCESS } from "./lib/manager-proc.js";
import { up, upComplete, upFlags } from "./commands/up.js";
import { runtimes, runtimesFlags } from "./commands/runtimes.js";
import { down, downComplete } from "./commands/down.js";
import { use, useComplete, useFlags } from "./commands/use.js";
import { meshes, meshesComplete, meshesFlags } from "./commands/meshes.js";
import { space, spaceComplete, spaceFlags } from "./commands/space.js";
import { setup, setupFlags } from "./commands/setup.js";
import { join } from "./commands/join.js";
import { console_ } from "./commands/console.js";
import { spawn, spawnComplete, spawnFlags, spawnRequiredExtensions } from "./commands/spawn.js";
import { attach, attachFlags, input, inputFlags, managedAgentComplete, ps, psFlags, stop, stopFlags } from "./commands/agents.js";
import { models, modelsComplete, modelsFlags } from "./commands/models.js";
import { c } from "./ui.js";
import { personas, personasComplete } from "./commands/personas.js";
import { completion, completionComplete, completionFlags, complete } from "./commands/completion.js";
import { config, configFlags } from "./commands/config.js";
import { mint } from "./commands/mint.js";
import { channels } from "./commands/channels.js";
import { history, historyFlags } from "./commands/history.js";
import { clean, cleanComplete } from "./commands/clean.js";
import { feedback } from "./commands/feedback.js";
import { send, sendComplete } from "./commands/send.js";
import { ext, extFlags } from "./commands/ext.js";
import { help, helpFlags, version, versionFlags } from "./commands/help.js";
import { topology } from "./commands/topology.js";
import { status, statusFlags } from "./commands/status.js";
import { who, whoFlags } from "./commands/who.js";
import { whoami, whoamiFlags } from "./commands/whoami.js";
import { doctor, doctorFlags } from "./commands/doctor.js";
import { endpoints } from "./commands/endpoints.js";
import { describeCmd, describeComplete, describeFlags, invokeCmd, invokeFlags } from "./commands/describe.js";
import { backup, backupComplete, backupFlags } from "./commands/backup.js";
import { update, updateFlags } from "./commands/update.js";
import { service, serviceComplete } from "./commands/service.js";
import { sync, syncFlags } from "./commands/sync.js";
import { DELIVERY_PROCESS } from "./lib/delivery-proc.js";
import { AUTH_PROCESS } from "./lib/auth-proc.js";

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
    summary: "prepare a space for your agents: destination, application, project and space; starts nothing",
    usage: "cotal setup [--destination <local|self-hosted>] [-H|--harness <connector>] [--project <dir>] [--space <name>] [--connection-file <bundle.json>] [--configure-only] [--demo|--full] [-y|--yes] [--json|--plain] | setup --skills",
    flags: setupFlags,
    outputs: ["json", "plain"],
    examples: ["cotal setup", "cotal setup --destination local --harness claude --project ~/research --space research --no-input", "cotal setup --destination self-hosted --harness claude --project ~/team --space team --connection-file team.json --json", "cotal setup --skills"],
    run: setup,
  },
  {
    kind: "command",
    name: "help",
    group: "Setup",
    summary: "list the commands, or show one command's help",
    positionals: "[command…]",
    flags: helpFlags,
    run: help,
  },
  {
    kind: "command",
    name: "version",
    group: "Setup",
    summary: "print this binary's version and each installed extension's",
    flags: versionFlags,
    outputs: ["json"],
    examples: ["cotal version", "cotal version --json"],
    run: version,
  },
  {
    kind: "command",
    name: "ext",
    aliases: ["x"],
    group: "Setup",
    summary: "operator-installed extensions - add commands, runtimes, and local process providers",
    usage: "cotal ext [list] [--json|--plain] | ext add <npm-package> | ext remove <name> | ext root | ext seed [--repair|--reset|--force]",
    positionals: "[add <npm-package> | remove <name> | list | root | seed]",
    subcommands: [
      { name: "add", summary: "install an extension package and register what it provides", usage: "cotal ext add <npm-package>" },
      { name: "remove", aliases: ["rm"], summary: "uninstall an extension", usage: "cotal ext remove <name>" },
      { name: "list", summary: "list installed extensions (what bare `cotal ext` does)", usage: "cotal ext list [--json|--plain]", outputs: ["json", "plain"], reads: true },
      { name: "root", summary: "print the extension root directory", usage: "cotal ext root", reads: true },
      { name: "seed", summary: "reconcile the built-in connectors", usage: "cotal ext seed [--repair|--reset|--force]" },
      { name: "__update-add", summary: "re-add one extension for a running update", hidden: true },
    ],
    flags: extFlags,
    outputs: ["json", "plain"],
    examples: ["cotal ext", "cotal ext --json", "cotal ext add @cotal-ai/orca", "cotal ext root"],
    reads: true,
    run: ext,
  },
  {
    kind: "command",
    name: "config",
    group: "Setup",
    summary: "your preferences - the defaults your commands use, and where each value comes from",
    usage: "cotal config [--user | --space <name>] [--json|--plain] | config get <key> | config set <key> <value> | config unset <key>",
    positionals: "[get <key> | set <key> <value> | unset <key>]",
    subcommands: [
      { name: "get", summary: "show one key's value, where it comes from and what it outranks", usage: "cotal config get <key> [--user | --space <name>] [--json|--plain]", outputs: ["json", "plain"], reads: true },
      { name: "set", summary: "save a value for you, or for one space with --space", usage: "cotal config set <key> <value> [--user | --space <name>] [--json|--plain]", outputs: ["json", "plain"] },
      { name: "unset", summary: "remove a saved value", usage: "cotal config unset <key> [--user | --space <name>] [--json|--plain]", outputs: ["json", "plain"] },
    ],
    flags: configFlags,
    outputs: ["json", "plain"],
    examples: ["cotal config", "cotal config get harness", "cotal config set harness opencode", "cotal config set persona reviewer --space demo", "cotal config unset color"],
    reads: true,
    run: config,
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
    summary: "shell completion - which shells have it, print a stub, or install it persistently",
    usage: "cotal completion [--json|--plain] | script <bash|zsh|fish|powershell> | install [shell]",
    positionals: "[script <shell> | install [shell]]",
    flags: completionFlags,
    outputs: ["json", "plain"],
    subcommands: [
      { name: "script", summary: "print a shell's completion stub as raw shell code", usage: "cotal completion script <bash|zsh|fish|powershell>" },
      { name: "install", summary: "install the stub persistently (detects $SHELL)", usage: "cotal completion install [shell]" },
      ...["bash", "zsh", "fish", "powershell"].map((name) => ({ name, summary: `replaced by completion script ${name}`, hidden: true })),
    ],
    examples: ["cotal completion", "source <(cotal completion script bash)", "cotal completion install"],
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
    prepareMeshTarget: false,
    run: up,
    complete: upComplete,
  },
  {
    kind: "command",
    name: "runtimes",
    group: "Manager",
    summary: "list the agent runtimes the manager can spawn through (pty built in; others via `cotal ext add`) and whether each is reachable",
    usage: "cotal runtimes [--json|--plain]",
    flags: runtimesFlags,
    outputs: ["json", "plain"],
    examples: ["cotal runtimes", "cotal runtimes --json"],
    reads: true,
    run: runtimes,
  },
  {
    kind: "command",
    name: "service",
    group: "Manager",
    summary: "run the manager as a user service (survives logout/reboot) - install/status/uninstall",
    usage: "service <install [--mesh <name>] [--linger] | status [--mesh <name>] [--json] | uninstall [--mesh <name>]>",
    positionals: "<install | status | uninstall>",
    flags: [
      { name: "mesh", type: "string", value: "<name>", description: "the mesh whose manager the service runs (default: this folder's)" },
      { name: "linger", type: "boolean", description: "install: when lingering is off, ask logind to enable it so the service starts at boot and survives logout (never enabled silently; install refuses without lingering)" },
      { name: "json", type: "boolean", description: "status: machine-readable output" },
    ],
    run: service,
    complete: serviceComplete,
  },
  {
    kind: "command",
    name: "down",
    group: "Mesh",
    summary: "stop the whole local stack (managed agents stay running unless --with-agents), or name only the components to stop",
    positionals: "[<component> …]",
    flags: [
      { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "tear down this manifest's deploy" },
      { name: "run", type: "string", value: "<id>", description: "tear down one `spawn -f` run by id" },
      { name: "space", type: "string", value: "<name>", description: "with components: the mesh whose target-addressed components (e.g. web) to stop" },
      { name: "dry-run", type: "boolean", description: "print what would stop, mutate nothing" },
      { name: "with-agents", type: "boolean", description: "bare whole stack: also stop and deprovision every managed agent" },
      { name: "preserve-state", type: "boolean", description: "bare whole stack: stop without logical teardown and publish an offline backup cut" },
      { name: "store-dir", type: "string", value: "<dir>", description: "with --preserve-state: actual JetStream store (default .cotal/nats)" },
      { name: "session-store", type: "string", multiple: true, value: "<dir>", description: "with --preserve-state: a harness transcript store directory to capture with every continuation-capable seat (repeatable; no default and never inferred)" },
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
    summary: "list the meshes this machine knows (a `*` marks the `current` default a bare spawn joins); add/rm register one running elsewhere",
    usage: "meshes [list] [--json] | meshes add [<space>] [--server <url>] [--root <dir>] [--mode auth|open] | meshes rm <space> …  (bare `meshes add` on a terminal is guided)",
    positionals: "[list | add <space> | rm <space> …]",
    flags: meshesFlags,
    run: meshes,
    complete: meshesComplete,
  },
  {
    kind: "command",
    name: "space",
    group: "Mesh",
    summary: "the spaces this machine can reach, which one is selected and whether each broker answers; add, create or forget one",
    usage: "cotal space [--json|--plain] | space show [<name>] | space add [<name>] | space create <name> | space forget <name>",
    positionals: "[show [<name>] | add [<name>] | create <name> | forget <name>]",
    subcommands: [
      { name: "show", summary: "one space in full: broker, mode, root, origin and login; the selected one when no name is given", usage: "cotal space show [<name>] [--json|--plain]", outputs: ["json", "plain"], reads: true },
      {
        name: "add",
        summary: "register a space that runs elsewhere, after checking its broker and trust; the selection is unchanged",
        usage: "cotal space add <name> --server <url> [--root <dir>] [--mode auth|open] [--tls] [--allow-unencrypted-overlay] [--force] [-y|--yes] [--json|--plain] | space add [<name>] (-f|--file <bundle.json> | --from <https url>) [--root <dir>] [--server <url>] [--force] [-y|--yes]",
        outputs: ["json", "plain"],
      },
      { name: "create", summary: "prepare a space to start here: records its name and root, and `cotal up` in the root starts it", usage: "cotal space create <name> [--root <dir>] [--json|--plain]", outputs: ["json", "plain"] },
      { name: "forget", summary: "remove a registration or a prepared space; stops nothing and keeps the root's files", usage: "cotal space forget <name> [--json|--plain]", outputs: ["json", "plain"] },
    ],
    flags: spaceFlags,
    outputs: ["json", "plain"],
    examples: ["cotal space", "cotal space show research --json", "cotal space add research --server nats://100.90.12.34:4222 --root ~/research", "cotal space add --file hosted.json", "cotal space create demo --root ~/demo", "cotal space forget research"],
    reads: true,
    run: space,
    complete: spaceComplete,
  },
  {
    kind: "command",
    name: "sync",
    group: "Mesh",
    summary: "refresh signed-in space catalogs and report registry changes",
    usage: "cotal sync [--idp <auth base URL>] [--json|--plain]",
    flags: syncFlags,
    outputs: ["json", "plain"],
    run: sync,
  },
  {
    kind: "command",
    name: "status",
    aliases: ["s"],
    group: "Mesh",
    summary: "read-only status of this machine, its processes, the recorded meshes and the selected mesh",
    usage: "cotal status [--json|--plain] [--all] [--space <s>] [--server <url>] | cotal status --components",
    flags: statusFlags,
    outputs: ["json", "plain"],
    examples: ["cotal status", "cotal status --all", "cotal status --json", "cotal status --components"],
    reads: true,
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
    summary: "select the space commands target when none is named, from any directory; bare `use` shows the selection",
    usage: "cotal use [<space>] [--json|--plain]",
    positionals: "[<space>]",
    flags: useFlags,
    outputs: ["json", "plain"],
    examples: ["cotal use", "cotal use research"],
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
      { name: "out", type: "string", value: "<path>", description: "output path (default .cotal/auth/creds/space.<key>/<name>.creds)" },
      { name: "signer", type: "boolean", description: "emit a stripped account-signing file instead" },
      { name: "force", type: "boolean", description: "with --signer: overwrite an existing file" },
      { name: "allow-subscribe", type: "string", value: "<a,b>", description: "agent profile: read ACL override (comma-separated); refused off it" },
      { name: "allow-publish", type: "string", value: "<a,b>", description: "agent profile: post ACL override (comma-separated); refused off it" },
      { name: "role", type: "string", value: "<role>", description: "agent profile: scopes its anycast task queue (svc_<role>); overrides the agent file; refused off it" },
      { name: "provision", type: "boolean", description: "agent profile: also pre-create the identity's bind-only DM/deliver durables (+ role task queue) on the live mesh, so the credential can consume; needs the broker reachable" },
      { name: "expires-in", type: "string", value: "<seconds>", description: "bound the credential's lifetime (TTL in seconds, e.g. 3600); mutually exclusive with --expires-at" },
      { name: "expires-at", type: "string", value: "<unix-seconds>", description: "bound the credential's lifetime (absolute exp, unix seconds); mutually exclusive with --expires-in" },
      { name: "identity", type: "string", value: "<creds>", description: "re-mint for the existing nkey carried by this creds file (JWT + USER NKEY SEED), keeping the principal and its durables; default: a fresh identity" },
      spaceFlag,
      serverFlag,
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
    aliases: ["h"],
    group: "Messaging",
    summary: "read the newest retained messages within this identity's read grant, or clear history (`history clear`)",
    usage:
      "cotal history [<channel>] [--dms] [--since <time|seq>] [--limit <n>] [--from <name>] [--grep <text>] [--follow] [--json|--plain] | cotal history clear --force [--dms]",
    positionals: "[<channel> | clear]",
    flags: historyFlags,
    outputs: ["json", "ndjson", "plain"],
    examples: ["cotal history general", "cotal history --since 2h --grep deploy", "cotal history general --follow --json", "cotal history clear --force"],
    reads: true,
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
    aliases: ["sp"],
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
    usage: "cotal models [--json|--plain] [--agent <connector>] [--refresh]",
    flags: modelsFlags,
    outputs: ["json", "plain"],
    examples: ["cotal models", "cotal models --agent claude --refresh", "cotal models --json"],
    reads: true,
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
    usage: "cotal ps [--json|--plain] [--wide | --slots] [--on <instance>]",
    flags: psFlags,
    outputs: ["json", "plain"],
    examples: ["cotal ps", "cotal ps --wide", "cotal ps --json", "cotal ps --on <instance>"],
    reads: true,
    run: ps,
  },
  {
    kind: "command",
    name: "attach",
    aliases: ["a"],
    group: "Agents",
    summary: "stream + drive an agent's terminal (pty runtime) - --name <n>",
    flags: attachFlags,
    run: attach,
    complete: managedAgentComplete,
  },
  {
    kind: "command",
    name: "input",
    group: "Agents",
    summary: "type one line into an agent's terminal without attaching - --name <n> --text <t>",
    flags: inputFlags,
    run: input,
    complete: managedAgentComplete,
  },
  {
    kind: "command",
    name: "personas",
    group: "Agents",
    summary: "list/manage local personas (.cotal/agents)",
    usage:
      'personas <list [-v] [--running] | show <name> | edit <name> | new <name> (--prompt <t>|--from <f>) --subscribe <a,b|""> [--role <r>] [--model <m>] | rm <name> --force>',
    positionals: "<list | show <name> | edit <name> | new <name> | rm <name>>",
    flags: [
      ...targetFlags,
      { name: "role", type: "string", value: "<r>", description: "new: the persona's role" },
      { name: "model", type: "string", value: "<m>", description: "new: the persona's model" },
      { name: "prompt", type: "string", value: "<t>", description: "new: the persona's prompt text" },
      { name: "from", type: "string", value: "<f>", description: "new: seed the prompt from a file" },
      { name: "subscribe", type: "string", value: '<a,b|"">', description: 'new: channels the persona reads ("" = none) - required' },
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
    reads: true,
    run: endpoints,
  },
  {
    kind: "command",
    name: "who",
    group: "Observe",
    summary: "the live roster of the selected space: status, attention, harness, model, host and whether a manager runs each seat",
    usage: "cotal who [--waiting] [--all] [--json|--plain] [--space <s>] [--server <url>] [--creds <path>]",
    flags: whoFlags,
    outputs: ["json", "plain"],
    examples: ["cotal who", "cotal who --waiting", "cotal who --all --json"],
    reads: true,
    run: who,
  },
  {
    kind: "command",
    name: "whoami",
    group: "Observe",
    summary: "the identity this CLI acts under in the selected space, and what it may read, post and do",
    usage: "cotal whoami [--json|--plain] [--space <s>] [--server <url>]",
    flags: whoamiFlags,
    outputs: ["json", "plain"],
    examples: ["cotal whoami", "cotal whoami --json"],
    reads: true,
    run: whoami,
  },
  {
    kind: "command",
    name: "describe",
    group: "Observe",
    summary: "resolve a registered v0.4 service's command surface off the wire (describe + the contract store)",
    usage: "describe <endpoint>  [--space <s>] [--server <url>]",
    positionals: "<endpoint>",
    flags: describeFlags,
    reads: true,
    run: describeCmd,
    complete: describeComplete,
  },
  {
    kind: "command",
    name: "invoke",
    group: "Observe",
    summary: "invoke one v0.4 service command by name with JSON args (schemas fetched, never hand-imported)",
    usage: "invoke <endpoint> <command>  [--args '<json>'] [--name <agent> | --self] [--admin]",
    positionals: "<endpoint> <command>",
    flags: invokeFlags,
    run: invokeCmd,
    complete: describeComplete,
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

// The runtime rows name their pidfile through the workspace constants, which are `{space}`
// TEMPLATES like `auth-service.{space}.pid` already was. A copied literal here is the defect this
// closes: the manager and the daemon write one name and status/down looked up another.
const baseProcesses: LocalProcess[] = [
  MANAGER_PROCESS,
  DELIVERY_PROCESS,
  AUTH_PROCESS,
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
export { setInstalledExtensionsEnabled } from "./ext-loader.js";
export { c, statusBadge } from "./ui.js";
// The full spawn grammar, for the composition root's launch-parity smoke (grammar ⊆ start-op ⊆ MCP).
export { spawnFlags } from "./commands/spawn.js";
export { spawnRequiredExtensions } from "./commands/spawn.js";
export { updateFlags } from "./commands/update.js";
// The launch-client timeout + the manifest launch client, for the same smoke: every launch door
// must outlive the manager's readiness wait (#159 B1).
export { START_TIMEOUT_MS } from "./lib/control.js";
export { launchAgent } from "./lib/manifest/live.js";
