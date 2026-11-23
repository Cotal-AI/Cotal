---
"@cotal-ai/acp": minor
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
---

`cotal setup` now adds Cotal to T3 Code and Zed when it finds them, so a thread in either app can start and drive Cotal agents without editing their settings by hand. Setup installs `@cotal-ai/acp` and adds one entry per space that runs this computer's `cotal acp --space <space>` by absolute path. It updates an entry you added by hand in place instead of adding a second one, keeps your other settings and Zed's comments, and backs up each file before it changes it. `cotal update` points the entries at the Cotal it installed, and `cotal status` shows an entry whose command is gone. The ACP bridge gains `/name`, which names a thread's agent before it starts or renames a running one on a space where people sign in, and `/open`, which drives an agent that is already running from a new thread. A thread reopens on the agent it spawned or opened. `npx @cotal-ai/acp` starts the Cotal installed on this computer, and when there is none or it lacks the ACP extension, it offers a terminal sign-in that installs what is missing. Core adds the `client-setup` extension kind (`ClientSetupProvider`) and passes the space to a setup action.
