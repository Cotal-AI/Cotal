---
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

`cotal login` no longer warns that chat refuses when you have saved a chat name, and a refused chat name now names the remedy the surface you use offers. When no handle is recorded and no name is saved, `cotal login` names both `--name` and `cotal config set name`; with a saved name it says chat sessions use it. `resolveChatName` takes the caller's own remedy, so `cotal chat` still offers `--name` and the terminal app offers Change your name (ctrl+p). A sign-in with no handle on record now also lists that remedy.
