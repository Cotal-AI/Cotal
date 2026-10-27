---
"@cotal-ai/core": patch
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
"@cotal-ai/tmux": patch
"@cotal-ai/cmux": patch
"@cotal-ai/orca": patch
"@cotal-ai/herdr": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/cli": patch
---

A managed Claude Code seat that stops on Claude's first-run text style picker, its login method choice or its Bypass Permissions warning now fails at the startup bound naming that screen and the step that clears it. It used to fail saying the development-channels prompt did not appear, which pointed at the wrong cause. Cotal still never answers any of these screens: the Bypass Permissions warning stays for the user to accept once, or the launch passes `--opt permission-mode=default` (`launchOptions: {permission-mode: default}` in a manifest). A launch recipe declares such screens in the new optional `LaunchSpec.confirmBlockers`. The pty, custody, tmux, cmux, Orca and Herdr runtimes send no key while one is on screen and name its reason when the bound ends there. A runtime that ignores the field fails as before, with the generic message.

`cotal up -f` no longer prints a success mark for its agents. It says the stack is up and the agents' launch is pending, that it does not wait for them to join, and names `cotal ps --space <space>` and the manager's log, where a failed launch is recorded with its reason.

The quickstart and the team guide now say to finish Claude's first run once before the manager launches Claude Code, and give both permission routes.
