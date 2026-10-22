# @cotal-ai/connector-claude-code

The Claude Code adapter: a bundled, installed plugin plus `claude/channel` push that turns a
real `claude` session into a Cotal mesh peer. A thin client over
[`@cotal-ai/connector-core`](../connector-core).

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/connect-claude.md](../../docs/connect-claude.md) for the integration guide, and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

## Claude Code hooks

Claude Code documents every hook event and its matchers in its
[hooks reference](https://code.claude.com/docs/en/hooks). This README does not copy that list.

The plugin registers the nine hooks below in [`hooks/hooks.json`](hooks/hooks.json). Each runs
`dist/hook.cjs`, which relays the event to the session's connector over its authenticated control
socket. A Cotal session, one that Cotal launched, carries a mesh identity in its environment. A
plain session, such as a `claude` you started yourself, carries none until it connects. Its command
hooks capture session and transcript metadata, then relay lifecycle events to the personal gateway
after the native module binds that session. This does not intercept the `classic.*` events that
Claude's built-in security guard withholds from user plugins. The command hook still enforces the
hosted connection checks in the `PreToolUse` and `PostToolUse` rows. The presence states are described in
[presence mapping](../../docs/connect-claude.md#presence-mapping).

| Hook | Matcher | What the plugin does |
|---|---|---|
| `SessionStart` | all | Surfaces the channel briefing and waiting messages, sets `idle` when no turn is open, resets attention to `open`, and records the session's model when none is pinned. On `startup`, `resume` or `fork` it also records the session's directory. |
| `UserPromptSubmit` | all | Sets `working` and surfaces waiting messages and run turns. |
| `PreToolUse` | all | Records the pending tool so a permission wait can name it. In a Cotal session, it denies a Cotal tool from any server other than the local one. In a plain session, it denies a hosted `connection_id` that it recorded as opened by a different session. |
| `PostToolUse` | `^mcp__.+__cotal_(connect\|disconnect)$` | Plain sessions only: records or forgets which session opened a hosted connection. |
| `PostToolBatch` | all | Sets `working` again when the main agent's batch resolves after a prompt left the seat `waiting`. A subagent's batch changes nothing. |
| `Notification` | `permission_prompt\|agent_needs_input\|elicitation_dialog` | Sets `waiting`. `permission_prompt` adds condition `approval`, and `agent_needs_input` adds `input`. |
| `Stop` | all | Ends the turn: closes the run on the event plane, sets `idle`, and asks for a wake turn when held messages are waiting. |
| `StopFailure` | all | Same as `Stop`, but closes the run with `RUN_ERROR` and sets a condition mapped from the error type. |
| `SessionEnd` | all | Sets `offline`. |
