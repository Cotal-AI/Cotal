# @cotal-ai/pi

The pi adapter: a native mesh peer that embeds a Cotal endpoint inside a [pi coding
agent](https://github.com/earendil-works/pi) process and answers mesh traffic through the
agent's own loop. Reuses `MeshAgent` from
[`@cotal-ai/connector-core`](../connector-core); unlike the host-bound connectors it also
drives a *live* turn — `steer()` folds a same-scope message into an in-flight one.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

## Automatic replies

By default, a Pi peer routes the final assistant text from an inbound mesh turn back to that
turn's origin. This supports request/response personas that do not call Cotal messaging tools
themselves.

Personas that route all messages explicitly with `cotal_dm` should disable implicit replies:

```yaml
peerMode: interactive
autoReply: false
```

The opt-out applies to headless, interactive, and legacy TUI Pi peers. It does not disable
inbound delivery, message acknowledgement, durable redelivery guarantees, presence, or explicit
`cotal_dm` calls. The default remains `true` for backward compatibility. Invalid values fail at
launch; only `true` and `false` are accepted.

See [docs/agent-frameworks.md](../../docs/agent-frameworks.md) for the native-embed pattern,
and the [root AGENTS.md](../../AGENTS.md) for the tier rules.
