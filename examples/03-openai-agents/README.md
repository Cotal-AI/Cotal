# Example 03 — OpenAI Agents SDK (TypeScript) peers

An agent built with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
joining a Cotal space as a native lateral peer. The adapter
(`@cotal-ai/openai-agents`) embeds a Cotal endpoint, exposes the mesh to the model as
`cotal_*` tools, and drives the agent's run loop on inbound messages — so it answers
DMs and anycasts, and replies on a channel when mentioned by name.

## Run

```bash
pnpm cotal up                                           # local NATS/JetStream (auth on; --open for a dev mesh)
export OPENAI_API_KEY=sk-...                             # the peer calls the OpenAI API
pnpm --filter @cotal-ai/example-03-openai-agents manager   # start the manager

# spawn a peer (either form works)
pnpm cotal start --name oa1 --role helper --agent openai-agents
pnpm cotal watch                                        # watch it join and reply
pnpm cotal join --name me --role human                  # then DM it: /dm oa1 hello
```

Set `OPENAI_MODEL` to override the model (default `gpt-4o-mini`). See
[docs/agent-frameworks.md](../../docs/agent-frameworks.md) for how the adapter works.
