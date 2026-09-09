# @cotal-ai/connector-opencode

The OpenCode adapter: a native in-process plugin injected at launch via
`OPENCODE_CONFIG_CONTENT`, rendering the shared `cotal_*` tools as plugin tools. A thin client
over [`@cotal-ai/connector-core`](../connector-core).

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/architecture.md](../../docs/architecture.md) (*Integration surfaces*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

## Native lifecycle provider

Importing the package also registers `native-lifecycle:opencode`. The trusted management
executor resolves it with `resolveNativeLifecycleProvider("opencode")` and supplies an
existing server endpoint, credentials, and the host/owner namespace. The executor and
CLI consumption are still pending integration.

The current adapter supports read-only discovery, exact-resource inspection, and a native
viewer command description. Construction opens no connection. HTTP responses and deadlines
are bounded. Redirects and plaintext remote connections are refused.

Discovery returns stored session identity and creation metadata. It does not establish native
process lifetime, server incarnation, mesh membership, or management authority. OpenCode
1.18.15 exposes no server-incarnation or operation-receipt API. The adapter remains
observed-only and refuses adoption, release, transfer, and recovery pending trusted
host-identity and management-executor integration. Unknown operation outcomes stay
indeterminate. Management continuity is not certified.

Viewer descriptions select `opencode attach <endpoint> --session <id>`, never `--fork` or
implicit last-session selection. They contain no password. The invoking operator supplies
credentials through OpenCode's normal environment. Returning a description starts no viewer
and grants no management rights.

`pnpm test` includes loopback HTTP tests for identity mismatches, credentials, response limits,
and unsupported operations. `pnpm test:native-provider` checks an installed OpenCode 1.18.15
binary using an isolated home and server. Set `COTAL_TEST_OPENCODE_BINARY` to override its path.
The fixture creates two sessions without model prompts or plugins, checks that inspection
keeps their identities distinct, then stops the server and removes its home. This verifies
native API interoperability, not active-tool continuity or manager-service replacement.
