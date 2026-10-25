---
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

A service record folder of the space that this account cannot read, such as its `instances` folder,
is now named by `service` and its verbs, such as `service logs`. They refuse it `PERMISSION_DENIED`,
exit 2, with the folder and `chmod u+rwx <folder>`, which gives it back. Before, they ended with
an unconfirmed outcome and the raw permission error, and named no folder or step. `status` warns
with the same code.
