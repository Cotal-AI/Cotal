/** The stock foreground Manager, scoped to its machine daemon's sign-in and parent lifetime. */
import { registry, resolveAuthProvider, type Command } from "@cotal-ai/core";
import { withIdpSessionDir } from "@cotal-ai/auth";
import { CommandFailure } from "@cotal-ai/workspace";
import { checkDir } from "./endpoint.js";

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
  flags: [...stock.flags ?? [], { name: "session-directory", type: "string", description: "the owning machine daemon's private sign-in directory" }],
  async run(args) {
    const home = args.values["session-directory"];
    if (typeof home !== "string" || !process.connected || parentGone) throw new CommandFailure("refused", "USAGE_INVALID", "the machine Manager requires its daemon's session directory and parent channel");
    checkDir(home);
    const provider = resolveAuthProvider();
    const authority = provider.managerServiceAuthority;
    if (!authority) throw new CommandFailure("refused", "UNSUPPORTED", "the auth provider does not support hosted Manager authority");
    provider.managerServiceAuthority = async (request) => {
      process.send?.({ kind: "manager-instance", instanceId: request.request.instanceId });
      try { return await authority.call(provider, request); }
      catch (error) {
        const status = (error as { status?: unknown }).status;
        const message = error instanceof Error ? error.message : "Manager authority preparation failed";
        process.send?.({ kind: "manager-refusal", reason: message, terminal: status === 400 || status === 401 || status === 403 || status === 404 || /signed.out|cached session|no cached login/.test(message) });
        throw error;
      }
    };
    const { "session-directory": _, ...values } = args.values;
    await withIdpSessionDir(home, () => stock.run({ ...args, values }));
  },
};
registry.register(command);
