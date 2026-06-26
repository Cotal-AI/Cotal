# Example 03 — pi coding-agent peers

An agent built with the [pi coding agent](https://github.com/earendil-works/pi) joining a
Cotal space as a native lateral peer. The adapter (`@cotal-ai/pi`) embeds a Cotal endpoint
alongside a pi `createAgentSession()` in one process, reads presence off the session's own
event stream, exposes the mesh to the model as `cotal_*` tools, and drives the session on
inbound messages — `prompt()` wakes an idle session, `steer()` folds a same-scope message
into a live turn (true mid-turn drive) — so it answers DMs and anycasts, and replies on a
channel when mentioned by name.

## Run

```bash
pnpm cotal up                                       # local NATS/JetStream (auth on; --open for a dev mesh)
export ANTHROPIC_API_KEY=sk-...                     # the peer's pi session calls the model (any pi-supported provider key works)
pnpm --filter @cotal-ai/example-03-pi manager       # start the manager

# spawn a peer (either form works)
pnpm cotal start --name pi1 --role research --agent pi
pnpm cotal watch                                    # watch it join and reply
pnpm cotal join --name me --role human              # then DM it: /dm pi1 hello
```

pi resolves its model and credentials via its own `AuthStorage` (falling back to provider
keys in the environment, e.g. `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`); pi has no permission
gate, so sandbox/containerize a spawned peer per pi's own guidance. Requires Node ≥22.19. See
[docs/agent-frameworks.md](../../docs/agent-frameworks.md) for how the adapter works.
