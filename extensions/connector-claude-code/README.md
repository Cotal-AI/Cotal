# @cotal-ai/connector-claude-code

The Claude Code adapter: a bundled, installed plugin plus `claude/channel` push that turns a
real `claude` session into a Cotal mesh peer. A thin client over
[`@cotal-ai/connector-core`](../connector-core).

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/connect-claude.md](../../docs/connect-claude.md) for the integration guide, and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

## Claude Code hook reference

The full set of Claude Code hook events, grouped by lifecycle — this is Claude *product*
surface, kept here with the adapter rather than in the protocol docs. Source:
[code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) (Claude Code
2.1.16x, 31 events; the `StopFailure` matchers re-read off 2.1.237's own hook schema, which
carries two the earlier list was missing). The connector consumes the subset mapped in
[docs/connect-claude.md](../../docs/connect-claude.md) (presence mapping + message
delivery); the rest are listed for completeness.

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
| `StopFailure` | turn ends due to an API error | `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown` |

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
