---
"@cotal-ai/cli": patch
---

The manager question names your managers again on a user-auth space whose auth service predates the channel registry grant. Its roster read now reads presence alone, so a user connection that may not read the channel registry with one batched read still gets each manager's name or `<host>/<runtime>`, host and start, newest first. It used to list bare instance ids in the refusal's order and drop the reason. A roster read that is still refused keeps the instance ids, and a `names unavailable:` line above the question gives the refusal and its remedy. `--on <name>` and the other reads of your live managers use the same presence read.
