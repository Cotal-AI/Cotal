---
"cotal-ai": minor
"@cotal-ai/manager": minor
"@cotal-ai/seat": minor
---

Linux PTY seats now survive manager replacement under detached custodians.
The built-in runtime records durable seat references and lets a successor adopt the same process, terminal and exit observation on static, user-auth and open meshes. Startup confirmation outcomes and required notices cross the custody proxy. A normal manager stop releases these seats instead of ending them. Natural exits release the manager's custody connection so childless custodians can leave. macOS and Windows retain in-process PTYs and refuse rolling adoption.
