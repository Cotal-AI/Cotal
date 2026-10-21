---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": minor
"cotal-ai": minor
---

Fix the backup and restore journey. A full restore now starts: the delivery daemon binds the fanout and reader durables a restore recreates at their recorded start sequence, and still refuses a durable that differs in any other setting. When a delivery daemon that `up` launched exits, the error quotes the failure the daemon logged and no longer blames a lost lease, and a failure on a root that holds a restore or preserved cut never suggests `clean store`. A restore with no preserved cut refuses before it takes the maintenance lock and leaves no state, and `up --restore` refuses the same way instead of reporting an unknown outcome. `up` refuses to take over a space name whose root holds a maintenance journal, or whose root or journal cannot be read, and says when it takes over another root's dead registration. Only a root that is gone or is not a directory gives up its name. Restore failures, `cotal status` and the recover and cleanup refusals show the `restore-<uuid>` attempt id and the next step for its state. A detached `up` from the machine home names `cotal down --preserve-state`, which is the stop that works there. `backup create` refuses before any claim with the reason and next step, and a destination that already exists is a `CONFLICT` refusal. `backup verify` names the file that is missing, undeclared or does not match its declared size and SHA-256.
