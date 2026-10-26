---
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

`cotal up` no longer prints its full help after a TLS address refusal whose remedy names the fix: a `nats://` `--server` in a root whose recorded broker policy serves TLS, a `nats://` `--server` with `--tls-cert`, and a `tls://` `--server` with no certificate. Each now prints the refusal and the address to pass. The `--help` page of each command hidden from `cotal help` as legacy (`clean`, `join`, `topology`, `endpoints`, `describe`, `invoke`, `console` and `actor`, as `meshes` and `personas` already did) now says it is legacy and names what replaces it in the words of its row in the CLI docs. `cotal status` in a stopped folder whose broker kept a store now names `cotal reset store <space>` for a stale store when that reset reaches the folder's store, in place of the legacy `cotal clean store --force`, which it still names where no registration lets a reset reach the folder.
