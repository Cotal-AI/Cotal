/**
 * Composition root for the `cotal` operator CLI, published as `cotal-ai`. Importing an
 * implementation self-registers its commands into the shared registry — base mesh commands
 * plus `spawn`/`console` (@cotal-ai/cli) and the manager's control plane + daemon runners
 * (@cotal-ai/manager). The root just picks which surfaces to pull in; `runCli` resolves
 * whatever registered. A new surface (another connector, a control client …) is one more import line.
 *
 * A daemon entry is the exception: it runs one command for the life of its process, so it imports
 * only the surfaces that command needs (see the providers below), never the whole CLI.
 *
 * Reached only via ./cotal.ts, which runs the Node-version preflight first: everything imported
 * here requires Node >= 22 (the UI stack and the bundled nats-server optional dep), so this module
 * must never be the executable entry — importing it on an old Node crashes at parse time.
 */
import { registry, type ExtensionRef } from "@cotal-ai/core";
import { handOverStartupInterrupt, releaseStartupInterrupt } from "./startup-interrupt.js";

// Each surface self-registers when imported. The whole CLI imports them one after another in this
// order, which is the order the root's static imports evaluated them in; display order is still a
// non-goal, since `help` ranks its groups explicitly (GROUP_ORDER in @cotal-ai/cli).
const surfaces = {
  cli: () => import("@cotal-ai/cli"), // the base surface incl. spawn (foreground + --detach) / stop / ps / attach
  manager: () => import("@cotal-ai/manager"), // `supervise` — the agent-supervisor daemon
  delivery: () => import("@cotal-ai/delivery"), // `deliver` — the server-side Plane-3 delivery daemon
  runtime: () => import("@cotal-ai/runtime"), // `run` — the workflow-run operator surface (start/resume/ps/journal/answer)
  auth: () => import("@cotal-ai/auth"), // login / logout — per-user IdP sessions (device-code sign-in)
  docs: () => import("./docs.js"), // `docs`; the docs bundle loads only when `docs` runs
  daemon: () => import("./daemon/command.js"), // `daemon`: the local machine daemon's authenticated control endpoint (Linux)
  // The `ag-ui.frame` part renderer, so `cotal console` and `cotal join` draw an event frame instead
  // of `[unrenderable part kind "ag-ui.frame"]`.
  //
  // IMPORTED HERE BECAUSE NOTHING ELSE IN THIS PROCESS WOULD. The four agent connectors are removable
  // ext plugins materialized lazily by `runCli`, and no `implementations/*` package imports
  // connector-core at runtime — measured, not assumed. So a renderer that only registered inside the
  // connector would be absent from every process that RENDERS, which is the one place it is needed.
  // The seam is worth nothing if the provider never loads at the display site.
  //
  // The narrow subpath rather than the package root, deliberately: the root pulls the MCP server
  // runtime and its zod copy into CLI startup, and a renderer needs none of it.
  aguiRender: () => import("@cotal-ai/connector-core/agui-render"),
};
type Surface = keyof typeof surfaces;
const importing = (...names: Surface[]) => async () => { for (const name of names) await surfaces[name](); };
const commands = (...names: string[]): ExtensionRef[] => names.map((name) => ({ kind: "command", name }));

// The daemon entries. Each imports its own surface and the surfaces whose registrations its run
// resolves: the auth provider a user-auth mesh dials through (@cotal-ai/auth), and the workflow run
// host a manager hosts runs with (@cotal-ai/runtime). Nothing else in the CLI is imported, and the
// command's flags, refusals and exit are `runCli`'s as for any other command.
registry.provide({ provides: commands("supervise", "__daemon-manager", "__service-manager"), load: importing("manager", "auth", "runtime") });
registry.provide({ provides: commands("deliver", "__daemon-deliver", "__service-delivery", "feedback-intake", "__service-feedback-intake"), load: importing("delivery", "auth") });
registry.provide({ provides: commands("auth-service", "__daemon-auth-service", "__service-auth"), load: importing("auth") });
registry.provide({ provides: commands("__service-unit"), load: () => import("@cotal-ai/cli/service-unit") });

// The dispatch module reads the command word as `runCli` will, and loads no command. A word a
// provider declares imports that provider's surfaces; any other word imports them all.
const { commandWord, runCli, stdoutError } = await import("@cotal-ai/cli/dispatch");
const argv = process.argv.slice(2);
const word = commandWord(argv);
if (word !== undefined && registry.provides("command", word)) await registry.load("command", word);
else await importing(...(Object.keys(surfaces) as Surface[]))();

// A CLI must exit quietly when its stdout is closed early — piped to `head`, a pager that quits,
// or a shell's process substitution (`source <(cotal completion script bash)`). Node otherwise turns the
// closed-pipe write into a fatal unhandled 'error' event with a stack trace. Mirror SIGPIPE: exit
// 0. A command that must close something first, such as a chat session, owns stdout's errors while
// it runs, and this listener stands down for it. Registered before any command can write.
process.stdout.on("error", stdoutError);

// The four agent connectors (claude/opencode/hermes/pi) are NOT imported here: they are removable,
// install-seeded `cotal ext` plugins loaded through the manifest, exactly like a third-party
// connector (and like the `@cotal-ai/orca` runtime already is). `runCli` seeds them on first run and
// materializes each lazily when a command resolves it; the default agent is `COTAL_DEFAULT_AGENT`
// (else claude), resolved manager-side. The old `"cotal"` default-agent alias is gone with them.
//
// Bare `cotal` prints the entry screen; explicit `cotal setup` runs guided setup. The published binary is
// the ONE composition root that loads operator-installed extensions (`cotal ext add …`) — commands,
// runtimes, connectors, and local process components all self-register from those packages. Library
// roots keep the explicit-import model.
await runCli(registry, argv, { extensions: true, startupNotice: { release: releaseStartupInterrupt, handOver: handOverStartupInterrupt } });
