# @cotal-ai/pi

The pi adapter: a native mesh peer that embeds a Cotal endpoint inside a [pi coding
agent](https://github.com/earendil-works/pi) process and answers mesh traffic through the
agent's own loop. Reuses `MeshAgent` from
[`@cotal-ai/connector-core`](../connector-core); unlike the host-bound connectors it also
drives a *live* turn — `steer()` folds a same-scope message into an in-flight one.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/agent-frameworks.md](../../docs/agent-frameworks.md) for the native-embed pattern,
and the [root AGENTS.md](../../AGENTS.md) for the tier rules.
