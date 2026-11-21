import { MANAGED_HANDOFF_FILE_ENV, type FlagSpec } from "@cotal-ai/core";
import { jsonFlag, plainFlag, credsFlag, launchFlags, serverFlag, spaceFlag } from "@cotal-ai/workspace";
import { onRerun } from "../lib/control.js";

/** `cotal spawn`'s grammar: the application in this terminal by default, a manager's launch only
 *  with `--detach` or `--on`, and one positional persona or explicit persona file. Declared `as const` so the values cast
 *  below is compile-checked against exactly these specs. Foreground and detached parse the SAME
 *  flags — the old `spawn` vs `start` ability drift is structurally gone. */
export const spawnFlags = [
  spaceFlag,
  serverFlag,
  { ...credsFlag, description: "control-caller creds for an off-registry manager (with --detach or --on)" },
  ...launchFlags,
  { name: "harness", short: "H", type: "string", value: "<connector>", description: "application connector; an explicit flag wins over persona and saved defaults" },
  { name: "foreground", type: "boolean", description: "run the application in this terminal, as a spawn without --detach or --on does; terminal exit may end it" },
  { name: "restarts", type: "string", value: "<n>", description: "with --detach or --on: maximum manager-supervised restarts in the selected restart window" },
  { name: "restart-window", type: "string", value: "<ms>", description: "time window for --restarts; both flags are required together" },
  jsonFlag, plainFlag,
  { name: "detach", type: "boolean", short: "d", description: "launch through a manager, await readiness and return without attaching" },
  { name: "live-only", type: "boolean", description: "foreground only: skip the durable backstop (no read-ACL row; messages missed while disconnected are not replayed)" },
  { name: "expires-in", type: "string", value: "<seconds>", description: "foreground only, static mesh: end this seat's credential after this many seconds; omitted, it has no expiry and ends when the seat leaves cleanly" },
  { name: "expires-at", type: "string", value: "<unix-seconds>", description: "foreground only, static mesh: end this seat's credential at this time; never with --expires-in" },
  { name: "file", type: "string", short: "f", value: "<persona-file>", description: "persona file on the execution host; never a manifest deploy or implicit upload" },
  { name: "dry-run", type: "boolean", description: "preview the launch without allocation, provisioning or starting an application" },
  { name: "enrollment-file", type: "string", value: "<private-file>", description: "foreground only: protected file holding this one seat's enrollment URL; never print or forward it" },
  { name: "allow-stale", type: "string", value: "<a,b>", description: "refused: a manifest deployment option; use `cotal team deploy <file>`" },
  { name: "runtime", type: "string", value: "<name>", description: "terminal runtime for this one managed seat; omitted, the serving manager uses its own" },
  { name: "on", type: "string", value: "<instance>", description: "launch through this manager instance, by the id `ps` prints, and attach; with --detach, return once it joins" },
  { name: "expect-owner", type: "string", value: "<u_…>", description: `with ${MANAGED_HANDOFF_FILE_ENV}: the owner the managed handoff must carry` },
  { name: "expect-lifecycle-uid", type: "string", value: "<uid>", description: `with ${MANAGED_HANDOFF_FILE_ENV}: the lifecycle UID the managed handoff must carry` },
] as const satisfies readonly FlagSpec[];

/** The spawn an `--on` refusal tells the caller to rerun: the persona and `-d` as given, with the
 *  `--space` or `--server` given (#7644). */
export const spawnRerun = (values: { detach?: unknown; space?: unknown; server?: unknown }, positionals: readonly string[]): string =>
  onRerun("cotal spawn", values, [...positionals, ...(values.detach === true ? ["-d"] : [])]);
