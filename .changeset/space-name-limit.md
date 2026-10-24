---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

The docs allowed space names of 1 to 200 characters, but every local file that carries a space spells its name twice over, and a file name holds at most 255 bytes. `space create` of a name longer than 116 characters failed with a raw `ENAMETOOLONG`, exit 3, and `cotal up` of a space named with more than 100 characters failed partway, with a delivery daemon that exited or a broker that was never defined and no cause recorded. A space name now holds at most 64 characters. `space create` and `cotal up --space` refuse a longer one with `USAGE_INVALID`, exit 1, naming the limit and its reason, before anything is written, and `cotal up` refuses a longer name an earlier release prepared the same way, naming `cotal space forget`. The `--max-file-store` docs no longer say a controller stack keeps the cap across `down --preserve-state`, which it refuses; it keeps the cap across `cotal down`.
