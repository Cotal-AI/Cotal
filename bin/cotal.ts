#!/usr/bin/env node
/**
 * Composition root for the `cotal` operator CLI, published as `cotal-ai`. Importing an
 * implementation self-registers its commands into the shared registry — base mesh commands
 * plus `spawn`/`console` (@cotal-ai/cli) and the manager's control plane + daemon runners
 * (@cotal-ai/manager). The root just picks which surfaces to pull in; `runCli` resolves
 * whatever registered. A new surface (another connector, a control client …) is one more import line.
 */
import { runCli } from "@cotal-ai/cli"; // self-registers the base surface incl. spawn (foreground + --detach) / stop / ps / attach
import "@cotal-ai/manager"; // self-registers `supervise` — the agent-supervisor daemon
import "@cotal-ai/delivery"; // self-registers `deliver` — the server-side Plane-3 delivery daemon
import "@cotal-ai/connector-claude-code"; // registers the `claude` connector that spawn resolves
import "@cotal-ai/connector-opencode"; // registers the `opencode` connector (native in-process plugin)
import "@cotal-ai/connector-hermes"; // registers the `hermes` connector (Nous Research gateway as a mesh peer)
import "@cotal-ai/cmux"; // opt into the cmux integration — registers the `cmux` runtime + TerminalLayout providers
import "@cotal-ai/tmux"; // opt into the tmux integration — registers the `tmux` runtime + TerminalLayout providers
import { claudeConnector } from "@cotal-ai/connector-claude-code";
import { registry } from "@cotal-ai/core";

// A CLI must exit quietly when its stdout is closed early — piped to `head`, a pager that quits,
// or a shell's process substitution (`source <(cotal completion bash)`). Node otherwise turns the
// closed-pipe write into a fatal unhandled 'error' event with a stack trace. Mirror SIGPIPE: exit
// 0. Registered before any command can write.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

// The manager's default agent type is "cotal" (StartAgentOpts.agent ?? "cotal"); make it a real
// Claude coder so a bare cotal_spawn / `cotal spawn --detach <persona>` (no --agent) brings up a
// Claude Code session. Revisited at the start→spawn merge (stage 2a): still needed — the default
// rides the MANAGER side of the control plane, not the removed CLI verb.
registry.register({ ...claudeConnector, name: "cotal" });

// Bare `cotal` prints help; explicit `cotal setup` runs guided setup.
const argv = process.argv.slice(2);
await runCli(registry, argv);
