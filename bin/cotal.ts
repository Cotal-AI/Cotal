#!/usr/bin/env node
/**
 * Composition root for the `cotal` operator CLI, published as `cotal-ai`. Importing an
 * implementation self-registers its commands into the shared registry — base mesh commands
 * plus `spawn`/`console` (@cotal-ai/cli) and the manager's control plane + daemon runners
 * (@cotal-ai/manager). The root just picks which surfaces to pull in; `runCli` resolves
 * whatever registered. A new surface (another connector, a control client …) is one more import line.
 */
// NOTE: registration order across these imports is NOT guaranteed (tsx's entry interop can
// evaluate the smaller daemon graphs first) — display order is a non-goal here; `help` ranks
// its groups explicitly (GROUP_ORDER in @cotal-ai/cli).
import { runCli } from "@cotal-ai/cli"; // self-registers the base surface incl. spawn (foreground + --detach) / stop / ps / attach
import "@cotal-ai/manager"; // self-registers `supervise` — the agent-supervisor daemon
import "@cotal-ai/delivery"; // self-registers `deliver` — the server-side Plane-3 delivery daemon
import "@cotal-ai/auth"; // self-registers login / logout — per-user IdP sessions (device-code sign-in)
import "@cotal-ai/connector-claude-code"; // registers the `claude` connector that spawn / start resolve
import "@cotal-ai/connector-opencode"; // registers the `opencode` connector (native in-process plugin)
import "@cotal-ai/connector-hermes"; // registers the `hermes` connector (Nous Research gateway as a mesh peer)
import "@cotal-ai/pi"; // registers the `pi` connector (mesh extension loaded into the user's own pi)
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

// The manager's built-in default agent type is "cotal" (when COTAL_DEFAULT_AGENT is unset); make it
// a real Claude coder so a bare cotal_spawn / `cotal spawn --detach <persona>` (no --agent) brings
// up a Claude Code session. Revisited at the start→spawn merge (stage 2a): still needed — the
// default rides the MANAGER side of the control plane, not the removed CLI verb.
registry.register({ ...claudeConnector, name: "cotal" });

// Bare `cotal` prints help; explicit `cotal setup` runs guided setup. The published binary is
// the ONE composition root that loads operator-installed extensions (`cotal ext add …`) — commands,
// runtimes, and local process components all self-register from those packages. Library roots keep
// the explicit-import model.
const argv = process.argv.slice(2);
await runCli(registry, argv, { extensions: true });
