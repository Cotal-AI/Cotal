/** The stock foreground Manager, scoped to its machine daemon's sign-in and parent lifetime. */
import { registry, resolveAuthProvider, type Command } from "@cotal-ai/core";
import { IdpSessionRejectedError, withIdpSessionDir } from "@cotal-ai/auth";
import { CommandFailure } from "@cotal-ai/workspace";
import { checkDir } from "./endpoint.js";
import { bindManagerCleanup } from "./manager-cleanup.js";
import { daemonCommandCopy } from "./guidance.js";
import { managerStartupCode } from "./manager-start-failure.js";

// Reports are observational. Teardown still obtains authority directly after its parent leaves.
function report(frame: object): void {
  if (!process.connected) return;
  process.send?.(frame, () => { /* A disconnect racing this report cannot fail shutdown. */ });
}

let parentGone = false;
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
    try { checkDir(home); }
    catch (error) { report({ kind: "manager-start-failure", code: managerStartupCode(error) }); throw error; }
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
        const rejected = error instanceof IdpSessionRejectedError;
        const code = rejected || status === 401 ? "sign-in-required" : status === 403 ? "permission-denied" : managerStartupCode(error);
        report({ kind: "manager-refusal", reason: message, terminal: rejected || status === 400 || status === 401 || status === 403 || status === 404, status, code });
        throw error;
      }
    };
    const { "session-directory": _, ...values } = args.values;
    const machineSetup = typeof values.space === "string" ? daemonCommandCopy("setup", home, [["--space", values.space]]) : undefined;
    await withIdpSessionDir(home, () => stock.run({ ...args, values: { ...values, "machine-parent": true, "machine-setup-command": machineSetup } }));
  },
};
registry.register(command);
