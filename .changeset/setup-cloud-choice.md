---
"@cotal-ai/cli": patch
---

`cotal setup` lets you choose Cloud on a terminal. Before, the choice was listed but could not be selected, and its hint sent you to `cotal login` and the Self-hosted choice. Now Cloud sets up a space of your Cotal Cloud account: with no Cloud space registered on the machine it signs you in first, with several spaces it asks which one, and for a space no project uses yet it asks for the project folder. The flag value `--destination cloud` is still refused in a script, with the route through `cotal login` and `--destination self-hosted`.
