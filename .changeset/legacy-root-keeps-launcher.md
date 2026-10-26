---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up` with an option only the legacy launcher takes, such as `--exchange-public-port`, starts a stopped root that launcher already started again on that launcher. This applies to a root with no stack journal whose `up` registered the space with no prepared record, or a user-auth root that holds its user-auth state. Before, such a root was refused `UNSUPPORTED` as if it were a fresh prepared root ("this root is prepared for a controller-owned stack"), so a hosted user-auth deployment that had run on 0.100 could not start. A fresh prepared root still refuses those options.
