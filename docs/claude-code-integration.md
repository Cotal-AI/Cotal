# Claude Code connector

> The connector turns a real `claude` session into a Cotal mesh peer. Hook source:
> [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) (Claude Code
> 2.1.16x, 31 events).

A bundled plugin inside the session joins NATS, maps lifecycle hooks to presence, and
exposes the mesh tools: messaging, presence, and team supervision.

- **`cotal_spawn`** grows the team. The new teammate joins as a lateral peer. A taken
  name auto-numbers (`reviewer` → `reviewer-2`), so you never collide; the requested name
  still picks the persona file.
- **`cotal_despawn`** tears one down. It leaves the mesh and its process or tab closes.
- **`cotal_persona`** defines a persona on the fly. It is saved as config and becomes
  spawnable.
- **`cotal_feedback`** (optional) sends beta reports.

Clearing retained history is operator-only (`cotal history clear`), not an agent tool. The
manager spawns the session in a PTY. Nothing wraps Claude; it is an ordinary session that
happens to be on the mesh.

> The mesh runtime (agent, `cotal_*` tools, hook relay) lives in
> [`@cotal-ai/connector-core`](../extensions/connector-core). This package is the
> Claude-specific adapter over it. Its sibling is
> [`@cotal-ai/connector-opencode`](../extensions/connector-opencode), a native plugin.

## Run it for your own project

**One command, from inside a cmux pane:**

```
cotal cmux go --space <s>
```

It does the whole onboarding:

- installs the cotal plugin if needed (`cotal setup`, so the repo's Claude sessions get the
  `cotal_*` tools),
- brings up the mesh (`cotal up --open`),
- opens the manager in its own `cotal-manager` tab, and
- opens a `cotal-<s>` workspace with the live console plus a ready driving session.

Sessions auto-accept Claude's one-time dev-channels prompt (an Enter sent to their own cmux
surface), so they join the mesh without a keypress. Switch to that pane and use
`cotal_persona` to mint a teammate, `cotal_spawn` to bring it online, and `cotal_despawn` to
tear it down. Re-running it is idempotent.

Under the hood it is the existing pieces, so you can also run them by hand:

- `cotal setup` (one-time plugin install)
- `cotal up --open`
- `cotal cmux --space <s>` (the manager daemon; `cotal supervise` for the plain pty runtime)
- `cotal spawn <name> --space <s>` (a foreground Claude on the mesh; a bare name with no
  agent file launches a personaless session)

cmux is opt-in: the `cotal` binary registers it, and a build without `import "@cotal-ai/cmux"`
has no `cmux` runtime. To ship to others instead, the plugin path is the same `cotal setup`
install.

## Agent files (persona and identity)

An agent's identity and persona can live in a local file instead of being passed
flag-by-flag. It is a Markdown file with YAML-ish frontmatter, the same shape Claude Code
uses for subagents:

```
.cotal/agents/<name>.md
---
name: dave              # → COTAL_NAME / card.name
role: builder           # → COTAL_ROLE / card.role (presence + anycast)
description: …          # → card.description (A2A-style)
tags: [edit, test]      # → card.tags ("what it can do")
subscribe: [general, team.backend]  # → COTAL_SUBSCRIBE; channels it reads at boot (hierarchical)
allowSubscribe: [general, team.>]   # read ACL: channels it MAY read (omit = same as subscribe)
allowPublish: [general, team.backend]  # post ACL → pub-ACL; omit = none (default-deny)
model: opus             # optional → claude --model
---
You are a builder on a shared mesh of peer agents…   ← the body is the persona
```

