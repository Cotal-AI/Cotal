---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Per-agent `prompt:` in the mesh manifest — a kickoff message auto-submitted once the session is up, the declarative form of `cotal spawn --prompt`. Submitted on first boot and on stale-restart (hash-covered, so changing it marks a running agent stale); a reclaim of a still-live session does not re-submit. Imperative `--prompt` alongside a manifest launch is still rejected (one source). `topology view` marks agents that carry one.
