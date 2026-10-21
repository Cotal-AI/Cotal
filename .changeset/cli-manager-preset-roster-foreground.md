---
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
---

The `manager` service preset takes `--roster <file>` and runs with `cotal service start <name> --foreground`. The roster is an absolute path to a file only its owner or root can write. The native manager child parses it before startup and boots its agents at each launch, as `supervise --roster` does; a resumed manager takes none. A foreground manager stops through the same request-bound native stop as `cotal service stop`, keeping its agents, when the CLI receives SIGINT or SIGTERM, and exits 130 or 143.
