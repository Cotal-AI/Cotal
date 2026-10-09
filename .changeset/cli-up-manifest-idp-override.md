---
"@cotal-ai/cli": patch
---

`cotal up -f <manifest> --idp <url>` now applies the flag to the effective manifest, so the `--dry-run` plan names the IdP the launch pins. Before, the plan named the manifest's `broker.idp` while the launch used the flag. The flag now gets the same checks as `broker.idp`: a value that is not a URL, or that embeds credentials, is refused before the plan prints.
