---
"@cotal-ai/core": patch
"@cotal-ai/orca": patch
"@cotal-ai/herdr": patch
---

`@cotal-ai/core` now exports `privateLauncherSource`, the one source of the private Node launcher the Orca and Herdr runtimes write for each agent. Each runtime used to keep its own copy, so a change to how the launcher runs its child, forwards signals or reports its exit could reach one runtime and leave the other behind. Each runtime keeps its own temp-dir prefix and the command or argv its backend runs the launcher with. The launcher scripts are unchanged.
