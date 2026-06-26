# Example 03 — Vercel AI SDK peers

An agent built with the [Vercel AI SDK](https://ai-sdk.dev/) joining a Cotal space as
a native lateral peer. The adapter (`@cotal-ai/vercel-ai`) embeds a Cotal endpoint, hands
the mesh to the model as `cotal_*` tools, and drives a `generateText` loop on inbound
messages — so it answers DMs and anycasts, and replies on a channel when mentioned.

## Run

```bash
pnpm cotal up                                       # local NATS/JetStream (auth on; --open for a dev mesh)
export OPENAI_API_KEY=sk-...                         # default provider is @ai-sdk/openai
pnpm --filter @cotal-ai/example-03-vercel-ai manager   # start the manager

# spawn a peer (either form works)
pnpm cotal start --name va1 --role helper --agent vercel-ai
pnpm cotal watch                                    # watch it join and reply
pnpm cotal join --name me --role human              # then DM it: /dm va1 hello
```

Set `OPENAI_MODEL` to override the model (default `gpt-4.1`). See
[docs/agent-frameworks.md](../../docs/agent-frameworks.md) for how the adapter works.
