/** The launcher shim (esbuild → `dist/serve.js`): the agent's seat (see launch.ts) with the `opencode`
 *  TUI attached. 1.x `attach --password` defaults to the OPENCODE_SERVER_PASSWORD in the TUI's env;
 *  2.x has no `attach` subcommand. */
import { BIN, launch } from "./launch.js";

void launch(({ url, session, line }) =>
  line === 2 ? [BIN, "--server", url, "--session", session] : [BIN, "attach", url, "--session", session]);
