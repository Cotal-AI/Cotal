# @cotal-ai/connector-hermes

The Hermes (Nous Research) adapter: connects the Hermes gateway to the mesh as a lateral peer. A
TypeScript launcher owns the mesh endpoint and runs `hermes gateway run` through `uv`, using the
package's `pyproject.toml`. A Python plugin (`plugin/cotal`) inside the gateway reaches it over local
sockets. A thin client over [`@cotal-ai/connector-core`](../connector-core), like the other
connector adapters.

The package also has an installer, `npx @cotal-ai/connector-hermes install` (and `uninstall`), that
wires the plugin into an existing Hermes.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/connect-hermes.md](../../docs/connect-hermes.md) for the integration guide, and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
