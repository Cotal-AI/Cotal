---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/cli": minor
"@cotal-ai/lang": minor
"@cotal-ai/linear": minor
---

An agent can now give a helper it spawns endpoint commands it holds itself, by listing them in the helper's persona under `endpoints`.

Each entry names an endpoint and its commands, such as `{ endpoint: com.example.orders, commands: [list] }`. The field works in a persona file, in the inline persona on `cotal_spawn`, in `cotal_persona`, and in a cotal-lang inline `spawn`. On a static mesh the manager measures every command against the spawner's own issued credential and refuses, by name, any command the spawner cannot call. A workflow run's spawn is measured against what the run's starter held when the run was admitted. The helper's credential carries the commands from its first mint, and every renewal keeps them. `cotal spawn --foreground` mints them for the operator's own seat. The orientation card lists the commands a seat was handed.

A per-user auth mesh refuses a persona that names `endpoints`, an empty list included, and the refusal points to `cotal service-endpoint grant`, which is how endpoint access is granted there. A manifest launch also refuses such a persona and points to `cotal spawn --detach`. Single-label endpoints such as `manager`, the `describe` and `cancel` commands, and entries that pin an `instanceId` are refused.

A persona file whose `endpoints` key is not a valid list now fails to load, where the key used to be ignored. The manager cluster contract moves to revision 47, which adds `endpoints` to the `spawn` persona record and to `define-persona`. `@cotal-ai/core` exports `parsePersonaEndpoints`, `lowerPersonaEndpoints`, `copyPersonaEndpoints` and the `PersonaEndpoint` type, and `LaunchOpts` gains `endpoints`, which connectors forward to the session as `COTAL_ENDPOINTS`.
