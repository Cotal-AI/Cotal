---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
---

Wire user-mode chat sessions end to end below the command surface. The auth service admits a session per holder hash under the person's own `cli` grant, serves `/chat-session/open`, `/chat-session/bearer` and `/chat-session/retire`, re-checks the session, holder index and pinned grant before and after signing each bearer of at most 900 s, mints the plain agent leaf for a chat principal at connect, and sweeps, retires and compacts sessions. The auth provider implements the three optional chat methods and keeps each session on the route its open resolved; an open may name the IdP and exchange position the caller resolved, and the provider refuses any other. The CLI gains an internal user-mode session factory over a real endpoint.
