---
"@cotal-ai/cli": patch
---

`up --server` now refuses an address that is not one `nats://` or `tls://` URL with a host before anything is written, so a typo no longer pins the folder to it. On a controller root, an address the broker service cannot use, such as a DNS name or a wildcard, refuses before the stack journal is written.

`space delete` refuses while the space's own stack still runs on this machine, before any broker connection, and names `cotal down` and then `cotal reset store` or `cotal clean store --force`. Its dry run shows that refusal as a warning, and its receipt no longer prints an empty "Already absent" table.

`reset store` and `reset space` now work after a normal `down` of a controller stack. They take the broker address, store and mode from the prepared record and stack journal, which both stay, so a later `up` starts the stack again. Every reset refusal names one reason and the command that clears it. `reset store --dry-run` exits 0 and opens with a verdict saying the apply is offered or why it would refuse. A passing `reset space --dry-run` names its apply as Next.