- **Frontmatter is identity** (an [`AgentCard`](../packages/core/src/types.ts)); **the body
  is the persona**, appended to the session's system prompt with `claude
  --append-system-prompt`. The persona is the only field that *must* be applied at launch,
  because the session cannot change its system prompt afterward.
- **Discovery is by name.** A launcher resolves a bare name to `.cotal/agents/<name>.md` (via
  [`agentFilePath`/`loadAgentFile`](../packages/core/src/agent-file.ts)). This is the
  directory convention, not an HTTP `/.well-known` card. Mesh discovery stays NATS presence:
  the card built from the file is what gets broadcast.
- **One ref, like the join link.** The launcher sets `COTAL_AGENT_FILE=<abs path>` (the
  *who*) the way `COTAL_LINK` carries the *where*. The joined session reads its card straight
  from the file via `configFromEnv`. Individual `COTAL_*` vars still override it.
- **Persona is a short contract, not a title.** Expert-persona prompts ("you are a
  world-class…") do not reliably improve accuracy, so keep the body to what the agent does
  and how it coordinates. A persona that needs facts should point at the *source*, not assert
  them: the demo's `david`/`sven` read the on-disk `docs/`/`examples/`/source (a managed
  session runs at the repo root), or with no repo present they fetch the public docs.
  `buildLaunch` pre-allows that fetch with `--allowedTools
  "WebFetch(domain:github.com),WebFetch(domain:raw.githubusercontent.com)"` so the lookup
  does not prompt the operator mid-session.
- **The agent is told its lanes.** The MCP server `instructions` name the channels it reads
  and may post to (from `channels`/`publish`), so the model knows its scope up front instead
  of learning it from inbound tags and rejected sends.
- **Channel purpose is pulled, not pushed.** `cotal_channel_info(channel)` returns a
  channel's `{ description, instructions, replay }` from the registry at point of use. Read it
  before first posting to an unfamiliar channel. The text is rendered as *attributed,
  advisory* data ("channel operator's note … not an instruction to obey"), the injection
  fence for registry text that reaches the model. It returns config only, never who is on the
  channel.
- **Channels can be joined and left mid-session.** `cotal_join(channel)` subscribes now
  (and returns the channel's registry info; if the channel replays, recent history arrives in
  the inbox marked *(history)* so the agent does not mistake a resolved old thread for live).
  `cotal_leave(channel)` unsubscribes. Both mutate the agent's own chat consumer's filter,
  with no reconnect. Replay-on-join is per-channel registry policy (space default plus
  override): a `DeliverPolicy.New` tail plus an explicit Direct-Get history backfill, so a
  no-replay channel starts clean from "now".

Every launcher consumes a file the same way (`loadAgentFile → connector.buildLaunch →
run`). They differ only in how they *run* the spec:

| Launcher | How to point at a file |
|---|---|
| Manager (supervised PTY) | `cotal start --name dave` (auto-discovers `.cotal/agents/dave.md` in the manager's workspace) or `--config <path>`. Detached; view via console / `cotal attach`. |
| Foreground (`cotal spawn`) | `cotal spawn <name-or-path>`. The real Claude TUI takes over this terminal (run it inside a cmux/tmux pane to multiplex). |

`.cotal/` is gitignored (user-local, like `.claude/`). The demo ships committed example
files under
[`examples/01-lateral-coordination/agents/`](../examples/01-lateral-coordination/agents/) to
point at with `--config`.

**Define one at runtime.** `cotal_persona(name, prompt, model?)` sends the persona to the
manager, which writes the same `.cotal/agents/<name>.md` file (via `saveAgentFile`) and
announces it on the mesh. A later `cotal_spawn(name)` auto-discovers it, so a peer can mint a
teammate's persona on the fly and bring it online with no hand-written file. (Role is set at
spawn, since `cotal_spawn` takes a role; it is not set here, because role is policy, not
persona content.)

## One-link join

A single **join link** carries server, auth, and space, so a peer joins by pasting one
string instead of setting several env vars:

```
cotals://<token>@host:4222/<space>?channel=general   # cotals:// = TLS, cotal:// = plaintext
```

- Humans: `cotal join --link cotals://…` (name defaults to the OS user).
- Agents: `COTAL_LINK=cotals://… claude …`. The connector expands it into space, servers,
  and token and auto-joins; setting `COTAL_LINK` alone satisfies `hasIdentity()`. Individual
  `COTAL_*` vars (and `COTAL_TOKEN` / `COTAL_TLS=1`) still override the link.

