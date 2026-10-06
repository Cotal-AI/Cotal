---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/delivery": minor
"@cotal-ai/manager": minor
---

A filesystem SecretStore identity is now `{kind: "fs", root, id}`, where `id` is a random value the store records once in `store.id` inside its own directory. No key of a filesystem store and no `cotal deliver --creds` file may be that file under any name the filesystem resolves to it, compared by device and inode so a case-insensitive spelling or a link counts, and a `store.id` that holds anything but a lowercase UUID is refused, so a credential is never published as the id. Two filesystem identities match only when both the root and the id match, so a manager on another host whose workspace root has the same path as the delivery daemon's no longer counts as the daemon's store, takes no daemon-credential renewal lease, and no longer blocks `cotal doctor auth --fix` on the broker host. A daemon answer with no `id` is refused, so the manager and the delivery daemon must run this release together. `FsSecretStore` takes the root its identity names as its second constructor argument instead of a full identity.
