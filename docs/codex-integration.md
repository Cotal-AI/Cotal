# Codex connector

> App Server: [developers.openai.com/codex/app-server](https://developers.openai.com/codex/app-server)
> (built + verified against codex-cli 0.137.0).

The connector turns OpenAI Codex into a Cotal mesh peer over the shared runtime in
[`@cotal-ai/connector-core`](../extensions/connector-core). It runs **host-mode** (headless):
a peer that drives a `codex app-server` over JSON-RPC for true wake / steer / interrupt of a
*live* session — no native TUI. The human view comes via the manager's attach / WS.

Identity-gated (`hasIdentity()`): launched with no `COTAL_*` env it stays off the mesh. The
manager resolves it by agent type **`codex-app-server`**.

## How it works

[`host.ts`](../extensions/connector-codex/src/host.ts) embeds a `MeshAgent` in the same process
as an `AppServerDriver` ([`app-server.ts`](../extensions/connector-codex/src/app-server.ts)),
which owns a `codex app-server` child and speaks the app-server **v2** JSON-RPC (JSONL over
stdio — the same protocol the TUI / VS Code extension use; the wire omits the `jsonrpc` field).
A mesh message becomes a real user turn:

- idle → `turn/start` (wake); a turn already running → `turn/steer` (true mid-turn inject, no
  abort — Codex exceeds Claude here); shutdown → `turn/interrupt`.
- Presence is read off the event stream: `turn/started`→working, `turn/completed`→idle, an
  approval request→waiting (auto-accepted to stay autonomous). Each turn's final `agentMessage`
  is routed back to whoever prompted it (channel→`send`, dm/anycast→`dm`).

`approval_policy=never` + `sandbox_mode=workspace-write` make a spawned session autonomous (it
would otherwise hang on the first approval the host can't surface). The operator's `~/.codex`
(auth, model, their own servers) is never written — all config rides `-c` overrides. Codex auth
is the operator's ChatGPT login in `~/.codex/auth.json` (reachable via `HOME`) or `OPENAI_API_KEY`
(the only provider key forwarded into the child — no other operator env leaks, per `launchEnv`).

The host is **directed-only**: it acts on DMs, anycasts, and @-mentions; ambient channel chatter
is dropped, not surfaced — keeping a headless peer focused and its inbox bounded. It drives off
the mesh inbox with **ack-on-completion**: a turn's surfaced messages are `drainInbox()`-acked
only when the turn ends un-interrupted (a `failed` turn acks to avoid a retry-loop; only
`interrupted`/crash redelivers), and a message is steered into the live turn only when it shares
that turn's scope (`channel:<ch>` vs `dm:<id>`), so a DM never rides a channel broadcast.

## Verified

Built + typechecked against codex-cli 0.137.0 — the app-server protocol bindings were confirmed
via `codex app-server generate-ts` (the v2 methods `turn/start` / `turn/steer` / `turn/interrupt`
and notifications `turn/started` / `item/completed` / `turn/completed` match). A live turn (DM →
`PONG` round-trip) is exercised by `smoke:codex` against the real binary (needs an authenticated
`codex`; gated by `COTAL_E2E_CODEX=1`).

## Not yet

- **Agent-initiated `cotal_*` tools.** The host owns all mesh I/O so there is one mesh identity;
  letting the Codex agent proactively `cotal_send`/`cotal_spawn` needs those tool calls routed
  back through the host's single `MeshAgent` (else two presences). Today the peer is reply-driven.
- **Attach surface + remote-TUI** (a human watching the real `codex` TUI while the mesh drives it)
  — rides Codex's newer `--remote` path; tracked upstream (codex#18203, codex#21551).
