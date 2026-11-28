# @cotal-ai/acp

## 0.185.1

## 0.185.0

No changes in this release.

## 0.184.1

No changes in this release.

## 0.184.0

### Patch Changes

- 56e4e23: T3 Code now shows a Cotal thread's options as a labelled menu with the right reasoning value, instead of a bare icon with Reasoning shown as Unknown. The reasoning option's id is now `reasoning` rather than `variant`, which T3 Code reserves for OpenCode, and this machine's manager is listed as This machine, which keeps the menu's label short enough for T3 Code to show it.

## 0.183.1

No changes in this release.

## 0.183.0

No changes in this release.

## 0.182.1

No changes in this release.

## 0.182.0

### Patch Changes

- 9f63fee: Keep Windows consoles from opening during background extension installs, updates, and helper commands.
- 2263884: Keep unrelated Zed agents unchanged when Cotal updates its own ACP launchers.

## 0.181.0

### Minor Changes

- b05f907: In ACP clients such as T3 Code, choosing another model or reasoning level on a running thread now switches its agent from the next turn, with no `/despawn`.

  - The `agent` endpoint advances to revision 6 with the owner-only `set-model`, and presence `agentEndpoint` gains `setModel`. Reconnect clients after the auth callout is updated, so their sign-in carries the new command.
  - Codex switches with `thread/settings/update`, OpenCode with the model each prompt carries (1.x) or its session model route (2.x), pi 0.84.3 or later with its session setters, Jcode with its model and effort calls, and Claude Code through its command mod for later turns of the session alone. Each checks the model against its own list first. Hermes does not switch yet, and the thread says to use `/despawn`.
  - A Manager keeps the switch and restarts or resumes the agent on it.
  - An agent whose role `modelPolicy` governs refuses every switch, since the policy is checked only at launch.

- 49d14ac: An ACP thread is now titled with the name its agent shows, and in T3 Code a title you give the thread becomes the agent's label. The `agent` endpoint advances to revision 7 with the owner-only `set-label`, which sets the label an agent shows in place of its name (`meta["ai.cotal.label"]`) and leaves the name that mentions and direct messages use. It refuses a label that breaks the rule a label from the first message follows: the shared name rule, at most 40 characters and single spaces between words. A `set-label` while the agent labels itself from its first message ends that naming, and the owner's label stays. `cotal acp` sends ACP `session_info_update` with the title when a thread starts, loads or opens its agent, and again whenever the agent's presence shows another name. Where the client lists a thread server in `mcpServers`, found by its `t3_thread_configure`, `t3_thread_read` and `t3_thread_update` tools as T3 Code's `t3-code` server offers them, the bridge sets the client's title there too. When a thread loads and at the start of each prompt it reads that title, and one the person changed since the bridge last set or read it becomes the agent's label. The bridge stores that last title with the thread's link, so a new bridge can tell a title the person gave the thread from a name the agent took elsewhere. It starts each MCP server the client passes once per process to list its tools, with only the environment the client gave, and keeps open only a thread server. A failed read or a refused label is said in the thread, and the prompt runs. The session list and `/open` read the agent's label as well.

### Patch Changes

