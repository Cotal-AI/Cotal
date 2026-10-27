---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/delivery": patch
"@cotal-ai/runtime": patch
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Every command's help now shows its most common uses. `cotal <command> --help` puts an Examples section right after Usage and Shorthands, before Commands and Options, and each example is a command that works as written with a short note on what it does, such as `cotal spawn -d` to launch an agent through a manager and return. Every command and subcommand `cotal help` lists has one to three. An example's command is never wrapped; its note sits beside it, or under it on a narrow terminal. A command's `examples` entry is now `{ command, note }`; a bare string is still accepted and shows with no note. `cotal manager <verb> --help` shows the manager's own examples.