The nats.js client does **not** read credentials from a URL, so the link is ours: we parse
it ([`link.ts`](../packages/core/src/link.ts)) and pass `token` / `user`+`pass` / `tls` as
explicit `connect()` options. This is the `cotal up --open` dev path, where isolation is
**soft** (one shared token, spaces separated only by the `cotal.<space>.*` subject prefix).
The **default** (`cotal up`) makes the account a real boundary: the connector threads a
minted creds file via `COTAL_CREDS` and the agent authenticates as its own JWT identity. See
[architecture.md](architecture.md) → *Identity & authorization*.

## How a session joins

[`extensions/connector-claude-code/src/extension.ts`](../extensions/connector-claude-code/src/extension.ts)
builds the launch the manager runs:

```
claude --strict-mcp-config --mcp-config '{"mcpServers":{"cotal":{"command":"node","args":["<plugin>/dist/mcp.cjs"]}}}' \
       --dangerously-load-development-channels server:cotal
# env: COTAL_SPACE, COTAL_NAME, COTAL_ROLE, COTAL_SERVERS, COTAL_CHANNEL=1
```

- **MCP isolation.** By default a spawned agent runs with **only** the cotal MCP server.
  `--strict-mcp-config` ignores every other MCP source, crucially the operator's personal
  `~/.claude.json` servers. A meshed teammate needs none of them, and several spawns each
  booting a Chromium/DB/etc. helper would starve memory and kill the sessions before they
  register presence. `--mcp-config` re-supplies cotal (plus any servers the operator opted to
  share — see [Sharing personal MCP servers](#sharing-personal-mcp-servers)). Because the
  plugin's own MCP server is suppressed, the channel ref is the manually-configured server
  tagged `server:cotal` (not `plugin:cotal@cotal-mesh`); the plugin stays installed for its
  hooks (message delivery), independent of the wake nudge.
- **Installed, not `--plugin-dir`.** The plugin is installed once (`claude plugin install
  cotal@cotal-mesh --scope local`). Its hooks bind only to an *installed* plugin, so
  `--plugin-dir` (which loads but does not "install") is not enough. Local scope keeps it to
  this repo (a gitignored `.claude/settings.local.json`), never user-global. In a clone, the
  marketplace is the repo root's
  [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json). `cotal setup`
  (npx, no clone) materializes the same marketplace at `~/.cotal/claude-plugin/` from the
  published package's plugin assets and installs from there. The marketplace name is
  `cotal-mesh` in both, and the channel ref depends on it. `cotal setup` is two-tier: the
  first run (no `~/.cotal/onboarded.json` marker) does this install as a narrated step; later
  runs just verify it in the compact status. The plugin install is local-scope, so the
  enablement lives in the working dir's `.claude/settings.local.json`. See
  [setup-internals.md](setup-internals.md) for the full flow and the invariants that keep
  this install working.
- **Bundled.** The MCP server and hooks are esbuild-bundled to `dist/*.cjs` and run with
  plain `node` (`pnpm --filter @cotal-ai/connector-claude-code bundle`). The
  [`.mcp.json`](../extensions/connector-claude-code/.mcp.json) and
  [`hooks.json`](../extensions/connector-claude-code/hooks/hooks.json) point at the bundles.
  Bundling is required because pnpm's symlinked `node_modules` do not survive Claude's
  copy-install.
- **Identity-gated.** Connector code requires `COTAL_NAME` *or* `COTAL_LINK` (`hasIdentity()`
  in [`config.ts`](../extensions/connector-core/src/config.ts)). A plain `claude` with no
  `COTAL_*` env stays inert and never joins, so an operator's own sessions in the repo do not
  appear as stray peers.
- **Hands-free spawn.** The dev-channels flag prints a one-time "Enter to confirm" prompt.
  The PTY runtime auto-clears it via `LaunchSpec.confirm`, so a supervised launch needs no
  keypress.

## Sharing personal MCP servers

Isolation is the default, but sometimes a meshed teammate genuinely needs one of your own tools
(say web search). The **cotal config file** is the opt-in. It's per-connector — MCP passthrough
isn't a portable agent concept (OpenCode inherits the operator's servers via its merge layer;
Hermes has no MCP), so it lives in connector settings, not the
[agent file](#agent-files-persona-and-identity).

```jsonc
// ~/.config/cotal/config.json   (operator-level, every space)
// or  <root>/.cotal/config.json (space-local, layered on top — same shape)
{
  "connectors": {
    "claude": {
      "mcpServers": {
        "tavily": {
          "command": "npx",
          "args": ["-y", "tavily-mcp"],
          "env": { "TAVILY_API_KEY": "${TAVILY_API_KEY}" }
        }
      }
    }
  }
}
```

- **Where it lives.** Two layers, merged by server name (more specific wins):
  `~/.config/cotal/config.json` (or `$XDG_CONFIG_HOME/cotal/config.json`) as the operator-level
  base, and a space-local `.cotal/config.json` on top. Personal servers are an operator concern,
  so the global file is the usual home; the space file is for project-specific overrides.
- **How servers are written.** Each entry is the de-facto `.mcp.json` shape, so you can copy one
  straight out of your own Claude / VS Code / Cursor config. Spelled out in full (command/args/env)
  — not referenced by name — because the heaviest servers (e.g. a plugin/npx-sourced Chromium) are
  invisible to a by-name lookup of `~/.claude.json`.
- **Secrets stay references.** Write keys as `${VAR}` / `${VAR:-default}`, never literals — the
  config file is safe to keep in `~/.config` or a gitignored `.cotal/`. At launch the connector
  forwards *only* the named vars the chosen servers declare (from the operator's env, by name —
  never the whole environment, preserving the P3 env allow-list) and passes the merged config as a
  `0600` file (in a private `0700` temp dir); Claude expands the references from that env at launch,
  so the secret never lands on disk or the command line. `--strict-mcp-config` stays on, so only
  cotal + the explicitly-shared servers ever load.
- **Sharing a server grants its credential to the agent.** The forwarded var lives in the *Claude
  process's* environment (that's how Claude expands the `${VAR}` and the server reads it), so an
  agent with shell/tool access can read it directly — not only through the server's tools. Keeping
  it off disk/argv is about the host's exposure, not the agent's: share a server only when you're
  fine with that teammate holding the key.
- **Per-spawn override.** `cotal spawn <name> --share-tools tavily,figma` shares only those
  (they must be declared); `--share-tools none` shares nothing. Absent, all declared servers are
  shared. Manager-spawned agents (`cotal start`) use the config as-is. Default — no config file —
  is unchanged: a spawned agent gets only cotal.
- **Mind the memory.** Sharing re-opens the cost isolation guards: a heavy server booted once per
  spawn multiplies across a team. Share lean servers; keep the Chromium-class ones out.

## Message delivery (stream-backed)

Peer messages land in the connector's inbox from its **durable JetStream consumers** (per
the DM / chat / task streams in
[architecture](architecture.md#technical-mapping-nats--jetstream)), so a message sent while
the agent is busy or offline waits on the stream instead of being lost.

Two things move a message from the inbox to the model. **One delivers, one only wakes:**

- **Hook drain (delivery).** `SessionStart` / `UserPromptSubmit` drain the inbox, inject the
  messages as `additionalContext`, and **ack** them on the stream. This is the single
  authoritative path: gating-free, and it works on any Claude Code build. A message is acked
  only here, once actually surfaced, so a crash before injection redelivers it.
- **Channel nudge (wake).** An arriving message fires a `notifications/claude/channel` nudge
  that wakes an *idle* session into a turn, so the hook drain runs *now* instead of at the
  next prompt. The nudge never acks or removes anything, so if the channel cannot run,
  delivery still happens at the next turn. It takes three things together: the plugin's MCP
  declares the `claude/channel` capability, the session is launched with
  `--dangerously-load-development-channels server:cotal` (research preview; `server:<name>`
  because cotal is supplied via `--mcp-config` under MCP isolation, and a `plugin:…@…` ref
  would point at the strict-suppressed plugin server), **and** `COTAL_CHANNEL=1`. The last
  one matters because Claude does not echo `claude/channel` back in its MCP client
  capabilities, so the connector would auto-detect the channel as *off* and never send the
  nudge. The env flag forces it on.

**Two priority tiers.** Not every message should interrupt. A *directed* message (a DM, an
anycast, or a channel message that **mentions** us by name) always nudges, so the addressee
sees it promptly. *Ambient* channel chatter (not addressed to us) does **not** nudge while we
are mid-turn (`working`). It accumulates in the inbox, and the `Stop`→`idle` transition fires
one batch nudge so the whole backlog is drained together on the next turn. An addressed peer
is woken now; a busy peer reading along is left alone until it finishes. `Stop` only *wakes*
(it cannot inject context itself), so the hook drain stays the sole ack site and nothing is
lost. `mentionsMe` is computed once on receipt and surfaced as a `mentioned="true"` tag
attribute.

### Attention modes

An agent picks how aggressively peer traffic reaches it via `cotal_status({ attention })`.
Three modes, orthogonal to presence (`idle`/`working`/… are unchanged):

- **open** (default): receive everything. Ambient wakes you when idle, holds while you are
  working.
- **dnd**: ambient *never* wakes you, but still arrives in the next turn's context.
- **focus**: only subject-directed dm/anycast reach context. Channel ambient *and* `@mentions`
  are acked-and-dropped at ingest. An `@mention` still **wakes** you to pull, but its body is
  **not** auto-injected, so a forged mention can cost you at most a wake. Pull the held
  chatter with `cotal_inbox`.

What each arrival does, by mode:

| arrival | open | dnd | focus |
|---|---|---|---|
| subject-directed (dm/anycast) | buffer + wake + inject | buffer + wake + inject | buffer + wake + inject |
| channel `@`-mention | buffer + wake + inject | buffer + wake + inject | ack-drop; wake to pull; **not** injected |
| ambient (channel, no mention) | buffer; wake unless working, hold while working; inject next turn | buffer; never wake; inject next turn | ack-drop; no wake; recall via `cotal_inbox` |

"Subject-directed" means a `dm` or `anycast`. Its class comes from the *delivering subject*,
not the forgeable payload (see
[architecture](architecture.md#technical-mapping-nats--jetstream)). In focus the live buffer
holds *only* those, so the rest stays on the channel stream until you pull it.

**`cotal_inbox` changes meaning in focus.** Since the live buffer holds only directed items,
`cotal_inbox` additionally pulls back the channel ambient since you entered focus. This is a
**replay-gated** read of the channel stream (a `replay=off` channel yields nothing; focus is
*not* a history bypass), with a never-silent marker when older chatter *may* have aged out of
the per-channel window (it only fires once a channel has actually hit its retention cap).

**Advisory, not a boundary.** Attention is UX, not a security or cost control. `@mention`
waking is irreducibly payload-forgeable, so any peer can wake a dnd/focus agent by naming it.
Focus's real effect is *reducing* the untrusted-ambient prompt-injection surface, since only
subject-authenticated dm/anycast auto-inject. It does not eliminate it. Focus resets to
**open** on `SessionStart` (fail-open, so a restarted agent never stays silently deaf).

## Presence mapping

The connector wires a small subset of Claude Code hooks to Cotal presence states (`idle` /
`waiting` / `working` / `offline`). Presence is coarse: only hooks that cross a state
boundary move it. "What it is doing" rides on channel updates, not presence.

| Hook | → state |
|---|---|
| `SessionStart` | `idle` (join; also drains the inbox) |
| `UserPromptSubmit` | `working` (turn starts; drains the inbox) |
| `PreToolUse` | no state change; records *what* the turn is about to run, so a following permission `Notification` can name it |
| `Notification` (`permission_prompt` / `elicitation_dialog`) | `waiting` (blocked on a human) |
| `Stop` | `idle` (turn done) |
| `StopFailure` | `idle` (turn died on an API error, so `Stop` will not fire) |
| `SessionEnd` | `offline` (graceful leave) |

The `waiting` `activity` says *what* the session is blocked on. For a tool-permission prompt
it leads with the pending `PreToolUse`, for example `Bash: git push --force origin main`, so a
one-line card preview stays informative (the `waiting` status plus the `web` dashboard's Agent
Detail "BLOCKED ON" label convey the *why*). Otherwise (idle-input or elicitation, no tool) it
falls back to `Notification.message`. The pending tool is cleared on turn start and end, so an
idle-input wait never inherits a stale command.

Wired in [`hooks.json`](../extensions/connector-claude-code/hooks/hooks.json), relayed over
the connector's control socket
([`connector-core/src/control.ts`](../extensions/connector-core/src/control.ts)), and mapped
to presence by the Claude handle in
[`mcp.ts`](../extensions/connector-claude-code/src/mcp.ts).

## Transcript mirror

A managed session mirrors its own transcript onto a per-agent channel, **`tr-<name>`**, so
peers (and cheap observer agents) can read what the agent *actually* did, not only what it
chose to narrate. The hooks already deliver `transcript_path` (the session's JSONL) on every
event. On each turn boundary and tool boundary the connector tails it from the last offset and
condenses each entry to its observable surface: assistant text in full, tool calls as `⚒
Tool: <salient input>` one-liners, tool results truncated, thinking omitted. It multicasts the
batch ([`transcript.ts`](../extensions/connector-claude-code/src/transcript.ts)).

Gated by `COTAL_TRANSCRIPT`: `buildLaunch` sets it for managed sessions, so a personal session
with the plugin installed never mirrors. Mirroring starts at the file's current end on adopt,
so a resumed session does not rebroadcast history. A `tr-` channel is a regular chat channel:
durable on the chat stream (a rolling window, since the chat stream keeps the last 1000
messages per subject, so a long session's earliest entries age out), listed by
`cotal_channels`, and readable on demand via `cotal_join` (backfill) plus `cotal_leave`. An
observer should not *stay* subscribed unless it wants waking on every flush. In auth mode the
launcher must provision publish rights for `tr-<name>` (export `transcriptChannel()`)
alongside the agent's chat channels, or every flush is rejected.

## Beta feedback

`cotal_feedback` works out of the box. Without a key it posts to the public intake at
`https://cotal.ai/v1/feedback`, which requires a contact email (sourced from
`COTAL_FEEDBACK_EMAIL`, then `git config user.email`, otherwise the agent asks the user). The
CLI can send too: `cotal feedback "<summary>" [--type bug] [--email you@example.com]`.

Set this in a beta tester's agent environment to route to the keyed intake instead:

```
COTAL_FEEDBACK_KEY=fbk_<per-tester-key>
```

With a key the tool posts to `https://broker.cotal.ai/v1/feedback` with `Authorization:
Bearer ...`. The server derives tester identity from the key, not from the model-supplied
body, so no email is needed. `COTAL_FEEDBACK_URL` overrides either URL (self-hosted intakes).
Each submission has `origin: "human" | "agent"`: human means the tester asked the agent to
send feedback; agent means the agent independently hit a major Cotal issue and auto-reported
it.

Run the intake server behind HTTPS (for example Caddy):

```
pnpm cotal up --space beta-feedback
mkdir -p .cotal/agents
```

Create `.cotal/agents/feedback-intake.md` before minting so the creds can publish to
`#feedback`:

```md
---
name: feedback-intake
kind: endpoint
role: feedback
subscribe: [feedback]
allowPublish: [feedback]
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

The intake writes `.cotal/feedback/feedback.jsonl` first, then publishes an attributed,
untrusted summary into `#feedback`. Use the JSONL file as the source of truth; Cotal is the
live triage stream.

To read submissions yourself:

```
pnpm cotal mint feedback-observer --profile observer --out .cotal/auth/creds/feedback-observer.creds
pnpm cotal watch --space beta-feedback --creds .cotal/auth/creds/feedback-observer.creds
```

For the browser dashboard, run `pnpm cotal web --space beta-feedback --port 8788 --no-open` on
the server and tunnel the port. For raw storage, inspect `.cotal/feedback/feedback.jsonl`.

## Hook reference

The full set of Claude Code hook events, grouped by lifecycle. The connector consumes the
subset mapped in *Presence mapping* and *Message delivery*; the rest are listed for
completeness.

### Once per session
| Event | Fires when | Matchers |
|---|---|---|
| `SessionStart` | a session begins or resumes | `startup`, `resume`, `clear`, `compact` |
| `Setup` | started with `--init-only`, or `--init`/`--maintenance` in `-p` | `init`, `maintenance` |
| `SessionEnd` | a session terminates | `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other` |

### Once per turn
| Event | Fires when | Matchers |
|---|---|---|
| `UserPromptSubmit` | user submits a prompt, before Claude processes it | (none) |
| `UserPromptExpansion` | a typed command expands into a prompt | command name |
| `Stop` | Claude finishes responding | (none) |
| `StopFailure` | turn ends due to an API error | `rate_limit`, `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown` |

### Per tool call (agentic loop)
| Event | Fires when | Matchers |
|---|---|---|
| `PreToolUse` | before a tool call executes (can block) | tool name |
| `PermissionRequest` | a permission dialog appears | tool name |
| `PermissionDenied` | a tool call denied by auto-mode classifier | tool name |
| `PostToolUse` | after a tool call succeeds | tool name |
| `PostToolUseFailure` | after a tool call fails | tool name |
| `PostToolBatch` | after a parallel tool batch resolves, before next model call | (none) |
| `SubagentStart` | a subagent is spawned | agent type |
| `SubagentStop` | a subagent finishes | agent type |
| `TaskCreated` | a task is created via `TaskCreate` | (none) |
| `TaskCompleted` | a task is marked completed | (none) |
| `TeammateIdle` | an agent-team teammate is about to go idle | (none) |

### Compaction
| Event | Fires when | Matchers |
|---|---|---|
| `PreCompact` | before context compaction | `manual`, `auto` |
| `PostCompact` | after compaction completes | `manual`, `auto` |

### Async / background
| Event | Fires when | Matchers |
|---|---|---|
| `CwdChanged` | working directory changes | (none) |
| `FileChanged` | a watched file changes on disk | literal filenames |
| `ConfigChange` | a config file changes mid-session | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` |
| `InstructionsLoaded` | CLAUDE.md / `.claude/rules/*.md` loaded into context | `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact` |
| `Notification` | Claude Code emits a notification | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response` |
| `MessageDisplay` | while assistant message text is displayed (display-only) | (none) |

### Worktree
| Event | Fires when | Matchers |
|---|---|---|
| `WorktreeCreate` | a worktree is created (`--worktree` / `isolation: "worktree"`) | (none) |
| `WorktreeRemove` | a worktree is removed | (none) |

### MCP elicitation
| Event | Fires when | Matchers |
|---|---|---|
| `Elicitation` | an MCP server requests user input during a tool call | MCP server name |
| `ElicitationResult` | after the user responds, before it is sent to the server | MCP server name |
