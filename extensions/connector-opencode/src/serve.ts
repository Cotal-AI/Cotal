/** The launcher shim (esbuild → `dist/serve.js`): the agent's seat (see launch.ts) with the `opencode`
 *  TUI attached. 1.x `attach --password` defaults to the OPENCODE_SERVER_PASSWORD in the TUI's env;
 *  2.x has no `attach` subcommand. */
import { BIN, launch } from "./launch.js";

// A launch the launcher refuses ends in its one-line reason, not the bundle's source and a stack trace.
launch(({ url, session, line }) =>
  line === 2 ? [BIN, "--server", url, "--session", session] : [BIN, "attach", url, "--session", session]).catch((error: unknown) => {
  process.stderr.write(`[cotal-connector] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
