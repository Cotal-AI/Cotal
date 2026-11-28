# @cotal-ai/pi

## 0.184.1

## 0.184.0

No changes in this release.

## 0.183.1

No changes in this release.

## 0.183.0

No changes in this release.

## 0.182.1

### Patch Changes

- 8eead0e: The desktop app has an Agent apps screen. It lists the application each connector runs (Claude Code, Codex, OpenCode, pi, Hermes and Jcode) with its logo, version and whether it is signed in, and installs a missing one with its maker's own installer in one click, with no terminal. Before you install, each app says which site it downloads from, and a connector that is not one of Cotal's own also shows its package name. When an installer leaves its folder off PATH, the app adds it, and the background service picks the application up. Claude Code and Codex sign in from the app through their own browser sign-in. A connector declares all this in a new `install` field beside `requires`, which the extensions manifest caches and checks.

## 0.182.0

### Patch Changes

- 9f63fee: Keep Windows consoles from opening during background extension installs, updates, and helper commands.

## 0.181.0

### Minor Changes

- b05f907: In ACP clients such as T3 Code, choosing another model or reasoning level on a running thread now switches its agent from the next turn, with no `/despawn`.

  - The `agent` endpoint advances to revision 6 with the owner-only `set-model`, and presence `agentEndpoint` gains `setModel`. Reconnect clients after the auth callout is updated, so their sign-in carries the new command.
  - Codex switches with `thread/settings/update`, OpenCode with the model each prompt carries (1.x) or its session model route (2.x), pi 0.84.3 or later with its session setters, Jcode with its model and effort calls, and Claude Code through its command mod for later turns of the session alone. Each checks the model against its own list first. Hermes does not switch yet, and the thread says to use `/despawn`.
  - A Manager keeps the switch and restarts or resumes the agent on it.
  - An agent whose role `modelPolicy` governs refuses every switch, since the policy is checked only at launch.

## 0.180.0

No changes in this release.

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

### Patch Changes

- 2a51ab9: In ACP clients such as T3 Code, a Claude Code tool call now shows while the tool runs, and the model list no longer offers an application it cannot start.

  - Claude Code: a tool call shows within about a second of its start while the tool runs.
  - `cotal acp`: lists an application's default model once when its catalog also has a model named `default`, with that model's name and reasoning choices.
  - `cotal acp`: refuses an application whose models the manager could not read, with the manager's reason, in place of offering its default alone. Loading or opening a thread on a running agent of that application still works.
  - Claude Code, OpenCode 2.x and pi: a model catalog read that fails, or that lists no model a seat could run, such as a logged-out Claude Code or a pi without provider credentials, now fails. `cotal models` reports that catalog as unreadable, exiting 4, or 5 with `--harness`, and `cotal acp` leaves the application out with the reason.

## 0.178.0

### Minor Changes

- 8f994bc: pi agents can now be launched at a chosen thinking level. `--variant <level>` renders pi's `--thinking` flag, a level that is not one of pi's own is refused before launch, and `cotal models --harness pi` lists each model's thinking levels as its variants. The model list now needs pi 0.81.0 or later; with an older pi it is unavailable and names the command pi refused.

## 0.177.0

### Minor Changes

- 0bb3186: A launcher can now list the commands and skills a harness offers in a directory before any agent starts, and start an agent with one of them as its first turn. The Manager's new `harness-commands` read (`{ agent, cwd }`) asks Claude Code, Codex, pi or OpenCode 2.x in that directory and answers the entries a seat's `command` takes, or `supported: false` with a reason for a harness whose seats run no commands; it starts no seat and is granted where `list-dir` is. `spawn` takes `firstCommand: { target, name, args? }` and its acceptance names `firstCommand.id`. The agent queues the command under that id before any other and runs it as its first turn through its own command lane once the harness runs commands, and `command-state` reports a refusal. The Manager cluster advances to revision 54.

## 0.176.6

No changes in this release.

## 0.176.5

No changes in this release.

## 0.176.4

### Patch Changes

- 7375267: Pi can now spawn on a Cotal mesh while the standalone Cotal extension is installed. Cotal skips discovered copies of the released standalone bundle and keeps Pi's other extensions enabled. Spawning Pi requires the npm-installed host running on Node.

## 0.176.3

No changes in this release.

## 0.176.2

No changes in this release.

## 0.176.1

No changes in this release.

## 0.176.0

No changes in this release.

## 0.175.3

No changes in this release.

## 0.175.2

No changes in this release.

## 0.175.1

No changes in this release.

## 0.175.0

### Minor Changes

- e91ed5b: T3 Code, Zed and other Agent Client Protocol clients can now spawn and drive Cotal agents through the new `@cotal-ai/acp` extension and its `cotal acp` command.

  `cotal acp` serves ACP v1 on standard input and output. A client thread is one managed agent: its first prompt spawns the agent through the space's manager in the thread's folder, with the model, reasoning variant, persona, channel and machine the thread chose, and the agent keeps running when the client closes. The thread follows the agent's event channel, so an application without an event plane is not offered. Session list shows the managed agents in a folder, loading one replays what its event channel still holds, deleting one hides that run, and `/despawn`, `/roster` and `/channels` answer in the thread. A later prompt is typed into the agent's terminal through the manager's `input` command, so it arrives as the user's own words, and its turn ends once the agent has started working and stopped again. An agent whose runtime owns no terminal input, such as tmux, refuses it, and the prompt fails with the manager's reason. A client that runs terminals is offered a sign-in that runs `cotal login` or, with no space recorded, `cotal setup`. Stopping a turn interrupts the agent through the manager's new `interrupt` command, and the turn ends as cancelled, also when the agent cannot be stopped. Forwarding an agent's questions is not available yet. `@cotal-ai/cli` names the package when `cotal acp` runs before the extension is added, and `@cotal-ai/workspace` records `acp` as a Cotal home entry and offers the `input` and `interrupt` control calls.

  The manager serves a new targeted `interrupt` command, contract revision 53. It writes the key a seat's connector declares in the new `Connector.interruptKey` into the seat's terminal, and it is granted as `input` is. The Claude Code and Pi connectors declare Escape.

  On a space where people sign in, a person now controls every agent under their own owner without the `admin` scope. Their manager view carries `inspect` and `ps` and owner-mode `input`, `interrupt`, `despawn` and `attach`, whatever their scope, and their sign-in reads those agents' event channels live and through its own history reader. These rights come from the ledger row being a person's, never from a scope token, so no agent credential holds them. They ride the person's sign-in, so a program running as that person where they are signed in can use them. `cotal acp` reads through that sign-in, takes your managers from the auth service's `/manager-instances` list, reads your agents from every live one, sends each agent's commands to the manager that holds it, and names each agent `acp_<id>`, a valid actor name there. A thread loaded without a grant that may spawn offers only the agent's own model and cannot start another, and `cotal acp` stops, sending nothing, when the machine's sign-in is granted again or changes account. `@cotal-ai/core` adds a `publisher` filter to `channelHistoryPage` and an optional `AuthProvider.listManagerInstances`, which `@cotal-ai/auth` implements. `@cotal-ai/workspace` adds `ownManagerInstances`, `userSignInAuth`, `signInChange`, an observer `lifecycleUid` option, and a `gone` list on the `ps` reply for registrations whose host is gone. A control call whose own chosen run was replaced is now reported as refused before submission, with `preSubmitRefusal` and `selectedSeatChanged`, so a picker `cotal attach` exits as a refusal (`TARGET_NOT_FOUND`) and `cotal team agent remove` reports refused where they reported a failure or an unknown outcome; nothing was ever sent in that case.

## 0.174.4

No changes in this release.

## 0.174.3

No changes in this release.

## 0.174.2

No changes in this release.

## 0.174.1

No changes in this release.

## 0.174.0

### Minor Changes

- 5053a5e: An agent's owner can now rename the agent, and every client in the space sees the new name while the agent keeps its identity. The `agent` endpoint advances to revision 4 with `set-name` `{ name }`, which only the owner's interactive session may call. The agent checks the name with the shared name rule, refuses the name of another live agent compared lowercased, changes its card's display name and republishes presence at once; refusals are typed with the `ai.cotal.agent.name-refused` detail (`name-invalid` or `name-taken`), and the current name again changes nothing. Messages sent afterwards carry the new `from.name`, and stored history keeps the old one. `CotalEndpoint.setCardName` makes the change, and an endpoint that watches presence reports a changed display name as a `presence` update and a `roster` event. A manager keeps a seat's last shown name apart from its alias and passes it as `COTAL_DISPLAY_NAME` (`LaunchOpts.displayName`) when it starts the seat again after a crash or a preserved resume, so the seat comes back under the same alias and actor with its last name. `ps`, resume commit and name allocation find a renamed seat by its principal, and in user mode a new spawn does not take a renamed agent's actor.

## 0.173.0

### Minor Changes

- 7030cca: A pi agent's own commands, prompt templates and skills can now be listed and run from its agent endpoint, and its running turn interrupted, on pi 0.84.2 or later. The pi extension gives its mesh agent a command dispatcher: it lists pi's `getCommands()`, runs a listed name through pi's own command path (`sendUserMessage` with `expandPromptTemplates`), refuses a name pi does not list before pi sees it, and stops a turn with pi's abort. On an older pi, which would send `/name args` to its model as text, `commands` answers `supported: false`.

