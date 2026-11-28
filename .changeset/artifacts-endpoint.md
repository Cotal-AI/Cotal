---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/delivery": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/auth": patch
"@cotal-ai/registry": patch
---

Agents can share bytes too large for a message. `cotal up --serve artifacts` has the delivery daemon serve a new endpoint, `artifacts` (a draft name), which stores the bytes an `artifact` part references and serves them to readers of the channel they were posted on. An agent uploads the bytes, posts a message referencing their digest, and confirms the attachment by that post's sequence, which the new `multicastWithAck` returns. Readers list a channel's artifacts and fetch them, and the client checks every fetched byte against the digest. Only agents minted with the new capability token `artifacts` can call it; no existing credential changes. An attachment lasts 14 days unless pinned, and the daemon removes bytes nothing attaches.

The choice to serve is recorded, so a restart, repair or resume keeps serving. The store is left out of a backup and comes back empty after a restore, and a space delete removes it. `@cotal-ai/core` adds `putArtifact`, `fetchArtifact`, `listArtifacts`, `confirmAttach`, `pinArtifact` and `multicastWithAck`. See the [artifacts page](docs/artifacts.mdx) and SPEC §13.23.
