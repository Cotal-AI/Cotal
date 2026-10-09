---
"@cotal-ai/manager": patch
---

A participant manager whose host enrolls its agents now removes each agent's actor token, sentinel credentials and health file when the agent retires. The hosted teardown revoked the host grant and retired the lifecycle but left that credential family on the participant's disk and in its secret store after every despawn and every orphaned spawn. A removal that fails is reported and keeps the name held, and the host still revokes the grant.
