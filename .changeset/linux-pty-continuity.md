---
"cotal-ai": minor
"@cotal-ai/manager": minor
"@cotal-ai/seat": minor
---

Linux PTY seats now survive manager replacement under detached custodians.
The built-in runtime records durable seat references and lets a successor adopt the same process, terminal and exit observation. Startup confirmation outcomes and required notices cross the custody proxy. A normal manager stop releases these seats instead of ending them. macOS and Windows retain in-process PTYs and refuse rolling adoption.
