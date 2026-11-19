# @cotal-ai/acp

Serves Cotal as an [Agent Client Protocol](https://agentclientprotocol.com) agent, so T3 Code, Zed
and other ACP clients can spawn and drive Cotal agents. Adds the `cotal acp` command. Install it
into the published CLI with `cotal ext add @cotal-ai/acp`.

**Tier:** `implementations/`. Peer-depends [`@cotal-ai/core`](../../packages/core) and
[`@cotal-ai/workspace`](../../packages/workspace); self-registers on import.

`src/agent.ts` is the protocol layer and depends only on the `Mesh` interface in `src/mesh.ts`.
`src/live-mesh.ts` binds that interface to a real space through the workspace's observer and manager
control calls. The smokes drive the protocol layer with the ACP SDK's own client
against a fake space.

See [Use an ACP client](https://docs.cotal.ai/docs/acp-clients/) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
