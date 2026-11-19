---
"@cotal-ai/acp": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/pi": minor
---

T3 Code, Zed and other Agent Client Protocol clients can now spawn and drive Cotal agents through the new `@cotal-ai/acp` extension and its `cotal acp` command.

`cotal acp` serves ACP v1 on standard input and output. A client thread is one managed agent: its first prompt spawns the agent through the space's manager in the thread's folder, with the model, reasoning variant, persona, channel and machine the thread chose, and the agent keeps running when the client closes. The thread follows the agent's event channel, so an application without an event plane is not offered. Session list shows the managed agents in a folder, loading one replays what its event channel still holds, deleting one hides that run, and `/despawn`, `/roster` and `/channels` answer in the thread. A later prompt reaches the agent as a direct message, and its turn ends once the agent has started working and stopped again. A client that runs terminals is offered a sign-in that runs `cotal login` or, with no space recorded, `cotal setup`. Stopping a turn interrupts the agent through the manager's new `interrupt` command, and the turn ends as cancelled. Forwarding an agent's questions is not available yet. `@cotal-ai/cli` names the package when `cotal acp` runs before the extension is added, and `@cotal-ai/workspace` records `acp` as a Cotal home entry and offers the `interrupt` control call.

The manager serves a new targeted `interrupt` command, contract revision 52. It writes the key a seat's connector declares in the new `Connector.interruptKey` into the seat's terminal, and it is granted to operator credentials only, like `input`. The Claude Code and Pi connectors declare Escape.
