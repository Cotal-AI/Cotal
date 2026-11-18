---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/tmux": minor
"@cotal-ai/herdr": minor
"@cotal-ai/cmux": minor
"@cotal-ai/orca": minor
---

An agent name that starts with `-` is now refused where a name can reach a runtime's argument list: a managed spawn and `cotal spawn --name`, a persona definition (`cotal persona create`, `cotal personas new`, a `persona edit` that renames, and `cotal_persona` over the wire), a manifest's `agents:` keys (`cotal team check` refuses it and `cotal team deploy` creates nothing), and the manager's restore of a retained agent. The tmux, herdr, cmux and orca runtimes refuse such a name too. Open and static meshes accepted these names before. `cotal join --name`, `cotal mint -a` and the conversation name a connector sends are unchanged. An existing persona file with such a name can still be listed, shown and removed. On the command line, put `--` before the name: `cotal persona remove --yes -- -name`.
