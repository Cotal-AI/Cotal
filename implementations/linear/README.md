# @cotal-ai/linear

Serves the official Linear MCP server as a registered Cotal endpoint that agents call with
`cotal_describe` and `cotal_invoke`, and adds the `cotal linear` operator command. Install it into
the published CLI with `cotal ext add @cotal-ai/linear`.

**Tier:** `implementations/`. Peer-depends [`@cotal-ai/core`](../../packages/core) and
[`@cotal-ai/workspace`](../../packages/workspace); self-registers on import.

See [docs/cli.md](../../docs/cli.md#linear) and the [root AGENTS.md](../../AGENTS.md) for the tier
rules.
