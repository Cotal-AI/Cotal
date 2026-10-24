---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

`ps` no longer names the retired `deregister-instance` spelling for a manager whose host is gone. On an auth space it names `cotal endpoint deregister manager <id> --yes` from the space's own root, and on any other space it says to start that manager again and stop it cleanly if its host is still available, and that no supported command removes the record if the host is gone. The row is still listed and the read is still partial. `deregister-instance` still refuses and names `endpoint deregister`, without printing its old usage after the refusal, and a manager that cannot deregister at shutdown names the same two ways out.