- cab5fd0: ACP threads now start the agent on a model named `default` when the application lists one, and `/open` updates the client's model list. Choosing `<application>/default` spawns the agent with `model: "default"` and the chosen reasoning when the application's catalog lists a model with that id, as a custom Hermes endpoint can; otherwise the spawn still names no model and the application picks its own. After `/open`, the client gets the opened agent's options in a `config_option_update`, as it does when an option changes.
- 1916f86: `cotal acp` now recognises a manager service that an older release started on this machine, so a new thread uses it instead of failing to start a second one. A manager from before 0.180 names no machine, so when no listed manager names this machine the bridge reads `cotal manager status` for the space and takes the listed manager with the native instance that this machine's service record runs.
- d760682: When an agent's turn fails in an ACP client such as T3 Code, the error now shows the application's own message and error kind, such as Codex's usage limit, in place of "run failed". The bridge reads the text and kind from the agent's presence condition, waiting up to 2 seconds for it after the run fails, because the run error on the event channel carries only the fixed text `run failed`. The prompt's error reads `<agent>'s turn failed: <message> (<kind>)`, without the `Internal error:` prefix, and its `data.condition` holds the condition's `code`, `source` and `message`. A condition the agent showed before the prompt, or one that waits on an approval or an input, is not taken as the reason. With no condition the error still says the turn failed.

## 0.180.0

### Minor Changes

- bffdc47: `cotal acp` now starts this machine's manager for the space when no manager may start a new thread's agent, or when none of yours runs on this machine, and that manager stops itself after 10 minutes with no agents. The bridge runs `cotal manager start --idle-exit 600` and says so in one line at the start of the thread's first prompt, before the agent's reply. Another computer's manager runs a thread's agent only when the thread's Machine option names it. Threads that open at the same time share one start, and a failed start fails the new thread with its reason. With no manager registered for the space, listing, loading or deleting threads and `/open` now say so and that a new thread starts this machine's manager, in place of a bare internal error. A listed manager whose rail the broker reports empty, such as one whose computer is gone, is not offered. `cotal manager start` and `cotal service start manager` take `--idle-exit <seconds>` for that start only: the manager stops, and deregisters, once it has held no agent, call, workflow run, preservation or resume for that long, and no pending work over which `cotal manager stop` refuses, such as a name held until its retirement completes; `cotal status --components` lists that work on the manager row. `status` shows the value on an `Idle exit` row. A start with a different value while the manager runs refuses `LIFECYCLE_BLOCKED`. `@cotal-ai/workspace` probes a signed-in caller's pinned manager rail on the rail its credential was issued for. A manager that `cotal manager start`, `cotal acp` or a controller stack's `cotal up` starts now gets the `spawn.env` names that are set where it starts, so its seats get them, as seats of a manager the legacy launcher starts do; no value is printed. On Linux, a background service now starts in a systemd user scope of its own when the user manager answers, so it outlives an app that stops the scope its agent ran in, as T3 Code does when a thread's session ends; a scope that cannot be made fails the start, and each launch's scope has a name of its own, so a retry never meets an earlier attempt's scope. When `cotal acp` cannot read this machine's identity, as in a container with no `/etc/machine-id`, a thread still uses a manager its Machine option names, and it neither defaults to a manager nor starts one; a prompt with none chosen, or a new thread with none listed, fails and says why.
- fcd33e4: `cotal acp` now recognises this machine's manager after the machine's host name changes, as macOS does when the network changes, so it no longer starts a second manager or defaults a thread to another computer. A Manager's `status` and presence card carry `machine`, an HMAC-SHA256 of the host's OS machine identity keyed by it over `cotal manager host`, and the bridge compares it with its own; the host name is only shown. A manager that names no machine counts as another computer's. The Manager cluster advances to revision 57, and its closed status schema of revision 56 rejects the field, so update Managers and their callers together, as revision 56 already requires. `@cotal-ai/workspace` exports `osMachineId()`, the OS machine identity read the CLI's service records use, and `managerMachineId()`; `reportedManagerHost` answers `{ host, machine }`.

## 0.179.0

### Minor Changes

- 3b5bde1: T3 Code and other ACP clients now get from every Cotal agent what that harness's own provider shows: replies streamed as they are written, tool calls with their arguments, results and diffs, plans, approvals, questions, the agent's own commands, cancel, later prompts with images, context usage, reasoning, and the model and effort pickers.

  - Core: the `agent` endpoint is at revision 5, with `turn` (the owner's next prompt, with images) and `usage` (context and cost). Presence gains `agentEndpoint: { interrupt, turn, images, usage }`, which says what a process serves now, so a caller picks one path per agent before it sends anything. `ModelCatalogOpts.envAllow` gives a model catalog read the `spawn.env` names a launch receives.
  - Manager: cluster revision 56. `spawn` takes the opt-in `askPermissions` (ask before tool use) and `reasoningEvents` (publish the model's reasoning), and every `status.connectors` row says whether its connector takes them. Update Managers and their callers together. `@cotal-ai/workspace` carries the two fields in a managed launch and in the cached connector rows.
  - connector-core: a delta journal beside each thread's journal streams harness text and reasoning before the harness saves it, merged into the durable source, and a connector may journal records of its own there. `JsonlFileSource.holdsSync` tells whether a cursor is on the file at the path now. A tool result marker may leave out `isError`, and `web` reads one without it.
  - Claude Code: reply text streams while the command mod runs; the owner's turns take images as files the model reads; usage, both launch fields, `AskUserQuestion` as a question form, and the model list read with the launch's `spawn.env` names. Reply text that Claude Code does not show, such as "No response requested.", is not published. The release plugin tree now ships `hooks/stream.js`. The to-do tools stay off as Claude Code's terminal has them for current models; an operator turns them on with `CLAUDE_CODE_ENABLE_TODO_TOOLS` through `spawn.env`.
  - Codex: replies and reasoning summaries stream; turns with images and usage; approval requests, questions, permissions requests and MCP elicitations go to the prompt desk; `askPermissions` launches in the approval-required mode; a code-mode script's calls and plan show as their own tool calls while they run. Codex now publishes reasoning only for a launch with `reasoningEvents`, where before it published every summary it recorded.
  - Hermes: turns, interrupt, usage and the gateway's slash commands on the agent endpoint; streamed replies; reasoning with `reasoningEvents`; `askPermissions` for the commands Hermes stops; `clarify` questions on the prompt desk; the models of the provider a launch's environment selects, with Hermes's reasoning efforts as variants; tools run in the seat's folder; and a run shared by several messages ends with the outcome of the message that ends it.
  - Jcode: native session commands, interrupt, turns with images, usage and streamed text and reasoning; a failed turn closes its run with the error; the seat's real home, so the shell tool runs on Jcode 1.1; and streaming keeps going across a journal fold that reuses the file's inode.
  - OpenCode: agent commands and interrupt on 1.x; turns with images and usage, permission asks and questions on the agent endpoint, both launch fields, streamed replies and running tool calls on 2.x and 1.x. On 1.x, usage reads the newest step, and a command whose turn never starts frees the seat after 5 seconds. Before launch, `harness-commands` lists a 1.x install's commands and skills too, from a private server it starts and stops. The 2.x model list read stops its private server's whole process group, reports OpenCode's own error when that server fails to start, and gives up after 10 seconds in all.
  - Pi: tool arguments and results on the payload rail, turns and usage, `askPermissions`, streamed replies, thinking with `reasoningEvents`, and the model catalog read with the launch's `spawn.env` names.
  - `cotal acp`: picks each agent's cancel, prompt, image and usage path from its presence; sends a turn's usage before the prompt answers; gives each model's reasoning choices in the session's model state, so T3 shows the effort picker before a thread runs; launches with the two fields where the connector takes them; shows tool details, plans, Codex's change approvals as diffs, and the agent's own commands; asks an agent's approvals and questions, also ones it opens between the thread's turns, and asks a prompt again when its first read fails; keeps a prompt queued behind the agent's other work open until the agent runs it, and a cancel takes it out of the queue; never defaults a thread to another computer's manager; offers a short persona and channel select plus `/persona` and `/join` where the lists are too long for a select; and says what it cannot replay when an agent's tool details cannot be read.
  - `cli`: the Hermes model remedy no longer suggests `--no-events`.

- c7f487b: Agents on static spaces and open meshes now answer their owner's prompts, commands, turns, interrupts, usage reads and renames, as they do where people sign in. A static `agent` credential now carries the serve rows for the `agent` endpoint and no caller row. A renewal keeps the rows its first issuance recorded, so an agent an older release started keeps running without the endpoint until it is respawned, and its connector says so. Core adds the static `agent-caller` profile: the owner's calls to the agents under its own owner, their replies and its inbox, never minted by the auth callout. `openAgentCaller` in `@cotal-ai/workspace` opens it. `CotalEndpoint.servePrincipal` and `MeshAgent` serve on every mesh mode. On an open mesh any client may call, outside the security claims. The Manager's `status.connectors[].prompts` is the connector's declaration on every mesh mode, with the same schema and cluster revision. Codex accepts an asking `approval_policy` on every space. `cotal acp` calls agents through an in-memory `agent-caller` on a static space and through its observer elsewhere, so questions, the agent's commands, images and `/name` work in a thread on every space. The Manager now accepts a spawn's `firstCommand` on static spaces and open meshes too, and the agent runs it there as its first turn.

### Patch Changes

- 2a51ab9: In ACP clients such as T3 Code, a Claude Code tool call now shows while the tool runs, and the model list no longer offers an application it cannot start.

  - Claude Code: a tool call shows within about a second of its start while the tool runs.
  - `cotal acp`: lists an application's default model once when its catalog also has a model named `default`, with that model's name and reasoning choices.
  - `cotal acp`: refuses an application whose models the manager could not read, with the manager's reason, in place of offering its default alone. Loading or opening a thread on a running agent of that application still works.
  - Claude Code, OpenCode 2.x and pi: a model catalog read that fails, or that lists no model a seat could run, such as a logged-out Claude Code or a pi without provider credentials, now fails. `cotal models` reports that catalog as unreadable, exiting 4, or 5 with `--harness`, and `cotal acp` leaves the application out with the reason.

## 0.178.0

No changes in this release.

## 0.177.0

No changes in this release.

## 0.176.6

### Patch Changes

- 665c8df: The T3 Code and Zed entries that `cotal setup` writes keep working after Node or Cotal is upgraded.
  Under the get.cotal.ai launcher, an entry now runs the launcher's Node link instead of the folder of one Node version, such as Homebrew's `Cellar/node/<version>`, which Homebrew removes when Node upgrades. It also runs the install's own entry instead of the copy one update loaded. Status counts a link to the running Node as current.

## 0.176.5

### Patch Changes

- afccf80: A Cotal thread in T3 Code and other ACP clients now has a Harness option for picking which application the agent runs.
  The option lists the applications that can run a thread, such as claude, codex, jcode and pi. Choosing another harness starts it on that application's default model, and choosing a model moves the harness to that model's application, so the two always agree. The model list stays complete, because T3 Code checks a thread's saved model against it before it applies the other options. A thread that only drives an agent it loaded does not offer it.

## 0.176.4

### Patch Changes

- 234a808: T3 Code users can now see which application each model runs on and pick it from the model list.
  Each model choice's name now starts with its application, such as `claude: Claude Opus 4.5` or `jcode: default`. T3 Code flattens the grouped model list and drops the group names, so the application was not shown anywhere, and the model choice is the only place a thread picks it. Clients that show groups keep them.
- eeacc43: Cotal setup adds a separate T3 Code provider without changing unrelated ACP providers, even when they use the same space arguments or already hold Cotal's preferred provider ID.

## 0.176.3

No changes in this release.

## 0.176.2

No changes in this release.

## 0.176.1

No changes in this release.

## 0.176.0

### Minor Changes

- e9bcb31: `cotal setup` now adds Cotal to T3 Code and Zed when it finds them, so a thread in either app can start and drive Cotal agents without editing their settings by hand. Setup installs `@cotal-ai/acp` and adds one entry per space that runs this computer's `cotal acp --space <space>` by absolute path. It updates an entry you added by hand in place instead of adding a second one, keeps your other settings and Zed's comments, and backs up each file before it changes it. `cotal update` points the entries at the Cotal it installed, and `cotal status` shows an entry whose command is gone. The ACP bridge gains `/name`, which names a thread's agent before it starts or renames a running one on a space where people sign in, and `/open`, which drives an agent that is already running from a new thread. A thread reopens on the agent it spawned or opened. `npx @cotal-ai/acp` starts the Cotal installed on this computer, and when there is none or it lacks the ACP extension, it offers a terminal sign-in that installs what is missing. Core adds the `client-setup` extension kind (`ClientSetupProvider`) and passes the space to a setup action.

## 0.175.3

No changes in this release.

## 0.175.2

### Patch Changes

- 4a49d39: The ACP sign-in step writes the command it runs in backticks, like every other command the CLI names in a message.
- 29aeddc: ACP hides sign-in on spaces without user authentication, sends prose beginning with `/despawn` to the agent, explains how to start a missing manager, and documents that `--server` overrides the recorded broker.

## 0.175.1

No changes in this release.

## 0.175.0

### Minor Changes

- e91ed5b: T3 Code, Zed and other Agent Client Protocol clients can now spawn and drive Cotal agents through the new `@cotal-ai/acp` extension and its `cotal acp` command.

  `cotal acp` serves ACP v1 on standard input and output. A client thread is one managed agent: its first prompt spawns the agent through the space's manager in the thread's folder, with the model, reasoning variant, persona, channel and machine the thread chose, and the agent keeps running when the client closes. The thread follows the agent's event channel, so an application without an event plane is not offered. Session list shows the managed agents in a folder, loading one replays what its event channel still holds, deleting one hides that run, and `/despawn`, `/roster` and `/channels` answer in the thread. A later prompt is typed into the agent's terminal through the manager's `input` command, so it arrives as the user's own words, and its turn ends once the agent has started working and stopped again. An agent whose runtime owns no terminal input, such as tmux, refuses it, and the prompt fails with the manager's reason. A client that runs terminals is offered a sign-in that runs `cotal login` or, with no space recorded, `cotal setup`. Stopping a turn interrupts the agent through the manager's new `interrupt` command, and the turn ends as cancelled, also when the agent cannot be stopped. Forwarding an agent's questions is not available yet. `@cotal-ai/cli` names the package when `cotal acp` runs before the extension is added, and `@cotal-ai/workspace` records `acp` as a Cotal home entry and offers the `input` and `interrupt` control calls.

  The manager serves a new targeted `interrupt` command, contract revision 53. It writes the key a seat's connector declares in the new `Connector.interruptKey` into the seat's terminal, and it is granted as `input` is. The Claude Code and Pi connectors declare Escape.

  On a space where people sign in, a person now controls every agent under their own owner without the `admin` scope. Their manager view carries `inspect` and `ps` and owner-mode `input`, `interrupt`, `despawn` and `attach`, whatever their scope, and their sign-in reads those agents' event channels live and through its own history reader. These rights come from the ledger row being a person's, never from a scope token, so no agent credential holds them. They ride the person's sign-in, so a program running as that person where they are signed in can use them. `cotal acp` reads through that sign-in, takes your managers from the auth service's `/manager-instances` list, reads your agents from every live one, sends each agent's commands to the manager that holds it, and names each agent `acp_<id>`, a valid actor name there. A thread loaded without a grant that may spawn offers only the agent's own model and cannot start another, and `cotal acp` stops, sending nothing, when the machine's sign-in is granted again or changes account. `@cotal-ai/core` adds a `publisher` filter to `channelHistoryPage` and an optional `AuthProvider.listManagerInstances`, which `@cotal-ai/auth` implements. `@cotal-ai/workspace` adds `ownManagerInstances`, `userSignInAuth`, `signInChange`, an observer `lifecycleUid` option, and a `gone` list on the `ps` reply for registrations whose host is gone. A control call whose own chosen run was replaced is now reported as refused before submission, with `preSubmitRefusal` and `selectedSeatChanged`, so a picker `cotal attach` exits as a refusal (`TARGET_NOT_FOUND`) and `cotal team agent remove` reports refused where they reported a failure or an unknown outcome; nothing was ever sent in that case.
