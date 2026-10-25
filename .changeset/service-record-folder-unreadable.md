---
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

When `service` or `service logs` cannot read a service record folder, they now refuse
`PERMISSION_DENIED`, exit 2, naming the folder and a safely quoted `chmod u+rwx <folder>` step.
Previously they ended with an unconfirmed outcome and a raw permission error, without repair
guidance. `status` keeps its partial result and warns with the same code. No permissions change
automatically; write paths and other error classifications are unchanged.
