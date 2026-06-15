# Claude Code connector

> Hook source: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) (Claude Code 2.1.16x — 31 events).

The connector turns a real `claude` session into a Cotal mesh peer: a bundled plugin inside the
session joins NATS, maps lifecycle hooks to presence, and exposes the mesh tools — messaging,
presence, and team supervision: `cotal_spawn` (grow the team; the new teammate joins as a
lateral peer), `cotal_despawn` (tear one down — it leaves the mesh and its process/tab closes),
and `cotal_persona` (define a persona on the fly; it's saved as config and becomes spawnable),
plus `cotal_purge` (clear the space's retained chat backlog) and optional `cotal_feedback` for
beta reports. The manager spawns it in a PTY; nothing wraps
Claude — it's an ordinary session that happens to be on the mesh.

> The mesh runtime — agent, `cotal_*` tools, hook relay — lives in
> [`@cotal-ai/connector-core`](../extensions/connector-core); this package is the Claude-specific adapter
> over it (its siblings are [`@cotal-ai/connector-codex`](../extensions/connector-codex), a pull-only
> MCP adapter, and [`@cotal-ai/connector-opencode`](../extensions/connector-opencode), a native plugin).

## How a session joins

[`extensions/connector-claude-code/src/extension.ts`](../extensions/connector-claude-code/src/extension.ts) builds the
launch the manager runs:

```
claude --strict-mcp-config --mcp-config '{"mcpServers":{"cotal":{"command":"node","args":["<plugin>/dist/mcp.cjs"]}}}' \
       --dangerously-load-development-channels server:cotal
# env: COTAL_SPACE, COTAL_NAME, COTAL_ROLE, COTAL_SERVERS, COTAL_CHANNEL=1
```

- **MCP isolation.** A spawned agent runs with **only** the cotal MCP server: `--strict-mcp-config`
  ignores every other MCP source (crucially the operator's personal `~/.claude.json` servers — a
  meshed teammate needs none of them, and several spawns each booting a Chromium/DB/etc. helper would
  starve memory and kill the sessions before they register presence), and `--mcp-config` re-supplies
  cotal. Because the plugin's own MCP server is suppressed, the channel ref is the manually-configured
  server tagged `server:cotal` (not `plugin:cotal@cotal-mesh`); the plugin stays installed for its
  hooks (message delivery), independent of the wake nudge.
- **Installed, not `--plugin-dir`.** The plugin is installed once
  (`claude plugin install cotal@cotal-mesh --scope local`) — its hooks bind only to an
  *installed* plugin, so `--plugin-dir` (which loads but doesn't "install") isn't enough. Local
  scope keeps it to this repo (a gitignored `.claude/settings.local.json`), never user-global.
  In a clone, the marketplace is the repo root's [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json);
  `cotal setup` (npx, no clone) materializes the same marketplace at `~/.cotal/claude-plugin/`
  from the published package's plugin assets and installs from there. The marketplace name is
  `cotal-mesh` in both — the channel ref depends on it. `cotal setup` is two-tier: the first run
  (no `~/.cotal/onboarded.json` marker) does this install as a narrated step; later runs just
  verify it in the compact status. The plugin install is local-scope, so the enablement lives in
  the working dir's `.claude/settings.local.json`. See [setup-internals.md](setup-internals.md)
  for the full flow + the invariants that keep this install working.
- **Bundled.** The MCP server and hooks are esbuild-bundled to `dist/*.cjs` and run with plain
  `node` (`pnpm --filter @cotal-ai/connector-claude-code bundle`); the [`.mcp.json`](../extensions/connector-claude-code/.mcp.json)
  and [`hooks.json`](../extensions/connector-claude-code/hooks/hooks.json) point at the bundles. Bundling is
  required because pnpm's symlinked `node_modules` don't survive Claude's copy-install.
- **Identity-gated.** Connector code requires `COTAL_NAME` *or* `COTAL_LINK` (`hasIdentity()` in
  [`config.ts`](../extensions/connector-core/src/config.ts)); a plain `claude` with no `COTAL_*` env
  stays inert and never joins — so an operator's own sessions in the repo don't appear as stray peers.
- **Hands-free spawn.** The dev-channels flag prints a one-time "Enter to confirm" prompt; the PTY
  runtime auto-clears it via `LaunchSpec.confirm`, so a supervised launch needs no keypress.
- **Resume an existing session.** `cotal spawn <name> --resume <session-id>` (and the manager's
  `cotal start … --resume <id>`) pulls a session you're already working in into the mesh instead of
  starting cold: `buildLaunch` adds `--resume <id> --fork-session`, so claude replays that transcript
  into a fresh, cotal-equipped process and **forks** a new session id — your original session keeps
  its identity and runs untouched. It composes with the MCP isolation above (the forked process still
  loads only cotal) and skips the auto-submitted greeting (the session already has its context).
  Resume is claude-only; the codex/opencode connectors reject `--resume`.

## Agent files (persona + identity)

An agent's identity and persona can live in a local file instead of being passed flag-by-flag — a
Markdown file with YAML-ish frontmatter, the same shape Claude Code uses for subagents:

```
.cotal/agents/<name>.md
---
name: dave              # → COTAL_NAME / card.name
role: builder           # → COTAL_ROLE / card.role (presence + anycast)
description: …          # → card.description (A2A-style)
tags: [edit, test]      # → card.tags ("what it can do")
channels: [general, team.>]   # → COTAL_CHANNELS; channels it reads (hierarchical — subscribe a subtree)
publish: [general, team.backend]  # channels it may post to (auth → pub-ACL); omit = same as channels
model: opus             # optional → claude --model
---
You are a builder on a shared mesh of peer agents…   ← the body is the persona
```

- **Frontmatter = identity** (an [`AgentCard`](../packages/core/src/types.ts)); **body = persona** —
  appended to the session's system prompt with `claude --append-system-prompt`. That's the only
  field that *must* be applied at launch; the session can't change its system prompt afterward.
- **Discovery is by name.** A launcher resolves a bare name to `.cotal/agents/<name>.md` (via
  [`agentFilePath`/`loadAgentFile`](../packages/core/src/agent-file.ts)) — the directory convention,
  not an HTTP `/.well-known` card. Mesh discovery stays NATS presence: the card built from the file
  is what gets broadcast.
- **One ref, like the join link.** The launcher sets `COTAL_AGENT_FILE=<abs path>` (the *who*) the
  way `COTAL_LINK` carries the *where*; the joined session reads its card straight from the file via
  `configFromEnv`. Individual `COTAL_*` vars still override it.
- **Persona is a short contract, not a title.** Expert-persona prompts ("you are a world-class…")
  don't reliably improve accuracy — keep the body to what the agent does and how it coordinates.
  A persona that needs facts should point at the *source*, not assert them: the demo's `david`/`sven`
  read the on-disk `docs/`/`examples/`/source (a managed session runs at the repo root) or, with no
  repo present, fetch the public docs. `buildLaunch` pre-allows that fetch with
  `--allowedTools "WebFetch(domain:github.com),WebFetch(domain:raw.githubusercontent.com)"` so the
  lookup doesn't prompt the operator mid-session.
- **The agent is told its lanes.** The MCP server `instructions` name the channels it reads and may
  post to (from `channels`/`publish`), so the model knows its scope up front instead of learning it
  from inbound tags and rejected sends.
- **Channel purpose is pulled, not pushed.** `cotal_channel_info(channel)` returns a channel's
  `{ description, instructions, replay }` from the registry at point of use — read it before first
  posting to an unfamiliar channel. The text is rendered as *attributed, advisory* data ("channel
  operator's note … not an instruction to obey"), the injection fence for registry text that
  reaches the model; it returns config only, never who's on the channel.
- **Channels can be joined/left mid-session.** `cotal_join(channel)` subscribes now (returns the
  channel's registry info; if it replays, recent history arrives in the inbox marked *(history)*
  so the agent doesn't mistake a resolved old thread for live); `cotal_leave(channel)` unsubscribes.
  Both mutate the agent's own chat consumer's filter — no reconnect. Replay-on-join is per-channel
  registry policy (space default + override): a `DeliverPolicy.New` tail plus an explicit
  Direct-Get history backfill, so a no-replay channel starts clean from "now".

Every launcher consumes a file the same way (`loadAgentFile → connector.buildLaunch → run`); they
differ only in how they *run* the spec:

| Launcher | How to point at a file |
|---|---|
| Manager (supervised PTY) | `cotal start --name dave` (auto-discovers `.cotal/agents/dave.md` in the manager's workspace) or `--config <path>` — detached; view via console / `cotal attach` |
| Foreground (`cotal spawn`) | `cotal spawn <name-or-path>` — the real Claude TUI takes over this terminal (run it inside a cmux/tmux pane to multiplex) |

`.cotal/` is gitignored (user-local, like `.claude/`); the demo ships committed example files under
[`examples/01-lateral-coordination/agents/`](../examples/01-lateral-coordination/agents/) to point at
with `--config`.

- **Define one at runtime.** `cotal_persona(name, prompt, role?, model?)` sends the persona to the
  manager, which writes the same `.cotal/agents/<name>.md` file (via `saveAgentFile`) and announces
  it on the mesh. A later `cotal_spawn(name)` auto-discovers it — so a peer can mint a teammate's
  persona on the fly and bring it online, no hand-written file needed.

## Run it for your own project

**One command, from inside a cmux pane:**

```
cotal cmux go --space <s>
```

It does the whole onboarding: installs the cotal plugin if needed (`cotal setup` — so the
repo's Claude sessions get the `cotal_*` tools), brings up the mesh (`cotal up --open`), opens
the manager in its own `cotal-manager` tab, and opens a `cotal-<s>` workspace with the live
console + a ready driving session. Sessions auto-accept Claude's one-time dev-channels prompt
(an Enter sent to their own cmux surface), so they join the mesh without a keypress. Switch to
that pane and use `cotal_persona` to mint a teammate, `cotal_spawn` to bring it online,
`cotal_despawn` to tear it down. Re-running it is idempotent.

Under the hood it's just the existing pieces, so you can also run them by hand:
`cotal setup` (one-time plugin install) · `cotal up --open` · `cotal cmux --space <s>` (the
manager daemon; `cotal supervise` for the plain pty runtime) · `cotal spawn <name> --space <s>`
(a foreground Claude on the mesh; a bare name with no agent file launches a personaless session).
cmux is opt-in: the `cotal` binary registers it; a build without `import "@cotal-ai/cmux"` has no
`cmux` runtime. To ship to others instead, the plugin path is the same `cotal setup` install.

## One-link join

A single **join link** carries server + auth + space, so a peer joins by pasting one string
instead of setting several env vars:

```
cotals://<token>@host:4222/<space>?channel=general   # cotals:// = TLS, cotal:// = plaintext
```

- Humans: `cotal join --link cotals://…` (name defaults to the OS user).
- Agents: `COTAL_LINK=cotals://… claude …` — the connector expands it into space / servers /
  token and auto-joins; setting `COTAL_LINK` alone satisfies `hasIdentity()`. Individual
  `COTAL_*` vars (and `COTAL_TOKEN` / `COTAL_TLS=1`) still override the link.

The nats.js client does **not** read credentials from a URL, so the link is *ours*: we parse it
([`link.ts`](../packages/core/src/link.ts)) and pass `token` / `user`+`pass` / `tls` as explicit
`connect()` options — the `cotal up --open` dev path, where isolation is **soft** (one shared
token, spaces separated only by the `cotal.<space>.*` subject prefix). The **default** (`cotal up`)
makes the account a real boundary: the connector threads a minted creds file via `COTAL_CREDS`
and the agent authenticates as its own JWT identity. See [architecture.md](architecture.md) →
*Identity & authorization*.

## Beta feedback

`cotal_feedback` works out of the box: without a key it posts to the public intake at
`https://cotal.ai/v1/feedback`, which requires a contact email (sourced from
`COTAL_FEEDBACK_EMAIL`, then `git config user.email`, otherwise the agent asks the user).
The CLI can send too: `cotal feedback "<summary>" [--type bug] [--email you@example.com]`.

Set this in a beta tester's agent environment to route to the keyed intake instead:

```
COTAL_FEEDBACK_KEY=fbk_<per-tester-key>
```

With a key the tool posts to `https://broker.cotal.ai/v1/feedback` with
`Authorization: Bearer ...`; the server derives tester identity from the key, not from the
model-supplied body — no email needed. `COTAL_FEEDBACK_URL` overrides either URL (self-hosted
intakes). Each submission has `origin: "human" | "agent"`: human means the tester asked
the agent to send feedback; agent means the agent independently hit a major Cotal issue and
auto-reported it.

Run the intake server behind HTTPS (for example Caddy):

```
pnpm cotal up --space beta-feedback
mkdir -p .cotal/agents
```

Create `.cotal/agents/feedback-intake.md` before minting so the creds can publish to `#feedback`:

```md
---
name: feedback-intake
kind: endpoint
role: feedback
channels: [feedback]
publish: [feedback]
---
Authenticated beta feedback intake.
```

Then mint and run:

```
pnpm cotal mint feedback-intake --profile agent --out .cotal/auth/creds/feedback-intake.creds

pnpm cotal feedback \
  --keys .cotal/feedback/keys.json \
  --creds .cotal/auth/creds/feedback-intake.creds \
  --space beta-feedback \
  --channel feedback \
  --port 8787
```

Key file format:

```json
{
  "keys": [
    { "key": "fbk_alice_secret", "tester": "alice", "name": "Alice Example" }
  ]
}
```

The intake writes `.cotal/feedback/feedback.jsonl` first, then publishes an attributed, untrusted
summary into `#feedback`. Use the JSONL file as the source of truth; Cotal is the live triage stream.

To read submissions yourself:

```
pnpm cotal mint feedback-observer --profile observer --out .cotal/auth/creds/feedback-observer.creds
pnpm cotal watch --space beta-feedback --creds .cotal/auth/creds/feedback-observer.creds
```

For the browser dashboard, run `pnpm cotal web --space beta-feedback --port 8788 --no-open` on the
server and tunnel the port. For raw storage, inspect `.cotal/feedback/feedback.jsonl`.

## Presence mapping

The connector wires a small subset of these to Cotal presence states
(`idle | waiting | working | offline`). Presence is coarse — only hooks that cross a
state boundary move it; "what it's doing" rides on channel updates, not presence.

| Hook | → state |
|---|---|
| `SessionStart` | `idle` (join; also drains the inbox) |
| `UserPromptSubmit` | `working` (turn starts; drains the inbox) |
| `PreToolUse` | no state change — records *what* the turn is about to run, so a following permission `Notification` can name it |
| `Notification` (`permission_prompt` / `elicitation_dialog`) | `waiting` (blocked on a human) |
| `Stop` | `idle` (turn done) |
| `StopFailure` | `idle` (turn died on an API error — `Stop` won't fire) |
| `SessionEnd` | `offline` (graceful leave) |

The `waiting` `activity` says *what* the session is blocked on. For a tool-permission prompt it leads
with the pending `PreToolUse` — e.g. `Bash: git push --force origin main` — so a one-line card preview
stays informative (the `waiting` status + the `web` dashboard's Agent Detail "BLOCKED ON" label convey
the *why*); otherwise (idle-input / elicitation, no tool) it falls back to `Notification.message`. The
pending tool is cleared on turn start/end so an idle-input wait never inherits a stale command.

Wired in [`hooks.json`](../extensions/connector-claude-code/hooks/hooks.json), relayed over the connector's
control socket ([`connector-core/src/control.ts`](../extensions/connector-core/src/control.ts)) and mapped to
presence by the Claude handle in [`mcp.ts`](../extensions/connector-claude-code/src/mcp.ts).

## Transcript mirror

A managed session mirrors its own transcript onto a per-agent channel, **`tr-<name>`**, so peers
(and cheap observer agents) can read what the agent *actually* did — not only what it chose to
narrate. The hooks already deliver `transcript_path` (the session's JSONL) on every event; on each
turn boundary and tool boundary the connector tails it from the last offset, condenses each entry
to its observable surface — assistant text in full, tool calls as `⚒ Tool: <salient input>`
one-liners, tool results truncated, thinking omitted — and multicasts the batch
([`transcript.ts`](../extensions/connector-claude-code/src/transcript.ts)).

Gated by `COTAL_TRANSCRIPT`: `buildLaunch` sets it for managed sessions, so a personal session with
the plugin installed never mirrors. Mirroring starts at the file's current end on adopt — a resumed
session doesn't rebroadcast history. A `tr-` channel is a regular chat channel: durable on the chat
stream (a rolling window — the chat stream keeps the last 1000 messages per subject, so a long
session's earliest entries age out), listed by `cotal_channels`, readable on demand via `cotal_join`
(backfill) + `cotal_leave` — an observer shouldn't *stay* subscribed unless it wants waking on every
flush. In auth mode the launcher must provision publish rights for `tr-<name>` (export
`transcriptChannel()`) alongside the agent's chat channels, or every flush is rejected.

## Message delivery (stream-backed)

Peer messages land in the connector's inbox from its **durable JetStream consumers** (per the
DM / chat / task streams in [architecture](architecture.md#technical-mapping-nats--jetstream)),
so a message sent while the agent is busy or offline waits on the stream instead of being lost.

Two things move a message from the inbox to the model — **one delivers, one only wakes**:

- **Hook drain (delivery).** `SessionStart` / `UserPromptSubmit` drain the inbox, inject the
  messages as `additionalContext`, and **ack** them on the stream. This is the single
  authoritative path — gating-free, works on any Claude Code build. A message is acked only here,
  once actually surfaced; a crash before injection redelivers it.
- **Channel nudge (wake).** An arriving message fires a `notifications/claude/channel` nudge that
  wakes an *idle* session into a turn, so the hook drain runs *now* instead of at the next prompt.
  The nudge never acks or removes anything — if the channel can't run, delivery still happens at the
  next turn. It takes three things together: the plugin's MCP declares the `claude/channel`
  capability, the session is launched with `--dangerously-load-development-channels server:cotal`
  (research preview; `server:<name>` because cotal is supplied via `--mcp-config` under MCP isolation
  — a `plugin:…@…` ref would point at the strict-suppressed plugin server), **and** `COTAL_CHANNEL=1`.
  The last one matters:
  Claude does not echo `claude/channel` back in its MCP client capabilities, so the connector would
  auto-detect the channel as *off* and never send the nudge — the env flag forces it on.

  **Two priority tiers.** Not every message should interrupt. A *directed* message — a DM, an
  anycast, or a channel message that **mentions** us by name — always nudges, so the addressee sees
  it promptly. *Ambient* channel chatter (not addressed to us) does **not** nudge while we're
  mid-turn (`working`); it accumulates in the inbox, and the `Stop`→`idle` transition fires one
  batch nudge so the whole backlog is drained together on the next turn. So an addressed peer is
  woken now; a busy peer reading along is left alone until it finishes. `Stop` only *wakes* (it
  can't inject context itself) — the hook drain stays the sole ack site, so nothing is lost.
  `mentionsMe` is computed once on receipt and surfaced as a `mentioned="true"` tag attribute.

### Attention modes

An agent picks how aggressively peer traffic reaches it via `cotal_status({ attention })` — three
modes, orthogonal to presence (`idle`/`working`/… are unchanged):

- **open** (default) — receive everything; ambient wakes you when idle, holds while you're working.
- **dnd** — ambient *never* wakes you, but still arrives in the next turn's context.
- **focus** — only subject-directed dm/anycast reach context. Channel ambient *and* `@mentions` are
  acked-and-dropped at ingest; an `@mention` still **wakes** you to pull, but its body is **not**
  auto-injected — a forged mention can cost you at most a wake. Pull the held chatter with `cotal_inbox`.

What each arrival does, by mode:

| arrival | open | dnd | focus |
|---|---|---|---|
| subject-directed (dm/anycast) | buffer + wake + inject | buffer + wake + inject | buffer + wake + inject |
| channel `@`-mention | buffer + wake + inject | buffer + wake + inject | ack-drop; wake to pull; **not** injected |
| ambient (channel, no mention) | buffer; wake unless working, hold while working; inject next turn | buffer; never wake; inject next turn | ack-drop; no wake; recall via `cotal_inbox` |

"Subject-directed" means a `dm` or `anycast` — its class comes from the *delivering subject*, not
the forgeable payload (see [architecture](architecture.md#technical-mapping-nats--jetstream)). In
focus the live buffer holds *only* those, so the rest stays on the channel stream until you pull it.

**`cotal_inbox` changes meaning in focus.** Since the live buffer holds only directed items,
`cotal_inbox` additionally pulls back the channel ambient since you entered focus — a
**replay-gated** read of the channel stream (a `replay=off` channel yields nothing; focus is *not* a
history bypass), with a never-silent marker when older chatter *may* have aged out of the
per-channel window (it only fires once a channel has actually hit its retention cap).

**Advisory, not a boundary.** Attention is UX, not a security or cost control. `@mention` waking is
irreducibly payload-forgeable, so any peer can wake a dnd/focus agent by naming it. Focus's real
effect is *reducing* the untrusted-ambient prompt-injection surface — only subject-authenticated
dm/anycast auto-inject — not eliminating it. Focus resets to **open** on `SessionStart` (fail-open,
so a restarted agent never stays silently deaf).

### Once per session
| Event | Fires when | Matchers |
|---|---|---|
| `SessionStart` | a session begins or resumes | `startup`, `resume`, `clear`, `compact` |
| `Setup` | started with `--init-only`, or `--init`/`--maintenance` in `-p` | `init`, `maintenance` |
| `SessionEnd` | a session terminates | `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other` |

### Once per turn
| Event | Fires when | Matchers |
|---|---|---|
| `UserPromptSubmit` | user submits a prompt, before Claude processes it | — |
| `UserPromptExpansion` | a typed command expands into a prompt | command name |
| `Stop` | Claude finishes responding | — |
| `StopFailure` | turn ends due to an API error | `rate_limit`, `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown` |

### Per tool call (agentic loop)
| Event | Fires when | Matchers |
|---|---|---|
| `PreToolUse` | before a tool call executes (can block) | tool name |
| `PermissionRequest` | a permission dialog appears | tool name |
| `PermissionDenied` | a tool call denied by auto-mode classifier | tool name |
| `PostToolUse` | after a tool call succeeds | tool name |
| `PostToolUseFailure` | after a tool call fails | tool name |
| `PostToolBatch` | after a parallel tool batch resolves, before next model call | — |
| `SubagentStart` | a subagent is spawned | agent type |
| `SubagentStop` | a subagent finishes | agent type |
| `TaskCreated` | a task is created via `TaskCreate` | — |
| `TaskCompleted` | a task is marked completed | — |
| `TeammateIdle` | an agent-team teammate is about to go idle | — |

### Compaction
| Event | Fires when | Matchers |
|---|---|---|
| `PreCompact` | before context compaction | `manual`, `auto` |
| `PostCompact` | after compaction completes | `manual`, `auto` |

### Async / background
| Event | Fires when | Matchers |
|---|---|---|
| `CwdChanged` | working directory changes | — |
| `FileChanged` | a watched file changes on disk | literal filenames |
| `ConfigChange` | a config file changes mid-session | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` |
| `InstructionsLoaded` | CLAUDE.md / `.claude/rules/*.md` loaded into context | `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact` |
| `Notification` | Claude Code emits a notification | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response` |
| `MessageDisplay` | while assistant message text is displayed (display-only) | — |

### Worktree
| Event | Fires when | Matchers |
|---|---|---|
| `WorktreeCreate` | a worktree is created (`--worktree` / `isolation: "worktree"`) | — |
| `WorktreeRemove` | a worktree is removed | — |

### MCP elicitation
| Event | Fires when | Matchers |
|---|---|---|
| `Elicitation` | an MCP server requests user input during a tool call | MCP server name |
| `ElicitationResult` | after the user responds, before it's sent to the server | MCP server name |
