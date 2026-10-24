---
"@cotal-ai/cli": patch
---

`cotal status` in a moved or copied controller folder listed "if the stored JetStream state is stale: cotal clean store --force" as a next step, although `clean store` refuses there and, in a moved folder, that store holds the space's only messages. Status now treats that folder's store as the stack's, as it does in the folder the stack started in, and reports `storedState` as `false`.
