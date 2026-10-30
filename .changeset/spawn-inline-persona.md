---
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
"@cotal-ai/manager": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
"@cotal-ai/connector-core": minor
---

An agent can define its helper on the spawn itself. `cotal_spawn` takes a `persona` record (the persona prompt, role, model, variant, description, channels and capabilities) next to `name`, and the helper runs from a private snapshot of it. `persona.save: true` also writes a catalog copy under that name, owned by the spawner. A cotal-lang program does the same with `spawn({ name, prompt, ... }, opts)`, and the run journal records the definition and its digest, so a resume never submits another one. `cotal_persona` takes `capabilities` and says how a saved persona is removed.

A helper never gets more than its spawner holds. On a static mesh every spawn is measured against the spawner's issued evidence: each channel, the role and each capability token it does not hold is refused by name, and a spawner whose evidence does not resolve hands on nothing. Operator commands and admin agents are exempt. A workflow run's spawns are bounded by what its starter held when the run was admitted. The static agent mint now grants task-queue rows for each `role:<r>` capability, so a spawner hands on a role it was given either way. On a participant manager the issuing host makes the agent that asked for a helper its ledger parent, taking the caller from the spawn request it observed, and a run's helper is parented to the run's starter and also bounded by the grant its admission recorded. The loopback `verify-enrollment` door a host platform asks decides the same parent and bound and answers `parent`, and a retry of the same enrollment gets the same answer.

A seat started by foreground `cotal spawn`, or a bare `cotal join`, on a static mesh is now issued against its own lifecycle. Its credential has no expiry unless `--expires-in` or `--expires-at` is passed, is never renewed, and is retired when the seat leaves cleanly.

Breaking: a static spawner that hands its helpers channels, capabilities or a role it does not hold is refused, an older issuing host refuses the new enrollment field, and an older reader refuses an admission carrying `spawnExempt` or `delegation`. See UPGRADING.
