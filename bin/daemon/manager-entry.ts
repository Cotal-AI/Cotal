/** The stock foreground Manager, scoped to its machine daemon's sign-in and parent lifetime. */
import { registry, resolveAuthProvider, type Command } from "@cotal-ai/core";
import { IdpSessionRejectedError, withIdpSessionDir } from "@cotal-ai/auth";
import { CommandFailure, executionIdentity } from "@cotal-ai/workspace";
import { linuxSharedCustodyAvailable } from "@cotal-ai/seat";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { checkDir } from "./endpoint.js";
import { bindManagerCleanup } from "./manager-cleanup.js";
import { daemonCommandCopy } from "./guidance.js";

// Reports are observational. Teardown still obtains authority directly after its parent leaves.
function report(frame: object): void {
  if (!process.connected) return;
  process.send?.(frame, () => { /* A disconnect racing this report cannot fail shutdown. */ });
}

let parentGone = false;
let desktopInstall: string | undefined;
let completeInstall: (() => void) | undefined;
const receiveInstall = (raw: unknown) => {
  const frame = raw as { kind?: unknown; entry?: unknown } | undefined;
  if (frame?.kind !== "machine-pty-install" || typeof frame.entry !== "string" || !isAbsolute(frame.entry)) return;
  try {
    const entry = realpathSync.native(frame.entry);
    if (entry === join(dirname(dirname(entry)), "dist", "cotal.js") && existsSync(join(dirname(dirname(entry)), "desktop-runtime.json"))) desktopInstall = entry;
  } catch { /* No proved installation means no shared desktop launch. */ }
  completeInstall?.();
};
if (process.platform === "linux" && process.connected) process.on("message", receiveInstall);

async function sharedInstallEntry(): Promise<string | undefined> {
  try {
    const entry = executionIdentity()?.logicalEntry;
    if (!entry || !existsSync(join(dirname(dirname(entry)), "desktop-runtime.json"))) return entry;
    if (!desktopInstall && process.connected) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1_000);
      completeInstall = () => { clearTimeout(timer); resolve(); };
      report({ kind: "machine-pty-install-request" });
    });
    return desktopInstall;
  } catch { return undefined; }
  finally { completeInstall = undefined; process.off("message", receiveInstall); }
}
process.once("disconnect", () => {
  parentGone = true;
  if (process.listenerCount("SIGTERM") === 0) process.exit(0);
  process.emit("SIGTERM", "SIGTERM");
});

const stock = registry.resolve<Command>("command", "__daemon-manager");
const command: Command = {
  ...stock,
  name: "__machine-manager",
  flags: [...stock.flags ?? [], { name: "session-directory", type: "string", description: "the owning machine daemon's private sign-in directory" }, { name: "expected-connector-generation", type: "string", description: "the generation captured by the owning daemon" }],
  async run(args) {
    const home = args.values["session-directory"];
    if (typeof home !== "string" || !process.connected || parentGone) throw new CommandFailure("refused", "USAGE_INVALID", "the machine Manager requires its daemon's session directory and parent channel");
    checkDir(home);
    const expected = args.values["expected-connector-generation"];
    if (typeof expected !== "string" || !expected.trim()) throw new CommandFailure("refused", "USAGE_INVALID", "the machine Manager requires its daemon's captured connector generation");
    const provider = resolveAuthProvider();
    const authority = provider.managerServiceAuthority;
    if (!authority) throw new CommandFailure("refused", "UNSUPPORTED", "the auth provider does not support hosted Manager authority");
    provider.managerServiceAuthority = async (request) => {
      bindManagerCleanup(home, request.request.space, request.request.instanceId);
      report({ kind: "manager-instance", instanceId: request.request.instanceId });
      try { return await authority.call(provider, request); }
      catch (error) {
        const status = (error as { status?: unknown }).status;
        const message = error instanceof Error ? error.message : "Manager authority preparation failed";
        report({ kind: "manager-refusal", reason: message, terminal: error instanceof IdpSessionRejectedError || status === 400 || status === 401 || status === 403 || status === 404, status });
        throw error;
      }
    };
    const { "session-directory": _, ...values } = args.values;
    const linuxPty = process.platform === "linux" && (values.runtime === "pty" || values.runtime === "auto" || values.runtime === undefined);
    const sharedPty = linuxPty && linuxSharedCustodyAvailable();
    const install = sharedPty ? await sharedInstallEntry() : undefined;
    if (!sharedPty) process.off("message", receiveInstall);
    if (parentGone || !process.connected) throw new CommandFailure("refused", "USAGE_INVALID", "the machine Manager requires its daemon's session directory and parent channel");
    if (linuxPty && !sharedPty) process.stderr.write("Shared PTY custody is unavailable because the Linux user service manager or cgroup v2 is unavailable. Seats run inside the Manager and cannot survive a restart.\n");
    const machineSetup = typeof values.space === "string" ? daemonCommandCopy("setup", home, [["--space", values.space]]) : undefined;
    await withIdpSessionDir(home, () => stock.run({ ...args, values: { ...values, "machine-parent": true, "machine-setup-command": machineSetup, machineHostedPty: install, machineHostedPtyHome: install ? home : undefined } }));
  },
};
registry.register(command);
