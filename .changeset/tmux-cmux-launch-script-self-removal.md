---
"@cotal-ai/tmux": patch
"@cotal-ai/cmux": patch
---

The tmux and cmux runtimes no longer leave a seat's launch script on disk. Each spawn wrote the seat's rendered launch env, including any model-provider keys and spawn env values it forwards, to an owner-only script in a temp directory and never removed it, so the values stayed there after the agent started and exited. The script now removes its directory before it starts the agent and does not start the agent when that removal fails, and a spawn whose tmux window or cmux tab fails to open removes it at once. `privateLaunch` and `paneCommand` now return the command together with the script's directory.
