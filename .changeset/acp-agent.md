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

On a space where people sign in, a person now controls every agent under their own owner without the `admin` scope. Their manager view carries owner-mode `input`, `interrupt`, `despawn` and `attach`, and their sign-in reads those agents' event channels live and through its own history reader. These rights come from the ledger row being a person's, never from a scope token, so no agent holds them. `cotal acp` reads through that sign-in, lists your own managers as machines, and names each agent `acp_<id>`, a valid actor name there. `@cotal-ai/core` adds a `publisher` filter to `channelHistoryPage`, and `@cotal-ai/workspace` adds `userSignInAuth` and an observer `lifecycleUid` option.
