---
"@cotal-ai/cli": patch
---

A foreground `cotal spawn` now resolves its `--share-tools` selection before it provisions the agent. A selection naming a server the config does not declare used to refuse after provisioning and outside the launch rollback, so the refusal left what provisioning had created behind, such as a remote user-mode spawn's actor-token and sentinel-creds files. The refusal text is unchanged. The spawn also reads the cotal config once, so the model policy and the launch use the same file contents.
