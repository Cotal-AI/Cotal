---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
---

A spawned agent now inherits the operator's environment. A harness you installed and configured
should behave under `cotal spawn` the way it behaves when you run it yourself, and the alternative
was Cotal maintaining a list of inference vendors: every new provider needed a change in Cotal
before it would work through a managed spawn. `MODEL_PROVIDER_KEYS` and the per-connector lists
that extended it are gone, and Cotal no longer names an inference vendor anywhere in its source.

Cotal still resets its own `COTAL_*` namespace before the child starts, keeping the machine-wide
knobs (`COTAL_HOME`, the feedback set, the default-agent pair, the `*_BIN` overrides, the timing
knobs). That reset is not configurable, because it is identity and not preference: a connector
supplies the per-session names for each child and does so conditionally, so an inherited value is
never overwritten and would hand an agent another agent's credential path, ACL, or lifecycle uid.
The whole prefix is stripped rather than a named list, because which names a connector sets varies
between connectors and a deny-list only ever names what its author remembered.

To confine a spawned agent instead, declare `spawn.env` in the cotal config file. The child then
gets a fixed OS allow-list plus exactly the names you list. An empty array is a real policy meaning
the OS allow-list alone. Note what this does and does not buy: `HOME` is forwarded either way, so
an agent with a shell reads `~/.aws` and `~/.ssh` regardless, and this protects only secrets that
live nowhere but the environment.