### Patch Changes

- 82531e6: A failed OpenCode or pi turn now sets the presence `condition`, so observers no longer read it as plain `idle` or `waiting`. OpenCode relays its own error kind as `source` and its message, mapped to `auth`, `rate_limit`, `budget`, `request`, `model`, `server`, `context` or `failed`. pi relays `failed` with its error message. A turn someone stopped sets none.

## 0.172.2

No changes in this release.

## 0.172.1

No changes in this release.

## 0.172.0

No changes in this release.

## 0.171.5

No changes in this release.

## 0.171.4

### Patch Changes

- cb8692a: Cotal update explains how to refresh the standalone pi extension without overwriting your copy.

## 0.171.3

No changes in this release.

## 0.171.2

### Patch Changes

- da8cb2b: Claude Code and Pi seats return to `idle` after their user interrupts a turn, and the run ends as an interrupt on the event plane. Claude Code fires no hook on an interrupt, so the connector now watches the open turn's transcript for the interrupt record Claude Code writes. That record sets presence to `idle`, clears any approval or input condition, and closes the run with `RUN_FINISHED` carrying an `interrupt` outcome. A Pi turn without a Cotal batch now publishes `idle` when it ends after an abort or an error. An aborted Pi turn, including one stopped during a tool call, ends with an `interrupt` outcome instead of `RUN_ERROR`.
- a55bdb0: Refuse invalid spawn arguments and inaccessible working directories before provisioning credentials, reject pi resume flags, and remove Hermes launch credentials, sockets and disposable profiles after stopping.

## 0.171.1

No changes in this release.

## 0.171.0

No changes in this release.

## 0.170.0

No changes in this release.

## 0.169.0

### Minor Changes

- a59864f: A connector's local control endpoint no longer trusts whoever holds its name, and sessions launched before this release must be restarted. A hook used to send the endpoint key in its first frame and print whatever came back, so another local user who took the socket or pipe name after the connector's server exited received the key and could answer the hook. Each connection now runs the control exchange: the client and the server each prove with HMAC-SHA256 over fresh nonces that they hold the key, the reply carries a MAC, the hook's delivery receipt carries a MAC over that reply, and neither side sends the key. Every line is bounded in bytes before it is parsed, every reply included. The lifecycle hooks, the Manager's cooperative stop and session calls, and the Hermes Python hooks all move to it. The Hermes bridge adapter now presents a token derived from the key (HMAC-SHA256 over `cotal-hermes-bridge/1`) in place of the key. A client waits at most 1 second for the server's proof, and a server drops a connection that proves nothing within 5 seconds.

  The exchange has a version, `CONTROL_PROTOCOL_VERSION` (1), that travels with the key: `LaunchSpec.control` is now `{ path, token, version }`. The key moves to new carrier names: the launch material carries `controlKey` and `controlVersion`, and a hand-driven session sets `COTAL_CONTROL_KEY` and `COTAL_CONTROL_VERSION=1`. A hook or connector from an earlier release finds no key in a new launch, so one that requires a control endpoint refuses to start, and this release refuses the old `controlToken` and `COTAL_CONTROL_TOKEN`. An earlier Hermes launcher mints its own key and keeps running its own sidecar and gateway. A key without a version, a version a build does not speak, and a peer of another version are all refused, with no fallback. A hand-set key with whitespace around it and a version set without a key are refused, by the TypeScript and Python readers alike. A Claude Code session that reloads its plugin after the upgrade re-reads launch material written before it, which has no version, so it refuses until the session is restarted. `materialEnv` takes `control` (the endpoint) in place of `controlToken`, and `controlEndpoint` takes the launch's artifact list as its third argument.

  Off Windows each launch's control socket now sits in a directory of its own, `cotal-ctl-<id>` under the temp directory, named from the key. Minting the endpoint creates it with mode 0700 and refuses one that already exists, the server checks its owner and mode before it binds and never creates it, every client checks it before it connects, and the launcher removes it with the launch's other artifacts. A directory that is missing or fails the check counts as no endpoint, so a hand-driven `COTAL_CONTROL_SOCKET` must point into a private directory that exists. A Hermes stop now waits for the gateway to exit in every mode before it removes that directory, and keeps the directory when it cannot prove the exit. Hermes standalone mode keeps its own `cotal-hermes-*` directory instead, which nothing removes. The Hermes bridge socket moves beside the control socket, and a Hermes adapter whose bridge directory is not private reports a permanent error instead of a connected platform that drops its replies. `@cotal-ai/core` exports the exchange (`clientExchange`, `serverExchange`, `controlCall`, `checkControlSocketDir`, `assertControlSocketDir`, `assertControlEndpoint`), and `clientExchange` and `controlCall` require `maxReplyBytes` as a finite, non-negative whole number; `tokenMatches`, `AUTH_DEADLINE_MS`, `MAX_FRAME_BYTES` and `HANDOFF_RECEIPT` are no longer exported by `@cotal-ai/connector-core`.

### Patch Changes

- a103e1e: Quote the missing-application spawn retry command and verify retained setup seeds, absent stopped targets, unverified Pi sender labels and private Jcode startup diagnostics.

## 0.168.0

No changes in this release.

## 0.167.0

### Patch Changes

- acc1003: A pi seat's mention wake now names the sender and channel with the same label as the other connectors' frames, so it is always one line. Control characters, line separators and brackets in a peer's name, role or channel label are shown as spaces.

## 0.166.3

No changes in this release.

## 0.166.2

No changes in this release.

## 0.166.1

### Patch Changes

- bf3d2f0: A pi turn that fails now shows pi's own error in the agent's presence line, for example `Pi turn ended with error (Unknown provider: unknown) after 2 automatic continuation attempts`. Before this, the line said only that the turn ended with an error. When pi had no model provider set up, the user was told to start a new turn or replace the seat, and neither step helps. The error is put on one line and cut to 300 characters.
- 9541212: A Pi seat now receives messages that arrive during a long run at its next turn boundary instead of only when the run ends. On transports without a provider response hook, such as the Codex subscription, Pi running a tool from an answer now confirms the batch that request carried. A steer sent while a tool runs no longer trips the dispatch watchdog's hold, which used to block every later message for the rest of the run.

## 0.166.0

### Patch Changes

- c23de83: Keep internal connector helpers and types module-private while preserving the published package exports.

## 0.165.4

No changes in this release.

## 0.165.3

No changes in this release.

## 0.165.2

No changes in this release.

## 0.165.1

### Patch Changes

- 78aa32d: Pin the NATS client packages (`@nats-io/nats-core`, `transport-node`, `jetstream`, `kv`, `obj`) to 3.4.0, the versions every suite runs against. They were declared as `^3.4.0`, so an install made after their 3.5.0 release ran a client the product was never tested with.

## 0.165.0

### Patch Changes

- a97aade: Report harness work timestamps across the Claude Code, Codex, Hermes, OpenCode and pi connectors.

  Relay work events into the existing presence `activeAt` field so roster and operator surfaces can date the last reported work separately from heartbeats. No new wire field or progress verdict is added. Boundary-only hosts report less frequently than streaming hosts, and work age cannot distinguish a slow provider from a hung one.

- 18d2cda: A channel post that mentions an agent who may not read the channel no longer drops that mention silently. On an authenticated mesh the delivery daemon sends the post's sender a mention notice that names those agents, so the sender can reach them another way. The connectors show it as `[mention notice from the delivery daemon]`, and Hermes runs it in its own `notice:mention` chat.

## 0.164.18

No changes in this release.

## 0.164.17

No changes in this release.

## 0.164.16

No changes in this release.

## 0.164.15

No changes in this release.

## 0.164.14

No changes in this release.

## 0.164.13

No changes in this release.

## 0.164.12

No changes in this release.

## 0.164.11

No changes in this release.

## 0.164.10

No changes in this release.

## 0.164.9

No changes in this release.

## 0.164.8

No changes in this release.

## 0.164.7

No changes in this release.

## 0.164.6

No changes in this release.

## 0.164.5

No changes in this release.

## 0.164.4

No changes in this release.

## 0.164.3

No changes in this release.

## 0.164.2

No changes in this release.

## 0.164.1

### Patch Changes

- 30c1f57: A participant whose name is blank is shown by its id. This covers `cotal watch`, `who`, `endpoints`, `channel members`, `join`, `chat`, the console, the compose target and palette, the terminal UI, the dashboard badge, the connector roster, orientation and inbox, a Hermes injected turn, the offline notice, the ambiguous-name error and the pending delivery label. A blank name used to print as nothing or as a line break. The same now holds for a pi mention, a once-task spawner, space delete, a DM recipient in chat, the Manager list, a legacy seat, the attach picker, the preserve refusal, teardown, the join receipt, the console agent and confirm lines, a spawn result, an anycast take or DM result, a pane label in the Manager's browser console, and the principals `cotal chat --plain` names for a shared display name.

## 0.164.0

### Minor Changes

