---
"@cotal-ai/cli": patch
---

`cotal up -f <manifest> --idp <url>` now applies the flag to the effective manifest, so the `--dry-run` plan names the IdP the launch pins. Before, the plan named the manifest's `broker.idp` while the launch used the flag. The flag and `broker.idp` now get the URL rules the launch applies to the IdP: a value that is not https (or http on a loopback IP literal), or that carries credentials, a query or a fragment, is refused before the plan prints. Before, such a value passed the dry run and the launch refused it.
