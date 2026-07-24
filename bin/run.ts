/**
 * Composition root for the `cotal` operator CLI, published as `cotal-ai`. Importing an
 * implementation self-registers its commands into the shared registry — base mesh commands
 * plus `spawn`/`console` (@cotal-ai/cli) and the manager's control plane + daemon runners
 * (@cotal-ai/manager). The root just picks which surfaces to pull in; `runCli` resolves
 * whatever registered. A new surface (another connector, a control client …) is one more import line.
 *
 * Reached only via ./cotal.ts, which runs the Node-version preflight first: everything imported
 * here requires Node >= 22 (the UI stack and the bundled nats-server optional dep), so this module
 * must never be the executable entry — importing it on an old Node crashes at parse time.
 */
// NOTE: registration order across these imports is NOT guaranteed (tsx's entry interop can
// evaluate the smaller daemon graphs first) — display order is a non-goal here; `help` ranks
// its groups explicitly (GROUP_ORDER in @cotal-ai/cli).
import { runCli } from "@cotal-ai/cli"; // self-registers the base surface incl. spawn (foreground + --detach) / stop / ps / attach
import "@cotal-ai/manager"; // self-registers `supervise` — the agent-supervisor daemon
import "@cotal-ai/delivery"; // self-registers `deliver` — the server-side Plane-3 delivery daemon
import "@cotal-ai/auth"; // self-registers login / logout — per-user IdP sessions (device-code sign-in)
import { registry } from "@cotal-ai/core";

// A CLI must exit quietly when its stdout is closed early — piped to `head`, a pager that quits,
// or a shell's process substitution (`source <(cotal completion bash)`). Node otherwise turns the
// closed-pipe write into a fatal unhandled 'error' event with a stack trace. Mirror SIGPIPE: exit
// 0. Registered before any command can write.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

// The four agent connectors (claude/opencode/hermes/pi) are NOT imported here: they are removable,
// install-seeded `cotal ext` plugins loaded through the manifest, exactly like a third-party
// connector (and like the `@cotal-ai/orca` runtime already is). `runCli` seeds them on first run and
// materializes each lazily when a command resolves it; the default agent is `COTAL_DEFAULT_AGENT`
// (else claude), resolved manager-side. The old `"cotal"` default-agent alias is gone with them.
//
// Bare `cotal` prints help; explicit `cotal setup` runs guided setup. The published binary is
// the ONE composition root that loads operator-installed extensions (`cotal ext add …`) — commands,
// runtimes, connectors, and local process components all self-register from those packages. Library
// roots keep the explicit-import model.
const argv = process.argv.slice(2);
await runCli(registry, argv, { extensions: true });