- 471b464: Publish bounded tool inputs and results to permitted event readers and show them in interactive console details and dashboard Work turns.

  Payloads use a separate owner-scoped rail. Owners and space admins can read them by default, while another owner needs an explicit concrete event-channel grant. Cotal tool payloads are excluded. Use `--no-event-payloads` or a persona's `eventPayloads: false` to retain names and times without publishing inputs or results. The credential grant enforces withholding. The Manager cluster advances to revision 49 for the optional boolean `spawn.eventPayloads` input.

  Full backups retain payload frames and their owner-scoped subjects. Registry-only restores leave payloads empty. New backups use format v3, and restore continues to accept the exact v1 and v2 inventories. A space without the payload stream keeps publishing tool names and times and reports that payloads are unavailable until its broker setup is upgraded.

## 0.163.5

No changes in this release.

## 0.163.4

No changes in this release.

## 0.163.3

No changes in this release.

## 0.163.2

No changes in this release.

## 0.163.1

No changes in this release.

## 0.163.0

No changes in this release.

## 0.162.0

### Patch Changes

- a625710: Keep Pi message delivery working after an extension reload or session resume.
  Reuse the retained authenticated runtime before reading one-shot launch material so lifecycle hooks rebind the driver and queued DMs can reach a clean terminal commit.

## 0.161.1

No changes in this release.

## 0.161.0

No changes in this release.

## 0.160.8

No changes in this release.

## 0.160.7

No changes in this release.

## 0.160.6

No changes in this release.

## 0.160.5

No changes in this release.

## 0.160.4

No changes in this release.

## 0.160.3

No changes in this release.

## 0.160.2

No changes in this release.

## 0.160.1

### Patch Changes

- 22f33ef: The pi connector now lists the models your own pi can run, so `models` and model pickers show them for pi.

  The connector starts a short-lived `pi --mode rpc --no-session --offline` with the environment a launch gets, sends one `get_available_models` command, and stops pi. Each id is `provider/id`, the form pi's `--model` takes. When pi is missing, holds no provider credentials, refuses, answers with something unexpected or does not answer within 6 seconds, the catalog is reported unavailable with the reason.

## 0.160.0

No changes in this release.

## 0.159.1

No changes in this release.

## 0.159.0

No changes in this release.

## 0.158.1

No changes in this release.

## 0.158.0

No changes in this release.

## 0.157.9

No changes in this release.

## 0.157.8

No changes in this release.

## 0.157.7

No changes in this release.

## 0.157.6

No changes in this release.

## 0.157.5

### Patch Changes

- a722365: Enable unused-local checks in the shared TypeScript configuration and remove unused imports and declarations from source and smoke tests. Preserve initialization, validation and build-time inbox compatibility checks.

## 0.157.4

No changes in this release.

## 0.157.3

No changes in this release.

## 0.157.2

No changes in this release.

## 0.157.1

No changes in this release.

## 0.157.0

No changes in this release.

## 0.156.0

No changes in this release.

## 0.155.2

No changes in this release.

## 0.155.1

No changes in this release.

## 0.155.0

### Minor Changes

- fb752e3: On an authenticated mesh a sender now learns which holder took an anycast request and can cancel it while it waits. A `cotal_anycast` send names the holders online at send by name and id. Just before a holder's connector shows a role request to its agent, it records its take with the delivery daemon, and the daemon sends the sender a notice naming that holder, with a second notice if the request's ack wait ran out and another holder took it. The Claude Code, Codex, Jcode, OpenCode, Hermes and pi connectors and `cotal_inbox` take only the requests they show, so a request left for a later read can still be cancelled. When more is waiting than one pi turn holds, pi fits role requests into the turn before channel posts. `MeshAgent` gains `inboxPreview` and `takeChosen` for that, and `inboxPending` for a notice that counts held requests without showing them; pi's exported `InboxSource` requires the first two. `cotal_anycast` with `seq` reads the request's status, and with `seq` and `cancel: true` cancels it while it waits; a cancel of a taken request is refused and names the taker. The daemon keeps one CAS-fenced record per request in a new `cotal_anycast_<space>` bucket, serves takes on `cotal.<space>.take.<role>.<owner>.<actor>`, and answers the new `anycastStatus` and `anycastCancel` ops on its control service (SPEC §8.1). A take carries the task stream's creation time, and the daemon refuses one from a stream since recreated. Backups exclude the bucket and `cotal restore` recreates it empty.

  Two credential shapes change. An agent credential gains a take subject for its role and for each `role:<r>` token it holds, and the delivery credential gains task-stream reads and deletes, the records bucket and a DM publish as itself. Restart the delivery daemon at this version and respawn every seat that holds a role. Until then a holder on the new connector keeps role requests unshown and reports which of the two it needs. A daemon on an older credential keeps serving durable delivery and records no takes. An open mesh is unchanged and refuses status and cancel. docs/UPGRADING.md has the steps.

## 0.154.0

No changes in this release.

## 0.153.1

No changes in this release.

## 0.153.0

No changes in this release.

## 0.152.0

No changes in this release.

## 0.151.3

No changes in this release.

## 0.151.2

No changes in this release.

## 0.151.1

### Patch Changes

- f84069e: The docs site now has a TypeScript reference for every published package, generated from source. Each of these packages' entry files gains a `@module index` comment so the reference names the main import path `index` instead of leaving it blank. The published code is otherwise unchanged.

## 0.151.0

No changes in this release.

## 0.150.0

No changes in this release.

## 0.149.0

No changes in this release.

## 0.148.2

No changes in this release.

## 0.148.1

No changes in this release.

## 0.148.0

No changes in this release.

## 0.147.8

No changes in this release.

## 0.147.7

No changes in this release.

## 0.147.6

No changes in this release.

## 0.147.5

No changes in this release.

## 0.147.4

No changes in this release.

## 0.147.3

No changes in this release.

## 0.147.2

No changes in this release.

## 0.147.1

No changes in this release.

## 0.147.0

No changes in this release.

## 0.146.0

No changes in this release.

## 0.145.1

No changes in this release.

## 0.145.0

No changes in this release.

## 0.144.0

No changes in this release.

## 0.143.0

No changes in this release.

## 0.142.0

No changes in this release.

## 0.141.11

### Patch Changes

- d389b22: A pause-plane deadline is recognized by the NATS client's TimeoutError class, so an error that only carries that name is no longer retried and then failed as a late reply.

## 0.141.10

No changes in this release.

## 0.141.9

No changes in this release.

## 0.141.8

No changes in this release.

## 0.141.7

No changes in this release.

## 0.141.6

No changes in this release.

## 0.141.5

No changes in this release.

## 0.141.4

No changes in this release.

## 0.141.3

No changes in this release.

## 0.141.2

No changes in this release.

## 0.141.1

No changes in this release.

## 0.141.0

No changes in this release.

## 0.140.8

No changes in this release.

## 0.140.7

No changes in this release.

## 0.140.6

No changes in this release.

## 0.140.5

No changes in this release.

## 0.140.4

No changes in this release.

## 0.140.3

No changes in this release.

## 0.140.2

No changes in this release.

## 0.140.1

No changes in this release.

## 0.140.0

No changes in this release.

## 0.139.1

No changes in this release.

## 0.139.0

No changes in this release.

## 0.138.2

No changes in this release.

## 0.138.1

No changes in this release.

## 0.138.0

No changes in this release.

## 0.137.0

No changes in this release.

## 0.136.8

No changes in this release.

## 0.136.7

No changes in this release.

## 0.136.6

No changes in this release.

## 0.136.5

No changes in this release.

## 0.136.4

No changes in this release.

## 0.136.3

No changes in this release.

## 0.136.2

No changes in this release.

## 0.136.1

No changes in this release.

## 0.136.0

No changes in this release.

## 0.135.21

No changes in this release.

## 0.135.20

No changes in this release.

## 0.135.19

No changes in this release.

## 0.135.18

No changes in this release.

## 0.135.17

No changes in this release.

## 0.135.16

No changes in this release.

## 0.135.15

No changes in this release.

## 0.135.14

No changes in this release.

## 0.135.13

No changes in this release.

## 0.135.12

No changes in this release.

## 0.135.11

### Patch Changes

- 24cd1ae: A pi seat now keeps the deliveries of a running turn in flight until the turn commits them, as the other connectors do. Before, a role request's ack wait could run out while the first holder was still working on it, and the broker handed the same request to a second holder of the role, so both worked on it. The batch is renewed for the length of the turn and released when its turn commits. When the in-flight ceiling is reached, a new batch waits instead of going out unprotected.

## 0.135.10

No changes in this release.

## 0.135.9

No changes in this release.

## 0.135.8

No changes in this release.

## 0.135.7

No changes in this release.

## 0.135.6

No changes in this release.

## 0.135.5

No changes in this release.

## 0.135.4

No changes in this release.

## 0.135.3

No changes in this release.

## 0.135.2

No changes in this release.

## 0.135.1

No changes in this release.

## 0.135.0

### Minor Changes

