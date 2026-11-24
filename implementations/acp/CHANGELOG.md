# @cotal-ai/acp

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
