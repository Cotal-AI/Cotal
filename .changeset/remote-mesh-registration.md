---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

`cotal meshes add` can register a REMOTE mesh. `classifyJoinTarget` gains the `public-tls` reach: with recorded TLS strictness (`tlsRequired: true`) a hostname or public IP literal is registrable, because the TLS chain + hostname check — not the resolver — picks the peer; without it every verdict is unchanged, and RFC1918 stays refused in both modes. TLS intent is now sourced (a `--tls` flag or a `tls://` scheme) and ENFORCED: the record carries it, the candidate probe honours it, and `meshes add tls://…` against a plaintext broker is a refusal rather than a silent plaintext dial. `--mode user` is permitted when its pinned trust is supplied — `--user-auth-file <bundle.json>` or `--from <https://…/.well-known/cotal-mesh>` (fetched over HTTPS, pins displayed and confirmed) — verified against the pinned exchange's `/health` + `/jwks` and the broker's own auth-required refusal. Remote user entries record `userAuth.remote` and a 0600 `sentinelCredsPath` (the path, never the blob), and promote `endpoints.url` to pinned trust; `assertUserAuthInfo` fails loud on both.