- e7fbeb8: `cotal_spawn` takes `once: true` with a `prompt` to start a helper for one task. The manager relays the prompt to the helper as its only turn and stops the helper when that turn ends or when the deadline passes. The deadline is one hour unless `deadline` sets another, and `-1` sets none. A spawn that succeeds names the task's goal in its result, and `goal-result` reads how it ended. A task that ends without the helper ending its turn may have run in part or in full, and nothing runs it again. A once spawn needs no `run` capability.

  The manager's `spawn` command takes `once: { deadlineMs }`, and the manager contract revision is 44. The task is served only after the spawn's succeeded terminal is written, so a manager that restarts before then cancels the task as never served. A seat hands a once task to its harness at most once. When it cannot confirm the harness took the task, it reports that with the new self-mode `turn-unconfirmed` command, which fails the task with `delivery-unconfirmed` and stops the seat. A manager that inherits a once seat it cannot hold ends the task without serving it, says so in the outcome, and answers that seat's every `turn-pending` with `stop` while its debt stays recorded.

  A connector declares `supportsTurnRelay` to take a once task: Jcode, OpenCode, pi and Claude Code do. A connector whose seat needs a confirmed startup declares `onceNeedsConfirmed`, and the manager serves its task only when the runtime reports the startup watch ended `confirmed`. Claude Code needs it: a once launch waits for Claude's development-channels prompt and then its `confirmNotice`, the line saying `server:cotal` messages reach the session. A runtime declares `reportsStartupOutcome` and its handles report `startupOutcome()`; the built-in pty runtime, tmux, cmux, herdr and orca do. A connector may declare `turnFrameLimit`, and a once prompt whose task does not fit it is refused at admission. A once exit registered with `registerOnceExit` may answer false to decline, and the seat then keeps reporting instead of exiting. A connector whose seat launches processes outside its own implements `retireAfterExit`, and the manager keeps the task's debt until that hook proves them gone. Jcode records each native launch of a once seat under the seat's uid for that proof, and a Jcode once seat always starts a fresh session, never one an earlier seat of the same name left in its home.

## 0.134.0

### Minor Changes

- 8b80ca6: Every connector now hands its agent the same briefing, composed once in `@cotal-ai/connector-core` (`briefing(config, harness)`): identity, orient first, feedback, mesh-first delegation, durable workflow runs, where to talk, how a peer message arrives, how to reply, attention modes and reply etiquette. Codex, Jcode, OpenCode, Hermes and pi used to carry their own shorter copies and drifted; each now adds only the sentence that says how a peer message appears in its context. `docs/agent-briefing.mdx` is generated from the module (`pnpm gen:briefingdoc`) so a wording change shows as a diff of what each harness reads, and `pnpm check:docsbundle` fails when it drifts.

  A conversation that joins through `cotal_connect` (the Claude Code plugin in a session you opened, Claude Desktop, a hosted connector) used to be told only how to connect and listen; the connect result now carries its orientation card and the briefing. The Claude Code session-start hook hands the orientation card over at startup, resume, fork, clear and compaction, or with the next prompt when the seat was not bound yet, so the model has its bearings without asking. `orientationCard()` is the one rendering the `cotal_orientation` tool, the connect result and the hook share. Hermes' `setupProfile` takes the seat's `config` to render the briefing into `SOUL.md`.

## 0.133.13

No changes in this release.

## 0.133.12

### Patch Changes

- e7f6b09: `cotal_send` refuses a channel pattern such as `team.>` before it reads or sends anything. The refusal and the advertised `channel` text say how to reach those agents: one post to a channel the pattern matches reaches the followers connected at the time, or post to each channel by name. A name that breaks the channel grammar, such as `team.**`, is refused too. It used to be rewritten onto another channel while the receipt named what was typed. In pi, `cotal_send` now returns the shared refusal instead of its own line.

## 0.133.11

No changes in this release.

## 0.133.10

No changes in this release.

## 0.133.9

No changes in this release.

## 0.133.8

No changes in this release.

## 0.133.7

No changes in this release.

## 0.133.6

No changes in this release.

## 0.133.5

No changes in this release.

## 0.133.4

No changes in this release.

## 0.133.3

No changes in this release.

## 0.133.2

No changes in this release.

## 0.133.1

No changes in this release.

## 0.133.0

### Minor Changes

- 1e554e4: Precompute documentation search at build time and load the corpus and compact index only when needed. Search results and scoring are unchanged. Documentation data now lives in two digest-checked files beside each module or bundle; normal packages, plugins and installers include them automatically. Custom integrations that copy or bundle an executable alone must also carry its matching `docs-bundle.bin` and `docs-index.bin` files.

## 0.132.7

No changes in this release.

## 0.132.6

No changes in this release.

## 0.132.5

No changes in this release.

## 0.132.4

No changes in this release.

## 0.132.3

No changes in this release.

## 0.132.2

No changes in this release.

## 0.132.1

No changes in this release.

## 0.132.0

No changes in this release.

## 0.131.6

No changes in this release.

## 0.131.5

No changes in this release.

## 0.131.4

No changes in this release.

## 0.131.3

No changes in this release.

## 0.131.2

No changes in this release.

## 0.131.1

No changes in this release.

## 0.131.0

No changes in this release.

## 0.130.2

No changes in this release.

## 0.130.1

No changes in this release.

## 0.130.0

No changes in this release.

## 0.129.9

No changes in this release.

## 0.129.8

No changes in this release.

## 0.129.7

No changes in this release.

## 0.129.6

No changes in this release.

## 0.129.5

No changes in this release.

## 0.129.4

No changes in this release.

## 0.129.3

No changes in this release.

## 0.129.2

No changes in this release.

## 0.129.1

No changes in this release.

## 0.129.0

No changes in this release.

## 0.128.7

No changes in this release.

## 0.128.6

No changes in this release.

## 0.128.5

No changes in this release.

## 0.128.4

No changes in this release.

## 0.128.3

No changes in this release.

## 0.128.2

No changes in this release.

## 0.128.1

No changes in this release.

## 0.128.0

No changes in this release.

## 0.127.5

No changes in this release.

## 0.127.4

No changes in this release.

## 0.127.3

No changes in this release.

## 0.127.2

No changes in this release.

## 0.127.1

No changes in this release.

## 0.127.0

No changes in this release.

## 0.126.3

### Patch Changes

- b526607: Fix `cotal sync` failing to seed the pi connector with `Dynamic require of "child_process" is not supported`. The package entry no longer bundles Pi's coding-agent module: the supervised project-trust handler loads Pi's trust store from the Pi host that runs the seat, and the package declares `@earendil-works/pi-coding-agent` as an optional peer.

## 0.126.2

No changes in this release.

## 0.126.1

No changes in this release.

## 0.126.0

No changes in this release.

## 0.125.0

### Patch Changes

- bd39e93: Keep supervised Pi seats out of the project-trust prompt without approving untrusted project resources, preserve saved Pi trust decisions, and report the prompt and directory when startup cannot continue.

## 0.124.3

No changes in this release.

## 0.124.2

No changes in this release.

## 0.124.1

No changes in this release.

## 0.124.0

No changes in this release.

## 0.123.0

No changes in this release.

## 0.122.0

No changes in this release.

## 0.121.7

No changes in this release.

## 0.121.6

No changes in this release.

## 0.121.5

No changes in this release.

## 0.121.4

No changes in this release.

## 0.121.3

No changes in this release.

## 0.121.2

No changes in this release.

## 0.121.1

No changes in this release.

## 0.121.0

No changes in this release.

## 0.120.2

No changes in this release.

## 0.120.1

No changes in this release.

## 0.120.0

No changes in this release.

## 0.119.5

No changes in this release.

## 0.119.4

No changes in this release.

## 0.119.3

No changes in this release.

## 0.119.2

No changes in this release.

## 0.119.1

No changes in this release.

## 0.119.0

No changes in this release.

## 0.118.3

No changes in this release.

## 0.118.2

No changes in this release.

## 0.118.1

No changes in this release.

## 0.118.0

No changes in this release.

## 0.117.1

No changes in this release.

## 0.117.0

No changes in this release.

## 0.116.5

No changes in this release.

## 0.116.4

No changes in this release.

## 0.116.3

No changes in this release.

## 0.116.2

No changes in this release.

## 0.116.1

No changes in this release.

## 0.116.0

### Minor Changes

