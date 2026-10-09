---
"@cotal-ai/core": patch
---

The spawn-name actor-token smoke reads the CLI's `refuseUnmintableNameOrExit` call sites from the parsed `spawn.ts`: it requires two call expressions and checks that each keys the door on a `.mode === "user"` comparison. The cells used to count text matches after regex comment stripping, so a call moved into a string stayed green, the declaration counted as a call, a quote change failed the mode cell, and a `//` inside a string hid the rest of its line.
