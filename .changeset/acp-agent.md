---
"@cotal-ai/acp": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/pi": minor
---

T3 Code, Zed and other Agent Client Protocol clients can now spawn and drive Cotal agents through the new `@cotal-ai/acp` extension and its `cotal acp` command.

`cotal acp` serves ACP v1 on standard input and output. A client thread is one managed agent: its first prompt spawns the agent through the space's manager in the thread's folder, with the model, reasoning variant, persona, channel and machine the thread chose, and the agent keeps running when the client closes. The thread follows the agent's event channel, so an application without an event plane is not offered. Session list shows the managed agents in a folder, loading one replays what its event channel still holds, deleting one hides that run, and `/despawn`, `/roster` and `/channels` answer in the thread. A later prompt is typed into the agent's terminal through the manager's `input` command, so it arrives as the user's own words, and its turn ends once the agent has started working and stopped again. An agent whose runtime owns no terminal input, such as tmux, refuses it, and the prompt fails with the manager's reason. A client that runs terminals is offered a sign-in that runs `cotal login` or, with no space recorded, `cotal setup`. Stopping a turn interrupts the agent through the manager's new `interrupt` command, and the turn ends as cancelled, also when the agent cannot be stopped. Forwarding an agent's questions is not available yet. `@cotal-ai/cli` names the package when `cotal acp` runs before the extension is added, and `@cotal-ai/workspace` records `acp` as a Cotal home entry and offers the `input` and `interrupt` control calls.

The manager serves a new targeted `interrupt` command, contract revision 52. It writes the key a seat's connector declares in the new `Connector.interruptKey` into the seat's terminal, and it is granted as `input` is. The Claude Code and Pi connectors declare Escape.

On a space where people sign in, a person now controls every agent under their own owner without the `admin` scope. Their manager view carries `inspect` and `ps` and owner-mode `input`, `interrupt`, `despawn` and `attach`, whatever their scope, and their sign-in reads those agents' event channels live and through its own history reader. These rights come from the ledger row being a person's, never from a scope token, so no agent credential holds them. They ride the person's sign-in, so a program running as that person where they are signed in can use them. `cotal acp` reads through that sign-in, takes your managers from the auth service's `/manager-instances` list, reads your agents from every live one, sends each agent's commands to the manager that holds it, and names each agent `acp_<id>`, a valid actor name there. A thread loaded without a grant that may spawn offers only the agent's own model and cannot start another, and `cotal acp` stops, sending nothing, when the machine's sign-in is granted again or changes account. `@cotal-ai/core` adds a `publisher` filter to `channelHistoryPage` and an optional `AuthProvider.listManagerInstances`, which `@cotal-ai/auth` implements. `@cotal-ai/workspace` adds `ownManagerInstances`, `userSignInAuth`, `signInChange`, an observer `lifecycleUid` option, and a `gone` list on the `ps` reply for registrations whose host is gone.