- 50ee624: Cut what an idle seat costs its host, with stock build and runtime mechanisms.

  Every connector bundle that loads into a long-running process now ships as one-byte text. V8 holds a
  string at one byte per character only while every character is Latin-1, and a single character above
  U+00FF made each 5 MB bundle two-byte for the life of the process. The characters were em dashes and
  arrows in comments, so the bundles are built with esbuild's `--minify-whitespace`, which drops
  comments and the parentheses around a single arrow parameter, and keeps every identifier. Anything
  matching text in a built bundle sees the second part: `(e) => f(e)` now reads `e=>f(e)`. `pnpm smoke:connector-bundle-text` reads the 19 built bundles
  and fails on any character above U+00FF. Stack-trace frames keep their function names and their line
  and column numbers move, because the bundle is now fewer, longer lines.

  The Claude Code connector's seat is launched through a new entry, `dist/seat.cjs`, which enables
  Node's module compile cache in `~/.cotal/compile-cache` and then loads `dist/mcp.cjs`. Node's cache
  covers modules compiled after it is enabled, so the entry has to sit in front of the bundle. The
  directory is created 0700 like the rest of `~/.cotal`, whatever the launching umask was. A cache
  that cannot be opened prints one line and the seat serves without it,
  `NODE_DISABLE_COMPILE_CACHE=1` turns it off, and `NODE_COMPILE_CACHE` takes precedence and is left
  alone. `dist/mcp.cjs` remains the library entry (`@cotal-ai/connector-claude-code/mcp`) and still
  serves when run directly.

  The declared Node floor rises from 22 to 22.10, which is where `module.flushCompileCache()` lands,
  and every package's `engines.node` now says so. The `cotal` binary checks it at its front door and
  refuses an older runtime with the floor, the running version and the repair for how it was
  installed; the seat entry refuses before its first cache call, so an old Node gets one sentence
  rather than a `TypeError`; and the installer compares the minor version, so a host whose own Node is
  22.9 gets the pinned Node downloaded and verified instead. `node dist/mcp.cjs` still serves on an
  older runtime. Operators moving a host read
  [the upgrade note](https://github.com/Cotal-AI/Cotal/blob/main/docs/UPGRADING.md).

  Measured on one idle seat per arm, Node v22.23.2, paired and read at 160 s and 600 s: 41.9 MiB USS
  on the stock bundle, 35.2 with one-byte text, 26.3 with the seat entry's compile cache as well.

## 0.115.4

No changes in this release.

## 0.115.3

No changes in this release.

## 0.115.2

No changes in this release.

## 0.115.1

No changes in this release.

## 0.115.0

No changes in this release.

## 0.114.1

No changes in this release.

## 0.114.0

No changes in this release.

## 0.113.3

No changes in this release.

## 0.113.2

No changes in this release.

## 0.113.1

No changes in this release.

## 0.113.0

No changes in this release.

## 0.112.0

No changes in this release.

## 0.111.1

No changes in this release.

## 0.111.0

No changes in this release.

## 0.110.0

No changes in this release.

## 0.109.25

No changes in this release.

## 0.109.24

No changes in this release.

## 0.109.23

No changes in this release.

## 0.109.22

No changes in this release.

## 0.109.21

No changes in this release.

## 0.109.20

No changes in this release.

## 0.109.19

No changes in this release.

## 0.109.18

No changes in this release.

## 0.109.17

No changes in this release.

## 0.109.16

No changes in this release.

## 0.109.15

No changes in this release.

## 0.109.14

No changes in this release.

## 0.109.13

No changes in this release.

## 0.109.12

No changes in this release.

## 0.109.11

No changes in this release.

## 0.109.10

No changes in this release.

## 0.109.9

No changes in this release.

## 0.109.8

No changes in this release.

## 0.109.7

No changes in this release.

## 0.109.6

No changes in this release.

## 0.109.5

No changes in this release.

## 0.109.4

No changes in this release.

## 0.109.3

No changes in this release.

## 0.109.2

No changes in this release.

## 0.109.1

No changes in this release.

## 0.109.0

No changes in this release.

## 0.108.1

No changes in this release.

## 0.108.0

No changes in this release.

## 0.107.0

No changes in this release.

## 0.106.1

No changes in this release.

## 0.106.0

No changes in this release.

## 0.105.1

No changes in this release.

## 0.105.0

No changes in this release.

## 0.104.2

No changes in this release.

## 0.104.1

No changes in this release.

## 0.104.0

No changes in this release.

## 0.103.4

No changes in this release.

## 0.103.3

No changes in this release.

## 0.103.2

No changes in this release.

## 0.103.1

No changes in this release.

## 0.103.0

No changes in this release.

## 0.102.0

No changes in this release.

## 0.101.7

No changes in this release.

## 0.101.6

No changes in this release.

## 0.101.5

No changes in this release.

## 0.101.4

No changes in this release.

## 0.101.3

No changes in this release.

## 0.101.2

No changes in this release.

## 0.101.1

No changes in this release.

## 0.101.0

### Patch Changes

- 6e4ad65: Call the inbox commit in `PiDriver.finalizeEnd` as a plain statement. The method bound the commit counts to a local it never read, which suggested a later use that did not exist. Behavior is unchanged.

## 0.100.2

No changes in this release.

## 0.100.1

No changes in this release.

## 0.100.0

No changes in this release.

## 0.99.3

No changes in this release.

## 0.99.2

No changes in this release.

## 0.99.1

No changes in this release.

## 0.99.0

No changes in this release.

## 0.98.0

No changes in this release.

## 0.97.1

No changes in this release.

## 0.97.0

No changes in this release.

## 0.96.1

No changes in this release.

## 0.96.0

No changes in this release.

## 0.95.2

No changes in this release.

## 0.95.1

No changes in this release.

## 0.95.0

No changes in this release.

## 0.94.7

No changes in this release.

## 0.94.6

No changes in this release.

## 0.94.5

No changes in this release.

## 0.94.4

No changes in this release.

## 0.94.3

No changes in this release.

## 0.94.2

No changes in this release.

## 0.94.1

No changes in this release.

## 0.94.0

No changes in this release.

## 0.93.0

No changes in this release.

## 0.92.2

No changes in this release.

## 0.92.1

No changes in this release.

## 0.92.0

## 0.91.0

## 0.90.1

## 0.90.0

## 0.89.0

## 0.88.0

## 0.87.0

### Patch Changes

- af82e8d: A seat's launch-material directory (`cotal-launch-*` in the OS temp dir, holding the broker URL, the creds path and the control token) is now removed when the seat's process exits. Before this change a Claude seat left it behind after `cotal stop`, while the persona file and control socket of the same launch were removed. `materialEnv` in `@cotal-ai/connector-core` now takes the launch's artifact array as a second, required argument and appends the material's private directory to it, and every connector returns that array on `LaunchSpec.artifacts`, so the manager, the pty runtime and the foreground `cotal spawn` remove it the way they remove a persona file. Each connector now writes the material after its last refusal, so a refused launch leaves no material file behind. The second material file the Hermes launcher writes for its gateway child is not covered by this change.

## 0.86.0

## 0.85.0

## 0.84.0

## 0.83.0

## 0.82.2

## 0.82.1

## 0.82.0

## 0.81.1

## 0.81.0

## 0.80.0

### Minor Changes

- fded3ab: A seat never leaves the mesh because its event plane stopped, and the plane comes back on its own. The emitter holder re-establishes the plane at once after any failure, then every second while it stays down, by a fresh start that replaces the emitter: it reopens the write-ahead log, settles any pending frame, and builds the connector's mapper from the run the log has open before reading on. A turn that ends while the plane is down keeps its terminal, as does one whose terminal's own log write failed, and the re-establish closes that run with it once it has read on; every turn that ends during one outage keeps its own terminal, placed on the last turn the source had begun at the position the terminal was reported at (a turn the mapper opens no run for takes its terminal and publishes nothing, and a repeated terminal replaces nothing), a terminal is owed to its run until the frame carrying it freezes, a terminal reported with the plane up goes to the emitter at the hook too so a flush still reading when the next prompt lands closes the turn with its own terminal, and when the next prompt was already written before the plane came back the failure is published in place of the finish that prompt would have synthesized, in a frame of the failed run and ahead of the next run's first. The mapper contract gains `{ turn: true }` for a record that begins a turn and opens no run. `DurableSource` gains `end()`, the cursor after the last complete record as of the call, which every connector's source implements; the holder's hooks gain `sourceEnd`, `closeRun` returns a promise that resolves once that position is read (the Claude Code hook awaits it before replying), and the emitter takes a `ReportedTerminal` through `queueTerminal`, with `waitingTerminals`, `takeOwed`, `unsettled` and `seedLastTurn` beside it. The wait between attempts is fixed: it neither doubles nor caps, so the plane is back within a second of the fault clearing. The pi adapter's start factory, re-entered by the re-establish, checks the native file instead of reading an acknowledged cursor as a vanished file, and seeds its mapper from the pending frame. A transcript line that is not a record is stepped over and reported on every connector, the jcode journal wrapper included, and one written past the position a terminal was reported at does not hold that terminal: it is placed after the records before it, as is a terminal reported past a record no read answers, such as an OpenCode part still filling when its turn died, which used to hold the turn end reading the session without end; the OpenCode source now reads every record at or before the end reported at a turn end as settled, so that part no longer stops the turns after it from publishing. A terminal reported while the very first start is still waiting on the broker reaches the emitter before its first read, where it used to be queued behind the flush that read past it and close the next turn. On a space that requires events the seat used to exit with code 1 instead; for Claude Code that exit was the "MCP server cotal has disconnected" banner, and Claude Code restarted the server on the next tool call. The `eventPlaneStopped` sink no longer takes `required` or `stopSeat`, the holder's `onError` receives the delay before the next re-establish (`0` for at once) and `retryMs` is that fixed wait, the Claude and OpenCode mappers take `resumeRunId`, and a reported unreadable-line reason carries no text from the record itself.

## 0.79.0

## 0.78.1

## 0.78.0

## 0.77.1

### Patch Changes

- a1948eb: The Codex and Jcode hosts now arm the event plane when the session's registration requires events, even without `COTAL_EVENTS`. They used to read only that flag, so a hand-driven user-mode launch with `COTAL_EVENTS_REQUIRED=1`, or a custom launcher that passed `eventsRequired` with events opted out, ran with no event plane and the required-events policy never applied. The Claude, OpenCode, Codex, Jcode and Pi launches that carry `eventsRequired` now also set `COTAL_EVENTS` and the workspace root when the launcher passed `events: false`, so the armed session has a place for its event log. Both decisions go through `launchArmsEvents` and `eventPlaneArmed` in `@cotal-ai/connector-core`; an OpenCode 2.x session still reads only `COTAL_EVENTS`.

## 0.77.0

## 0.76.0

## 0.75.0

## 0.74.0

### Patch Changes

- ad81083: The connector on/off flags `COTAL_CHANNEL`, `COTAL_EVENTS`, `COTAL_EVENTS_REQUIRED`, `COTAL_CODEX_TUI` and `COTAL_JCODE_TUI` now share one parser in `@cotal-ai/connector-core`. It accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` in any case, treats an unset or blank value as unset, and refuses anything else at startup with an error naming the variable and the value. Before, each connector kept its own copy and read any other value, such as `enabled`, `2` or `y`, as off without a word. The OpenCode 2.x adapter now refuses `COTAL_EVENTS=true` the same way it refuses `COTAL_EVENTS=1`, where before only `1` was refused.

## 0.73.0

## 0.72.1

## 0.72.0

## 0.71.0

## 0.70.2

## 0.70.1

## 0.70.0

### Minor Changes

- 76113ce: `AguiEmitterHolder` now takes its hooks as one named object after the emitter factory, `new AguiEmitterHolder(startEmitter, { onError, onRunClosed, waitLive, runMeta })`, typed by the exported `AguiEmitterHolderHooks`, where only `onError` is required. Before, the four hooks were positional, and a `runMeta` provider passed third was accepted as `onRunClosed`: it typechecked, ran after the run had already closed, and its metadata was dropped with no error. A caller no longer fills earlier slots with `undefined` to reach a later hook. The Claude Code, Codex, jcode, OpenCode and pi connectors pass their hooks by name, with no change in behavior.

### Patch Changes

- 95788eb: A seat whose AG-UI event plane stops for good now follows the space's policy on every connector. On a space that requires events the seat stops, where Pi, Claude Code and OpenCode used to keep it running without events. On any other space the seat keeps running and its log records `AG-UI emitter stopped`, where Jcode used to stop the seat and refuse further turns. Codex no longer rebuilds a stopped plane at its next turn boundary on any space, and it now waits for the mesh before starting its emitter, as the other connectors do. The rule is `eventPlaneStopped` in connector-core, which each connector passes its log sink and its stop hook.
- 8dbfb8e: A pi seat now marks a run turn as shown once the provider takes the request that carries it, instead of after the whole Pi turn ends. A `cotal_yield` made during that turn used to be refused with "no turn is active — nothing to yield", and the run then recorded `done` where the seat had said `blocked` or `handoff`. On a transport that reports the provider response, the unshown turn was also injected again after every response, so the Pi turn never ended and the run turn ran out its deadline. A transport without that report shows the turn when Pi runs a tool from the answer, or at the clean end of the turn.

## 0.69.0

## 0.68.0

### Minor Changes

- 585fdb2: Connectors launch on the model and variant their launcher resolved. `LaunchOpts.model` and `LaunchOpts.variant` are now the launcher's resolved values (the flag, else the agent file's `model:` / `variant:`), and every connector renders them as given instead of reading the agent file again in `buildLaunch`. Before, a model the launcher did not resolve was taken from a later read of a file that could have changed since, so the seat could run a model the launcher never checked or recorded, and a supervised restart re-read it each time. The in-session config takes the model and variant from `COTAL_MODEL` / `COTAL_VARIANT` only, so the card and the orientation pin no longer report a model the seat was not launched on. The Hermes connector no longer falls back to `HERMES_MODEL` from the spawning process, including one `spawn.env` forwards; set the model with `--model` or the persona's `model:`. Code that calls `buildLaunch` directly must pass `model` and `variant` itself.

## 0.67.0

## 0.66.1

## 0.66.0

## 0.65.0

## 0.64.0

## 0.63.0

## 0.62.0

## 0.61.0

## 0.60.0

### Patch Changes

- 3b616a2: A manifest agent can declare `continuity: exact` to come back in its previous harness session. The manager records the session the connector proves over its authenticated control endpoint on the first launch, keeps that record current through crash recovery, preserved resume and stop, reopens it on every later launch and preserved resume under the same proof, and refuses one recorded for another space, connector or directory. A reopen fails when the harness no longer has the session rather than starting an empty one under the same id: connectors declare the new `supportsSessionReopen` capability and honor `LaunchOpts.reopenSession`, and Pi reopens with `--session`. Preflight refuses `exact` on a connector that cannot reopen an existing session.

## 0.59.0

### Patch Changes

- 5f13124: Private launch files now have an owner. The Claude persona file, the Claude shared-server MCP config file and the pi persona file are listed on the new `LaunchSpec.artifacts`, and the launcher removes them once it has proved the agent process gone. On the default pty runtime the manager removes them when it sees the agent exit; on tmux, cmux, orca and herdr the manager removes them by polling the seat's status and waiting for the runtime's exit proof; the foreground `cotal spawn` removes them when its child exits. Every one of those launches also starts its child through the new core `reclaimWithChild`: a watcher started beside the child removes the files once the child's process is gone, and tries a failed removal again every five seconds until it succeeds, so a killed manager or foreground `cotal spawn` no longer strands them (POSIX; Windows has no shell for the watcher). Each directory name carries a random per-launch identity, so a stale path can never name a later launch's directory. The tmux, cmux, orca and herdr runtimes now throw the new core `SpawnRefused` for an unsafe name, an unreachable backend, (herdr) a missing working directory or an unknown layout, (orca) a working directory that is missing or outside any Orca worktree, and a launcher script they cannot write or (tmux, herdr) a session or server that will not start, all before the agent's command is handed to the backend, and the manager removes the files at once. A removal that fails, after an exit or after a refusal, is tried again until it succeeds. A batch resume removes the files of specs it built and never launched. Both connectors now refuse a bad model, prompt or launch option before writing anything. Any other spawn that throws is not proof that nothing started, so its files stay for the child's watcher, or for the OS temp reaper when no child started, as do a killed launcher's on Windows. A seat started under a custodian with `launchSeat` from `@cotal-ai/seat`, which the manager no longer does for a new launch, hands them to that custodian: a launch it refuses before any process started removes them at once, the custodian removes them when it sees the agent exit, a removal that fails stays on the custody record, and a reap that proves the seat gone removes what the record still lists from the temp dir the launch wrote to, so a successor with a different `TMPDIR` still removes them. Losing a custodian's connection no longer counts as the agent's exit. The docs now say that owner-private means any process running as the same user can read the file while it exists.
- 8ce6be3: The 0.33.0 changelog entry "An agent now reads only the channels it lists" now carries a correction. It presented the read-set default-deny as new in 0.33.0, but that shipped in 0.28.0 with #821, so upgrading from 0.28.0 or later needs no migration for it. The correction names what 0.33.0 did change: the no-default-channel check in `multicast` now refuses only an omitted channel, so an explicit empty-string `channel` is no longer refused as if it were omitted, and its refusal is reworded; the `cotal_send`, `cotal_leave` and pi tool text; doc comments; and two regression suites. `docs/release.md` now describes how to correct a released entry.

## 0.58.0

## 0.57.0

## 0.56.1

### Patch Changes

- 6b76946: A seat resumed from a preservation cut backfills its channels from the chat stream sequence its prior incarnation had reached instead of replaying the whole retained window.

## 0.56.0

## 0.55.0

### Patch Changes

- cb869b7: A pi seat held after a non-terminal `agent_end` (error or an unknown stop reason) with a Cotal batch pending now has a bounded exit: the driver retries the continuation itself a fixed number of times with a fixed backoff, through the same send path a human continuation uses, before holding for operator intervention with a presence that names the attempt count and what to do. User abort still holds without any automatic retry: the person who aborted is the party who continues. Fixes #726
- d284ee6: A manifest or spawn prompt on a connector that cannot deliver one is refused at preflight (including `up -f --dry-run`), at spawn and in the manager, the way an unsupported model variant is: connectors now declare `supportsPrompt`, and claude, opencode, codex, jcode and pi declare it; hermes keeps its launch-time throw as the second line of defence.

## 0.54.0

## 0.53.0

## 0.52.1

## 0.52.0

### Patch Changes

- 3322a2c: The pi adapter hands pi the plain Zod JSON Schema render instead of a TypeBox-branded copy, so a JSON round-trip of every tool's parameters carries only schema keywords and a strict provider no longer refuses the declarations.

## 0.51.0

### Minor Changes

- ec8649b: Preserve the closed required-events registration policy and enforce it across discovery, launch,
  grant coverage, direct connector sessions, and trusted upgrades of existing manual registrations.

### Patch Changes

- 7885a2b: Publish Pi's native persisted assistant and tool boundaries as durable AG-UI events at completed-message granularity.

## 0.50.1

## 0.50.0

### Patch Changes

- 0a52594: Census the in-process half of the ambient-environment rule. `smoke:suite-ambient-env` grades the environment a suite hands a child; the new `smoke:suite-ambient-env-self` grades a suite that reads its own `process.env` through `configFromEnv` and friends, and requires a module-scope `COTAL_` prefix scrub before that first read. The connector suites in the class now scrub the whole prefix instead of dropping one variable, so running them from inside a connected session no longer dies in its own import on the one-identity-plane refusal.

## 0.49.0

### Minor Changes

- 36d1779: Issued authority and run admission (SPEC 13.15, 14.8). A static credential is now an issuance: the issuer records its permission ceiling as evidence under a fresh generation before the material exists, its endpoint rows ride the versioned `ep.v1` rail with that generation pinned beside the caller triple, and a connected client reads its generation from an issuer-written accepted row. A hosted workflow run is admitted under the starting caller's resolved ceiling, recorded once per run in a dedicated admission store the driver cannot write, checked before every channel effect (wait open, fetch, recorded re-read, conclave writes), and revoked by an independent create-only marker that ends open waits at their next poll and refuses resume, takeover and reconcile. `run-start` on the legacy rail is refused with `permission-denied` and the `ai.cotal.ep.unbound-caller-authority` detail. `cotal run start --local` takes `--admit-read` and `--admit-publish` (required) and `cotal run revoke <runId> --local --by <who> --reason <text>` writes the marker. Three new per-space stores (`cotal_issued_`, `cotal_accepted_`, `cotal_admission_`), immutable at the broker: the admission and accepted stores are write-once per key, the evidence store is append-only and read first-on-key, and all three refuse rollup headers, message deletes and purges, so a holder of its own key row can neither widen nor erase what was recorded. Two new one-shot profiles (`issuer`, `run-admitter`), an admission read on the run mediator and operator profiles, and `COTAL_ACCEPTED_TOKEN` on every connector's spawn environment. Breaking pre-1.0 authority change.

## 0.48.2

## 0.48.1

## 0.48.0

## 0.47.1

## 0.47.0

## 0.46.0

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

### Minor Changes

- a87709c: Every cotal-lang effect now performs on the mesh: the durable-action group is built end to end and
  the not-yet-durable seam is gone.

  `spawn` submits a real manager goal and returns the allocated seat's handle, and meters the
  agent's `permits` (`turns`, `wallClock`; the turn that would exceed one is L4001, and a budget the
  host cannot meter is refused at spawn); `conclave` opens a scoped sub-team as durable membership
  rows; `ask` parks schema-checked pauses answered through `cotal run answer` and tells the agent
  over the turn relay, one relay per attempt carrying the schema, the attempt and the previous
  refusal, which every connector's intake renders with the answer command; `monitor` registers the
  handle on its journal entry and `wait(down)` reads a monitored incarnation's death off presence
  liveness, refusing an agent nobody monitored.
  `turn` rides a new pull-shaped manager relay: the manager serves `turn` (targeted, the
  despawn/input reach) plus `turn-pending` and `turn-yield` (self reach, manager contract revision
  10), holds the payload on the goal-index note, pins the goal to the seat's incarnation, and denies
  at a goal-bound deadline hold; the seat side (all connectors) pulls pending turns, surfaces them
  two-phase into host context, auto-yields `done` when the host turn ends, and yields `blocked` or
  `handoff` through the new `cotal_yield` tool; the run client renders context with pending notices,
  arms its own pause on the acceptance's deadline as the L4003 authority, watches presence as the
  L4002 authority (a death the manager marks on the deadline terminal reads the same way), and
  honors handoffs (L4005/L4004 validation, the `handoffFrom` goal chain); the manager shows a seat
  one turn at a time. The relay holds on an auth mesh: the agent baseline gains the self-mode
  `turn-pending` and `turn-yield` rows, the operator seat-write set (`control-caller-admin`, the
  `admin` capability) gains `turn` beside `input`, and the manager mints the deadline hold's
  schedule over its serve connection and owner-expires the hold once due instead of reading a
  fire it holds no grant for. `wait(replied)` observes the run's own turn terminals as a level, and never a
  turn the run itself ended without an accepted yield. A `spawn` may bind a logical worktree: the
  validator rejects two literal-worktree spawns in one concurrent scope (L3022, named branch
  functions included) and the runtime claims a tree before it submits, refusing a second spawn into
  a tree held by a live seat or by a spawn in flight (L4008), with sequential reuse the moment the
  holder's presence lapses. A spawn refused at accept is L4000 (L4001 for seat capacity) and one
  whose seat never came up is L4002; an `ask` whose deadline passes with no conforming record is
  L4006; a fork copies a spawn that said `onFork: "adopt"` and refuses one that would have to
  respawn (L5019). The run driver re-issues
  recorded-but-undischarged cancellations at adoption, so recovery does not wait for completion to
  release a dead loser's seat, pause, or tree. A migration's `--adopt <handle>` hands the orphaned
  seat to the edited program's next spawn of that persona, and `--release <handle>` despawns it at
  commit through the run's own discharge; both name the agent the step spawned, and a spawn that
  produced none is an orphan like a sleep; the adopting spawn binds the orphaned spawn's goal as
  its own, so a resume re-reads the seat and a cancellation despawns it. A turn accept the manager
  cannot finish unwinds to a failed terminal on its bound goal, and a retry of it is refused naming
  that terminal. The delivery daemon hosts the checkpoint timer writer, so mediated deadlines fire
  with no suite pump.

## 0.41.4

## 0.41.3

## 0.41.2

## 0.41.1

## 0.41.0

## 0.40.0

## 0.39.1

## 0.39.0

### Minor Changes

- 34ff272: `cotal run`, the workflow-run operator surface, self-registered by `@cotal-ai/runtime` and composed
  into the `cotal` binary: `start --file <program>` drives a new run on the mesh handler, `resume
<runId> --file <program>` takes an existing run over and drives it to quiescence, `ps` lists an
  endpoint's run records (state, holder, journal high-water, fork lineage), `journal <runId>` prints
  the durable step journal, and `answer <runId> <stepKey> --by <who> [--value <json>]` resolves an
  open checkpoint through the run driver, presenting as the arming holder read back from the
  checkpoint record (resume is holder-bound). One raw connection per invocation against the resolved
  mesh target; the journal's result bound is taken from the broker's own max_payload.

  `docs/workflows.md` gains an "Operating a run" section, the connector docs bundle carries it, and
  every connector folds a workflow steer (`WORKFLOW_STEER`) into its agent instructions beside the
  mesh-first steer, so agents reach for a durable journalled run instead of improvising long
  coordination loops in their own context.

## 0.38.0

## 0.37.0

### Patch Changes

- e703873: Report connector harness availability at manager boot and expose resolved binary paths in status.
- c4094cb: Drop inherited `COTAL_LAUNCH_MATERIAL` from suites that default `COTAL_SERVERS` then call `configFromEnv()` on `process.env`, so `pnpm test` no longer trips the one-identity-plane refusal inside a managed seat.

## 0.36.0

## 0.35.0

## 0.34.0

## 0.33.9

## 0.33.8

## 0.33.7

## 0.33.6

## 0.33.5

## 0.33.4

## 0.33.3

## 0.33.2

## 0.33.1

## 0.33.0

### Minor Changes

- ba74c84: An agent now reads only the channels it lists. An omitted or empty read set means **no channels**,
  where it previously meant `general`: the agent-file loader, the provisioner, the credential mint and
  the endpoint each defaulted an absent read set to `["general"]`, so any persona that simply did not
  mention channels was subscribed to `general` by code and had the matching channel read row baked
  into its credential.

  An agent on no channel is still a full mesh peer: it appears on the roster and sends and receives
  DMs and anycasts, and the same default-deny that already governed `allowPublish` now governs reads.
  An empty list and an omitted one mean the same thing, for both read keys. That has one consequence
  worth stating plainly: when **both** are omitted, `allowSubscribe` falls back to the read set and so
  resolves empty too, which leaves the agent unable to `cotal_join` a channel at runtime. Give it an
  explicit `allowSubscribe` if it should be able to join one later.

  With no concrete channel there is no default broadcast target, so a send with no explicit channel is
  refused with a message saying so, rather than resolving to `general`. Leaving your last channel is
  allowed and always was; the `cotal_leave` description said otherwise and now says what actually
  happens, including that the default send channel is gone until you join one.

  Migration: **list `general` explicitly if you want it.** A hand-written persona that relied on the
  old default needs `subscribe: [general]` added.

  This changes the default `cotal setup` install as well. The seeded `default_agent` carries
  `subscribe: []`, which used to resolve to `general` and now resolves to no channel; it keeps
  `allowSubscribe: [">"]`, so it can still `cotal_join` anything, it just no longer arrives on a
  channel it never asked for — which is what its own seed comment already described.

  Already-running agents are not narrowed retroactively: a live seat keeps the read ACL its credential
  was minted with, across renewal, until it is respawned.

  **Correction:** the read-set default-deny described above is not new in 0.33.0. It shipped in 0.28.0
  with 86f6b10 (#821, "Remove the implicit `general` channel floor"), and so did the refusal of a send
  with no channel and the no-channel default for the seeded `default_agent`. Upgrading from 0.28.0 or
  later needs no migration for it. What 0.33.0 changed is narrower. The no-default-channel check in
  `multicast` now refuses only an omitted channel (`channel === undefined` where it was `!channel`), so
  an explicit empty-string `channel` is no longer refused as if it were omitted, and the refusal now
  says to name or join a channel. The `cotal_send` and `cotal_leave` tool descriptions and pi's send
  call line no longer name `general` as a default or say the last channel cannot be left, doc comments
  state the rule and the both-keys-omitted consequence, and the `smoke:no-implicit-general` and
  `smoke:session-channels` suites guard it.

## 0.32.0

## 0.31.0

### Minor Changes

- 4ef59c3: A spawned seat now receives a constructed environment (PATH/HOME/locale, the machine-wide COTAL\_\* knobs, connector-declared provider keys) instead of the manager's ambient environment. Host-session markers such as CLAUDE_CODE_CHILD_SESSION no longer leak into seats and silently disable transcript saving. The Claude connector declares CLAUDE_CODE_OAUTH_TOKEN (and the rest of claude's documented credential set) so a container seat still authenticates; spawn.env remains the explicit opt-in for extra names, including a host marker a persona has chosen to receive.

## 0.30.2

## 0.30.1

## 0.30.0

### Minor Changes

- 569f4d3: An empty message id is never a dedup key, and an id-less delivery is individually addressable at the drain seam.

  Two distinct messages that each carry an empty id collapsed to one: the receiver-side id
  dedup read empty-equals-empty as a duplicate, silently dropped the second, and once the
  first was handled it dropped every later empty-id message on arrival. Measured live, two
  such messages arrived on the wire and only the first was ever delivered.

  An empty id is now treated as no id: the ingest coalescing (pending, handled, protected)
  is skipped for it in both directions, so distinct messages that carry an empty id are all
  delivered. At the drain seam a per-delivery receive key (the wire id when there is one, a
  per-session secret-namespaced minted key when the id is empty, never on any wire) is what
  hosts, adapters, and the exact-key drain select by: cotal_inbox, the Claude Code hooks,
  the OpenCode plugin, the Codex host, the Hermes bridge and its Python sidecar, and the pi
  driver. The drain API is renamed for what it takes (drainInboxDeliveries, missingKeys).
  Eviction classification, in-flight holds, scope routing, the focus-recall tie-break, and
  the scoped drain's selection no longer key on the empty id either. The Hermes bridge no
  longer wedges on an empty-id message. Delivery pumps in core now treat an absent or
  non-string id as a malformed envelope per SPEC section 5 (durable terminate, live drop,
  history and recall skip).

  What this restores: before the receive key, an id-less delivery was unaddressable: the
  raw id swept every pending empty-id item in one drain call, and once filtering closed
  that, the item could never be drained or acked, was re-shown on every windowed inbox
  read, and on a durable channel accumulated as an unretirable entry until the 200-entry
  overflow valve evicted it, roughly a model turn of churn per entry, while one hostile
  empty-id ambient publish self-drove back-to-back host turns on the pi adapter. This was
  a violation of the SPEC section 8 ack-only-after-surfaced obligation at the receiver,
  not only an adapter defect.

  The cost is stated rather than hidden: with no id there is no coalescing either, so a
  redelivered copy of an empty-id message can surface twice on a path that is already
  at-least-once (live remains at-most-once). Dedup for real ids is unchanged: their
  receive key is their wire id and their coalescing is untouched. SPEC section 4, section
  7 item 5, section 8, and section 12 item 12 now state the receiver-scoped rule, and the
  client-builder guidance mirrors it.

  One named follow-up stays open: Plane-3 durable fan-out derives its publish msgID from
  the message id, so distinct empty-id messages can still be collapsed inside the broker's
  duplicate window on a durable channel before this receiver sees them. That path is its
  own issue; this change's guarantee is the receiver.

## 0.29.2

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

### Patch Changes

- 3866fdc: Let already-running managed Pi seats adopt crash recovery after an extension reload. Seats launched before the session-state environment variable existed derive the same lifecycle-keyed state path from their manager-owned persona file and lifecycle UID, then record the active Pi session atomically. Fresh managed seats also receive a Pi-native exact session ID before their first turn, so an idle seat is recoverable.

## 0.25.0

### Minor Changes

- a087c2b: A spawned agent now inherits the operator's environment. A harness you installed and configured
  should behave under `cotal spawn` the way it behaves when you run it yourself, and the alternative
  was Cotal maintaining a list of inference vendors: every new provider needed a change in Cotal
  before it would work through a managed spawn. `MODEL_PROVIDER_KEYS` and the per-connector lists
  that extended it are gone, and Cotal no longer names an inference vendor anywhere in its source.

  Cotal still resets its own `COTAL_*` namespace before the child starts, keeping the machine-wide
  knobs (`COTAL_HOME`, the feedback set, the default-agent pair, the `*_BIN` overrides, the timing
  knobs). That reset is not configurable, because it is identity and not preference: a connector
  supplies the per-session names for each child and does so conditionally, so an inherited value is
  never overwritten and would hand an agent another agent's credential path, ACL, or lifecycle uid.
  The whole prefix is stripped rather than a named list, because which names a connector sets varies
  between connectors and a deny-list only ever names what its author remembered.

  To confine a spawned agent instead, declare `spawn.env` in the cotal config file. The child then
  gets a fixed OS allow-list plus exactly the names you list. An empty array is a real policy meaning
  the OS allow-list alone. Note what this does and does not buy: `HOME` is forwarded either way, so
  an agent with a shell reads `~/.aws` and `~/.ssh` regardless, and this protects only secrets that
  live nowhere but the environment.

- 0b602e4: Managed Pi sessions can now fork an existing Pi transcript into the mesh and recover the exact active Pi session after an unexpected process crash. The Pi adapter reports session changes through its authenticated local control endpoint and an owner-only atomic state file; the manager preserves the Cotal identity, lifecycle UID, credentials, children, and durable inbox across up to three restarts in two minutes, then retires a crash loop loudly. Deliberate stops never restart.
- 34caaf4: Agent seats no longer export their connection material into the environment every descendant
  process inherits. The broker URL, the creds path, the auth token, the user-mode identity and the
  local control token now ride a private 0600 launch-material file whose path is the only thing in the
  seat's environment; pi, codex and OpenCode drop even that path once they have read it (for OpenCode
  that happens in the `opencode serve` process its seat shim starts, which is also what runs the
  session's tool calls), while claude and hermes keep the reference because their readers are
  short-lived children that start later. A session driven by hand still sets `COTAL_CREDS` / `COTAL_SERVERS` itself, and a
  launch that carries both carriers is refused rather than resolved by precedence.

### Patch Changes

- bf07e45: Wrap visible Cotal inbox and tool text by terminal columns instead of JavaScript string length. Emoji and CJK text can occupy two terminal cells per code point; a peer status line containing two check marks was emitted at 122 cells in a 120-column Pi TUI and terminated the process. The Pi adapter now uses the host's canonical ANSI/grapheme-aware wrapper, with a regression fixture from the live crash.

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

### Patch Changes

- 219d33c: `cotal spawn --agent pi --prompt <text>` now delivers the prompt as Pi's initial message (its first turn) instead of silently dropping it; an empty prompt, or one starting with `-` or `@`, refuses the launch. The connector contract no longer describes an initial prompt as something a connector may ignore: a connector delivers it or throws at launch. The other connectors follow the same rule: Claude Code and Codex refuse a prompt that is empty after trimming instead of dropping it, and Hermes refuses an initial prompt outright until its first turn is wired.

## 0.20.1

## 0.20.0

## 0.19.0

### Minor Changes

- 4e8d776: The `cotal_*` tools now refuse an argument they do not model instead of silently
  dropping it. A call carrying an unmodelled key (`owner` or `actor` alongside the
  real arguments) previously succeeded with that key stripped before the tool ran,
  so the caller was told nothing and the tool did something other than what was
  asked. It is now refused by name, on every adapter and on every tool: the MCP
  renderers and pi publish a closed schema and the host rejects the call, while
  OpenCode and Hermes pass the caller's object through untouched and are closed at
  the connector's own dispatch. Tools that take no arguments are closed too: they
  were previously published with no schema at all, so a host had nothing to check
  against and forwarded the extras to be dropped, as is `cotal_inbox`, whose
  arguments four of the connectors replace with their own. Behaviourally breaking
  for any caller that was relying on extra keys being ignored. Every refusal names
  the rejected keys; where the connector is the one refusing it also lists the
  arguments the tool accepts, or says it takes none.

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.11

## 0.14.10

## 0.14.9

## 0.14.8

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.2

## 0.13.1

## 0.13.0

### Minor Changes

- 5491661: v0.4 endpoint control surface: a breaking wire revision (SPEC section 13).

  Adds the endpoint control surface: the `ep` request rails and grant grammar, the
  message envelope and error catalog, the callable-service verbs, and the session
  and virtual-endpoint composites. Deletes the v0.3 `ctl` rail (the hard cut).
  Requires nats-server 2.12 or newer, since the auth marker store uses native
  per-message TTL; clients read the server version from the pre-auth INFO and fail
  loud below the floor.

  Completes the agent lifecycle end to end: registration, admission, despawn,
  retirement, and safe name reuse, backed by a lifecycle registry, a credential
  ledger, and a retirement barrier. Durables are keyed by lifecycle uid, so a
  manager-resumed agent recovers its original incarnation rather than re-minting,
  and readiness is incarnation-exact. The connectors forward the lifecycle uid into
  spawned children so a child joins as its intended incarnation.

  From v0.4 an AgentCard MUST advertise `protocolVersion "0.4"`; a participant that
  omits it is treated as pre-0.4 and is not addressed on the endpoint rails.

## 0.12.0

## 0.11.6

## 0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.

## 0.11.3

### Patch Changes

- 1a954e8: Add the Pi host-native connector with confirmed custom-message delivery, cooperative shutdown, and a standalone extension artifact.
  - @cotal-ai/core@0.11.3
  - @cotal-ai/connector-core@0.11.3
