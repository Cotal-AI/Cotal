---
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
"@cotal-ai/cli": minor
"@cotal-ai/delivery": minor
"@cotal-ai/web": minor
"@cotal-ai/cmux": minor
"@cotal-ai/orca": minor
"@cotal-ai/tmux": minor
"@cotal-ai/herdr": minor
"cotal-ai": minor
---

manager: refuse a manager-role spawn of a persona without the spawn capability. A persona defined over the wire (`cotal_persona`) carries no `capabilities:` line (the write path is content-only by design), and `cotal_spawn` takes a free-form `role`, so a wire-defined persona could be spawned with `role: "manager"` and join presenting as a manager whose credential cannot reach the control plane, silently, until the seat first tried to seat a worker (issue #966). The manager now refuses that spawn at accept, before any provisioning, naming the remediation for both authors: an operator adds `capabilities: [spawn]` to the persona file; a peer-defined persona cannot declare capabilities and must ask an operator. The guard keys on the effective role (a spawn-time role override wins over the file's, mirroring existing precedence) and leaves every non-manager spawn untouched. `cotal_spawn`'s `role` argument documents the requirement. Capabilities remain non-declarable over the wire: the closed `define-persona` input schema is unchanged and still guarded by `smoke:persona-input-closed`.
